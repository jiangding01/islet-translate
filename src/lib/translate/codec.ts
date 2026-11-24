import { type AppError, appError, isAppError } from '@/lib/errors';
import { badResponseError, emptyTranslationError, outputTruncatedError } from './providers/errors';
import type { BuiltPrompt, ProviderEvent } from './types';

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

// ------------------------------------------------------------ incremental batch

export interface BatchScanner {
  /** Feeds the next stream increment; returns the items it commits, in index order. */
  push(delta: string): { index: number; text: string }[];
  /**
   * - `open`: still committing;
   * - `closed`: commits nothing more, what it committed stands;
   * - `tainted`: what it committed may be a draft (a `</think>` outside strings, or
   *   content after the array).
   */
  readonly state: 'open' | 'closed' | 'tainted';
  /**
   * Tainted by what may be a second answer: after the array, `[` then `{`, `{` then
   * `"` (whitespace between allowed), a `[` or `{` still open when the output
   * ends, or `</think>`; `</think>` inside the array. Prose after the array
   * (`[1]`, `[docs](…)`, `{name}`) taints without it.
   */
  readonly draft: boolean;
  /** The top-level array: not found (yet), being read, or ended. */
  readonly array: 'none' | 'open' | 'closed';
  /** Committed translations; index k holds item k. */
  readonly committed: readonly string[];
}

const SPACE = /\s/;

function sameText(a: string, b: string): boolean {
  const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  return normal(a) === normal(b);
}

/**
 * Reads a streamed `batch` answer and commits items as soon as they are complete,
 * as a strict prefix: only item `i` equal to the next expected index (below the
 * batch size) with a non-empty `t`. The first deviation, and the end of the
 * top-level array, close it. Items equal to their source are held until an item
 * that differs. Only an output that starts with the array (after whitespace, one
 * closed `<think>` block and one fence) is read; anything else is left to the
 * whole-output decode. Every character is looked at once (no rescans).
 */
