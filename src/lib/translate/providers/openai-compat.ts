import { isLocalEndpoint } from '@/lib/endpoint';
import { appError } from '@/lib/errors';
import {
  cleanTextOutput,
  createBatchScanner,
  createThinkFilter,
  doubtful,
  finishBatch,
  renderMessages,
} from '../codec';
import { readSse } from '../sse';
import type { ProviderAdapter, ProviderContext, ProviderEvent } from '../types';
import {
  badResponseError,
  contentBlockedError,
  errorFromResponse,
  interruptedError,
  MAX_LLM_OUTPUT_CHARS,
  modelRequiredError,
  outputTruncatedError,
  safeFetch,
} from './errors';

const LIMITS = { maxItems: 20, maxChars: 3000 };

interface StreamChunk {
  error?: unknown;
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
}

async function* translate(batch: string[], ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
  const { prompt, settings } = ctx;
  if (!prompt) throw appError('internal', 'internal/missing-prompt', 'LLM adapters need a prompt');
  if (!settings.model.trim()) throw modelRequiredError();
  const messages = renderMessages(prompt, batch);
  const streaming = prompt.format === 'text';
  const visible = createThinkFilter();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  const response = await safeFetch(ctx, `${settings.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...settings.extraBody,
      model: settings.model,
      stream: true,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
    }),
  });
  if (!response.ok) {
    // Local servers (Ollama) answer 403 to an extension origin they do not allow;
    // that is a setup step, not a bad key.
    if (response.status === 403 && isLocalEndpoint(settings.baseURL)) {
      throw appError('provider', 'provider/local-origin-rejected', 'HTTP 403 from a local server');
    }
    throw await errorFromResponse(response);
  }

  // Page batches: items are yielded as soon as the scanner commits them.
  const scanner = streaming ? undefined : createBatchScanner(batch);
  let text = '';
  let finished = false;
  try {
    for await (const data of readSse(response, { signal: ctx.signal, idleMs: ctx.idleTimeoutMs })) {
      if (data === '[DONE]') {
        finished = true;
        break;
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw appError('provider', 'provider/server-error', 'Provider reported a stream error', {
          retryable: true,
        });
      }
      const choice = chunk.choices?.[0];
      const content = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
      text += content;
      const items = scanner?.push(content) ?? [];
      if (text.length > MAX_LLM_OUTPUT_CHARS) throw outputTruncatedError();
      if (choice?.finish_reason === 'length') throw outputTruncatedError();
      if (choice?.finish_reason === 'content_filter') throw contentBlockedError();
      if (choice?.finish_reason) finished = true;
      for (const item of items) yield { type: 'item', ...item };
      const shown = streaming && content !== '' ? visible(content) : '';
      if (shown !== '') yield { type: 'delta', index: 0, delta: shown };
    }
    if (!finished) throw interruptedError();
  } catch (error) {
    // Items may have come from a draft, or be misplaced (length check): nothing of this
    // attempt may be cached, and what it delivered is revoked.
    throw doubtful(scanner) ? badResponseError('Doubtful output') : error;
  }

  if (!scanner) {
    yield { type: 'item', index: 0, text: cleanTextOutput(text, batch[0] ?? '') };
    return;
  }
  yield* finishBatch(scanner, text, batch.length);
}

export function createOpenAICompatAdapter(): ProviderAdapter {
  return { kind: 'llm', limits: LIMITS, translate };
}
