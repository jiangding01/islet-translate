import { type AppError, appError, isAppError } from '@/lib/errors';
import { badResponseError, emptyTranslationError } from './providers/errors';
import type { BuiltPrompt } from './types';

// LLM batch protocol: input and output are JSON arrays of { i, t }, matched by `i`.

/** Placeholder in BuiltPrompt.user that is replaced by the encoded batch. */
export const USER_INPUT_TOKEN = '<<INPUT>>';

export function encodeBatch(texts: readonly string[]): string {
  return JSON.stringify(texts.map((t, i) => ({ i, t })));
}

export function renderUserMessage(template: string, texts: readonly string[]): string {
  return template.split(USER_INPUT_TOKEN).join(encodeBatch(texts));
}

// ------------------------------------------------------------ text format

/** Placeholder in a `text` prompt's system and user templates, replaced by a fresh nonce. */
export const NONCE_TOKEN = '<<NONCE>>';

/** 16 hex characters from the platform CSPRNG. */
export function createNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Renders a `text` prompt for one request. The nonce is drawn per call, so the
 * source cannot forge the closing marker; it is redrawn in the (astronomically
 * unlikely) case that the source contains it. The text is inserted last and
 * never substituted into.
 */
export function renderTextPrompt(
  prompt: BuiltPrompt,
  text: string,
  nonce: () => string = createNonce,
): { system: string; user: string } {
  let value = nonce();
  while (text.includes(value)) value = nonce();
  const fill = (template: string) => template.split(NONCE_TOKEN).join(value);
  return {
    system: fill(prompt.system),
    user: fill(prompt.user).split(USER_INPUT_TOKEN).join(text),
  };
}

/**
 * System and user messages for one provider request. `text` prompts take exactly
 * one item (`internal/text-batch` otherwise) and get a fresh nonce on every call.
 */
export function renderMessages(
  prompt: BuiltPrompt,
  texts: readonly string[],
): { system: string; user: string } {
  if (prompt.format === 'batch') {
    return { system: prompt.system, user: renderUserMessage(prompt.user, texts) };
  }
  const [text] = texts;
  if (text === undefined || texts.length !== 1) {
    throw appError('internal', 'internal/text-batch', 'A text prompt takes exactly one item');
  }
  return renderTextPrompt(prompt, text);
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Stream filter that holds back a leading `<think>…</think>` block (reasoning
 * models served through OpenAI-compatible APIs), so it is neither shown as a
 * translation increment nor counted against the stream output cap. Text after
 * the block, or text that does not start with one, passes through unchanged.
 */
export function createThinkFilter(): (chunk: string) => string {
  let state: 'start' | 'thinking' | 'after' | 'text' = 'start';
  let held = '';
  return (chunk) => {
    if (state === 'text') return chunk;
    held += chunk;
    if (state === 'start') {
      const head = held.trimStart().toLowerCase();
      if (head.length < THINK_OPEN.length && THINK_OPEN.startsWith(head)) return '';
      if (!head.startsWith(THINK_OPEN)) {
        state = 'text';
        const out = held;
        held = '';
        return out;
      }
      state = 'thinking';
    }
    if (state === 'thinking') {
      const end = held.toLowerCase().indexOf(THINK_CLOSE);
      if (end === -1) {
        // Keep just enough to find a closing tag split across chunks.
        held = held.slice(-(THINK_CLOSE.length - 1));
        return '';
      }
      held = held.slice(end + THINK_CLOSE.length);
      state = 'after';
    }
    // Whitespace between the block and the translation is not part of it.
    const out = held.trimStart();
    held = '';
    if (out !== '') state = 'text';
    return out;
  };
}

/** Wrapping quote pairs a model adds around a whole reply. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'], // i18n-ignore: punctuation the codec matches
  ['『', '』'], // i18n-ignore: punctuation the codec matches
  ['«', '»'],
  ['„', '“'],
];

/** The pair wrapping all of `text`, when its inside contains neither quote character. */
function wrappingPair(text: string): readonly [string, string] | undefined {
  return QUOTE_PAIRS.find(([open, close]) => {
    if (text.length < open.length + close.length + 1) return false;
    if (!text.startsWith(open) || !text.endsWith(close)) return false;
    const inner = text.slice(open.length, text.length - close.length);
    return !inner.includes(open) && !inner.includes(close);
  });
}

const LABEL = /^(?:译文|譯文|翻译|翻譯|翻訳|訳文|번역|translation|translated text)\s*[:：]\s*/i;

/** A short "word or phrase + colon" lead-in, in any language ("Übersetzung: Haus"). */
const SOURCE_LABEL = /^[\p{L}\p{N}][^\n:：]{0,39}[:：]/u;

/** Punctuation pairs that may wrap a whole source text, on top of the quote pairs. */
const BRACKET_PAIRS: readonly (readonly [string, string])[] = [
  ['《', '》'], // i18n-ignore: punctuation the codec matches
  ['〈', '〉'], // i18n-ignore: punctuation the codec matches
  ['(', ')'],
  ['（', '）'], // i18n-ignore: punctuation the codec matches
  ['【', '】'], // i18n-ignore: punctuation the codec matches
  ['[', ']'],
  ['〔', '〕'], // i18n-ignore: punctuation the codec matches
  ['｢', '｣'], // i18n-ignore: punctuation the codec matches
];

/** `true` when `text` starts and ends with the two halves of one pair. */
function isWrapped(text: string): boolean {
  return [...QUOTE_PAIRS, ...BRACKET_PAIRS].some(
    ([open, close]) =>
      text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close),
  );
}

