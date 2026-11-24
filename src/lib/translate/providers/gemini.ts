import { appError } from '@/lib/errors';
import {
  cleanTextOutput,
  createBatchScanner,
  createThinkFilter,
  finishBatch,
  renderMessages,
} from '../codec';
import { readSse } from '../sse';
import type { ProviderAdapter, ProviderContext, ProviderEvent } from '../types';
import {
  badResponseError,
  contentBlockedError,
  errorFromResponse,
  MAX_LLM_OUTPUT_CHARS,
  modelRequiredError,
  outputTruncatedError,
  safeFetch,
} from './errors';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const LIMITS = { maxItems: 20, maxChars: 3000 };

interface GeminiChunk {
  error?: unknown;
  promptFeedback?: { blockReason?: unknown };
  candidates?: {
    content?: { parts?: { text?: unknown; thought?: unknown }[] };
    finishReason?: unknown;
  }[];
}

/** finishReason values that mean the safety system stopped the output. */
const BLOCKED_FINISH_REASONS: ReadonlySet<unknown> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

async function* translate(batch: string[], ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
  const { prompt, settings } = ctx;
  if (!prompt) throw appError('internal', 'internal/missing-prompt', 'LLM adapters need a prompt');
  const model = settings.model.trim().replace(/^models\//, '');
  if (!model) throw modelRequiredError();
  const messages = renderMessages(prompt, batch);
  const streaming = prompt.format === 'text';
  const visible = createThinkFilter();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers['x-goog-api-key'] = ctx.apiKey;
  const response = await safeFetch(
    ctx,
    `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: messages.system }] },
        contents: [{ role: 'user', parts: [{ text: messages.user }] }],
      }),
    },
  );
  if (!response.ok) throw await errorFromResponse(response);

  // The stream has no terminator: it simply ends. A broken connection throws in readSse.
  // Page batches: items are yielded as soon as the scanner commits them.
  const scanner = streaming ? undefined : createBatchScanner(batch);
  let text = '';
  try {
    for await (const data of readSse(response, { signal: ctx.signal, idleMs: ctx.idleTimeoutMs })) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data) as GeminiChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw appError('provider', 'provider/server-error', 'Provider reported a stream error', {
          retryable: true,
        });
      }
      if (chunk.promptFeedback?.blockReason) throw contentBlockedError();
      const candidate = chunk.candidates?.[0];
      let content = '';
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.thought !== true) content += part.text;
      }
      text += content;
      const items = scanner?.push(content) ?? [];
      if (BLOCKED_FINISH_REASONS.has(candidate?.finishReason)) throw contentBlockedError();
      if (candidate?.finishReason === 'MAX_TOKENS') throw outputTruncatedError();
      if (text.length > MAX_LLM_OUTPUT_CHARS) throw outputTruncatedError();
      for (const item of items) yield { type: 'item', ...item };
      const shown = streaming && content !== '' ? visible(content) : '';
      if (shown !== '') yield { type: 'delta', index: 0, delta: shown };
    }
  } catch (error) {
    // Items may have come from a draft: nothing of this attempt may be cached.
    throw scanner?.state === 'tainted' ? badResponseError('Draft output') : error;
  }

  if (!scanner) {
    yield { type: 'item', index: 0, text: cleanTextOutput(text, batch[0] ?? '') };
    return;
  }
  yield* finishBatch(scanner, text, batch.length);
}

export function createGeminiAdapter(): ProviderAdapter {
  return { kind: 'llm', limits: LIMITS, translate };
}