export function createBatchScanner(sources: readonly string[]): BatchScanner {
  let state: BatchScanner['state'] = 'open';
  let array: BatchScanner['array'] = 'none';
  let draft = false;
  const committed: string[] = [];
  const held: string[] = [];
  /**
   * Lead-in before the array: whitespace (`space`, `gap` after a fence), the
   * `<think>` tag (`open`), its block (`think`), backticks (`fence`), `json` (`lang`).
   */
  let lead: 'space' | 'open' | 'think' | 'fence' | 'lang' | 'gap' = 'space';
  let thought = false;
  let matched = 0;
  let fenced = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let item = '';
  /** The last characters outside strings, to spot `</think>`. */
  let tag = '';
  /** After the array: closing backticks seen, and whether whitespace followed them. */
  let ticks = 0;
  let ticked = false;
  /** After the array: a `[` or `{` waiting for its next non-space character. */
  let opener = '';

  function close() {
    if (state === 'open') state = 'closed';
  }

  function taint(second: boolean) {
    state = 'tainted';
    if (second) draft = true;
  }

  /** Feeds `ch` to the rolling tag; true when it completes `</think>`. */
  function closesThink(ch: string): boolean {
    tag = (tag + ch).slice(-THINK_CLOSE.length);
    return tag.toLowerCase() === THINK_CLOSE;
  }

  function leadIn(ch: string) {
    if (lead === 'think') {
      if (closesThink(ch)) {
        lead = 'space';
        thought = true;
      }
      return;
    }
    if (lead === 'open') {
      if (ch.toLowerCase() !== THINK_OPEN[matched]) return close();
      matched += 1;
      if (matched === THINK_OPEN.length) {
        lead = 'think';
        tag = '';
      }
      return;
    }
    if (lead === 'fence') {
      if (ch !== '`') return close();
      matched += 1;
      if (matched === 3) {
        lead = 'lang';
        matched = 0;
        fenced = true;
      }
      return;
    }
    if (lead === 'lang') {
      if (matched < 4 && ch.toLowerCase() === 'json'[matched]) {
        matched += 1;
        return;
      }
      if (matched % 4 !== 0) return close();
      lead = 'gap';
    }
    if (SPACE.test(ch)) return;
    if (ch === '[') {
      array = 'open';
      tag = '';
      return;
    }
    if (lead === 'space' && ch === '<' && !thought) {
      lead = 'open';
      matched = 1;
    } else if (lead === 'space' && ch === '`') {
      lead = 'fence';
      matched = 1;
    } else {
      close();
    }
  }

  function take(raw: string, out: { index: number; text: string }[]) {
    if (state !== 'open') return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      close();
      return;
    }
    const next = committed.length + held.length;
    const t = isRecord(value) ? value.t : undefined;
    if (!isRecord(value) || value.i !== next || next >= sources.length) return close();
    if (typeof t !== 'string' || t.trim() === '') return close();
    held.push(t);
    if (sameText(t, sources[next] ?? '')) return;
    for (const text of held) out.push({ index: committed.push(text) - 1, text });
    held.length = 0;
  }

  function inArray(ch: string, out: { index: number; text: string }[]) {
    if (depth > 0) item += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      return;
    }
    if (closesThink(ch)) return taint(true);
    if (ch === '"') {
      inString = true;
      tag = '';
      if (depth === 0) close();
    } else if (ch === '{' || ch === '[') {
      if (depth === 0) {
        if (ch === '[') close();
        item = ch;
      }
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) take(item, out);
      } else if (ch === '}') {
        close();
      } else {
        array = 'closed';
        tag = '';
        close();
      }
    } else if (depth === 0 && ch !== ',' && !SPACE.test(ch)) {
      close();
    }
  }

  /** After the array: whitespace, and one closing fence when the array was fenced. */
  function afterArray(ch: string) {
    if (closesThink(ch)) return taint(true);
    if (opener !== '') {
      if (SPACE.test(ch)) return;
      if (ch === (opener === '[' ? '{' : '"')) return taint(true);
      opener = '';
    }
    if (ch === '[' || ch === '{') opener = ch;
    if (state === 'tainted') return;
    if (SPACE.test(ch)) {
      if (ticks > 0) ticked = true;
    } else if (ch === '`' && fenced && !ticked && ticks < 3) {
      ticks += 1;
    } else {
      taint(false);
    }
  }

  return {
    push(delta) {
      const out: { index: number; text: string }[] = [];
      for (const ch of delta) {
        if (draft || (array === 'none' && state !== 'open')) break;
        if (array === 'none') leadIn(ch);
        else if (array === 'open') inArray(ch, out);
        else afterArray(ch);
      }
      return out;
    },
    get state() {
      return state;
    },
    get draft() {
      // An opener with nothing after it yet: too little to tell, so not trusted.
      return draft || opener !== '';
    },
    get array() {
      return array;
    },
    committed,
  };
}

/**
 * Ends a streamed batch once the stream is over: yields the items the scanner did
 * not commit, from the whole-output decode. Throws `validation/bad-response` when
 * that decode disagrees with what was committed or the output carries a possible
 * second answer (both after yielding the rest), or when it fails on a tainted
 * output; `provider/output-truncated` when it fails inside an array that never
 * ended; otherwise the decode error. Only a run that ends without throwing has
 * been checked as a whole.
 */
export function* finishBatch(
  scanner: BatchScanner,
  raw: string,
  count: number,
): Generator<ProviderEvent> {
  let decoded: string[];
  try {
    decoded = decodeLlmOutput(raw, count);
  } catch (error) {
    if (scanner.state === 'tainted') throw badResponseError('Draft output');
    if (scanner.array === 'open') throw outputTruncatedError();
    throw error;
  }
  const { committed } = scanner;
  for (let index = committed.length; index < count; index += 1) {
    yield { type: 'item', index, text: decoded[index] ?? '' };
  }
  if (committed.some((text, index) => text !== decoded[index])) {
    throw badResponseError('Streamed items differ from the output');
  }
  // A second answer after the array may be the one the decode skipped (it prefers a
  // fence and the first array): never trust it as checked.
  if (scanner.draft) throw badResponseError('Draft output');
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