/**
 * Cleans a `text` reply before it is used or cached:
 * - drops everything up to the last `</think>` (reasoning, with or without its
 *   opening tag, may itself mention the closing tag);
 * - drops `<think>…</think>` blocks (an unclosed one runs to the end);
 * - drops a leading label such as "译文：" or "Translation:";
 * - drops one pair of quotes around the whole reply.
 * Each rule is skipped when the source itself has that feature (it is then part
 * of the translation). Throws `validation/empty-translation` when nothing is left.
 */
export function cleanTextOutput(output: string, source: string): string {
  const original = source.trim();
  let text = output;
  // Split, not toLowerCase + lastIndexOf: lowercasing can change the length ("İ").
  if (!original.toLowerCase().includes(THINK_CLOSE)) text = text.split(/<\/think>/i).at(-1) ?? '';
  if (!original.toLowerCase().includes(THINK_OPEN)) {
    text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  }
  text = text.trim();
  if (!SOURCE_LABEL.test(original)) text = text.replace(LABEL, '').trim();
  const pair = wrappingPair(text);
  if (pair && !isWrapped(original)) {
    text = text.slice(pair[0].length, text.length - pair[1].length).trim();
  }
  if (text === '') throw emptyTranslationError();
  return text;
}

// ------------------------------------------------------------ batch format

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the array out of the model output. The whole output is tried first, so
 * a translation that itself contains a fence or think tag still parses. Then,
 * when there is a `</think>`, the text after the first one: reasoning inlined
 * ahead of the answer, with or without its opening tag, may quote the input
 * array. Last, the whole output again, tolerating fences and prose.
 */
function extractArray(raw: string): unknown[] | undefined {
  const tail = /<\/think>([\s\S]*)/i.exec(raw)?.[1];
  return (
    parseArray(raw.trim()) ??
    (tail === undefined ? undefined : extractLoose(tail)) ??
    extractLoose(raw)
  );
}

/** Tolerates Markdown fences and prose around the array. */
function extractLoose(raw: string): unknown[] | undefined {
  const direct = parseArray(raw.trim());
  if (direct) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const inFence = fenced === undefined ? undefined : parseArray(fenced.trim());
  if (inFence) return inFence;
  for (const candidate of [fenced, raw]) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start !== -1 && end > start) {
      const sliced = parseArray(candidate.slice(start, end + 1));
      if (sliced) return sliced;
    }
  }
  return undefined;
}

/**
 * Parses model output into translations ordered by input position. Order in the
 * output does not matter; ids must be exactly 0..count-1, unique, with non-empty text.
 * Throws `validation/bad-response`.
 */
export function decodeLlmOutput(raw: string, count: number): string[] {
  const entries = extractArray(raw);
  if (!entries) throw badResponseError('Output is not a JSON array');
  if (entries.length !== count) throw badResponseError('Item count mismatch');
  const result: (string | undefined)[] = new Array(count).fill(undefined);
  for (const entry of entries) {
    if (!isRecord(entry)) throw badResponseError('Malformed item');
    const { i, t } = entry;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count) {
      throw badResponseError('Item id out of range');
    }
    if (result[i] !== undefined) throw badResponseError('Duplicate item id');
    if (typeof t !== 'string' || t.trim() === '') throw badResponseError('Empty translation');
    result[i] = t;
  }
  return result as string[];
}

/** Greedy grouping by item and character limits; returns index groups in order. */
export function chunkByLimits(
  texts: readonly string[],
  limits: { maxItems: number; maxChars: number },
): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  texts.forEach((text, index) => {
    const length = text.length;
    if (
      current.length > 0 &&
      (current.length >= limits.maxItems || chars + length > limits.maxChars)
    ) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += length;
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

export function splitInHalf<T>(items: readonly T[]): [T[], T[]] | undefined {
  if (items.length < 2) return undefined;
  const middle = Math.ceil(items.length / 2);
  return [items.slice(0, middle), items.slice(middle)];
}

export type ItemOutcome = { ok: true; text: string } | { ok: false; error: AppError };

const SPLITTABLE: ReadonlySet<string> = new Set([
  'validation/bad-response',
  'provider/output-truncated',
  'provider/content-blocked',
]);

/**
 * Errors worth halving the batch for: a malformed answer, an output cut at the
 * token limit (a smaller batch may fit) and a safety block (isolates the item).
 */
export function isSplittableError(error: AppError): boolean {
  return SPLITTABLE.has(error.code);
}

/**
 * Runs `run` on the batch; on a splittable error (see isSplittableError) halves
 * the batch and retries each half down to single items, which end with the real
 * error. Other errors apply to every item in the batch. Pure helper: callers route `run` through the scheduler.
 */
export async function settleWithSplit<T>(
  items: readonly T[],
  run: (items: readonly T[]) => Promise<string[]>,
): Promise<ItemOutcome[]> {
  try {
    const texts = await run(items);
    if (texts.length !== items.length) throw badResponseError('Item count mismatch');
    return texts.map((text) => ({ ok: true, text }));
  } catch (error) {
    const appErr = isAppError(error) ? error : badResponseError();
    const halves = isSplittableError(appErr) ? splitInHalf(items) : undefined;
    if (!halves) return items.map(() => ({ ok: false, error: appErr }));
    const left = await settleWithSplit(halves[0], run);
    const right = await settleWithSplit(halves[1], run);
    return [...left, ...right];
  }
}
