import type { LanguageCode } from '@/lib/languages';

// Background-only. Nothing under src/lib/translate may be imported by clients
// (popup, options UI, content scripts).

export type ProviderEvent =
  /** Complete translation of one item. */
  | { type: 'item'; index: number; text: string }
  /** Streaming increment of one item: only `text` prompts produce it (selection cards). */
  | { type: 'delta'; index: number; delta: string };

export interface BuiltPrompt {
  /**
   * - `batch`: JSON array of `{ i, t }` in and out (page translation).
   * - `text`: one item as plain text between per-request nonce markers; the reply is
   *   the translation itself (stream requests). `system` and `user` contain NONCE_TOKEN.
   */
  format: 'batch' | 'text';
  system: string;
  /** User message template; contains USER_INPUT_TOKEN, replaced by the encoded batch or the text. */
  user: string;
  version: number;
}

/** Resolved provider settings: `baseURL` is normalized, `model` may be empty (Google ignores both). */
export interface ProviderSettings {
  baseURL: string;
  model: string;
  /**
   * Extra request body fields: thinking (src/lib/config/thinking-rules.ts), then the user's
   * own. Adapters spread them first, so they never override the request itself.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Non-default params that change the request (thinking on where a rule applies, the
   * user's parsed extra fields); part of the cache key. Absent by default, which keeps
   * every cache key from before M4-A.
   */
  cacheParams?: Record<string, unknown>;
}

export interface ProviderContext {
  signal: AbortSignal;
  source: LanguageCode | 'auto';
  target: LanguageCode;
  settings: ProviderSettings;
  apiKey?: string;
  /** Required by LLM adapters. */
  prompt?: BuiltPrompt;
  /**
   * Machine translation (M4-C): the segments carry glossary term marks (`<gN>…</gN>`). Google
   * then sends them as HTML only and answers an item it cannot bring back intact with its
   * source, marks removed (see providers/google.ts).
   */
  terms?: boolean;
  /**
   * Injectable fetch (defaults to globalThis.fetch). The scheduler passes a wrapper
   * that stops its response-header timer once the response arrives.
   */
  fetch?: typeof fetch;
  /** LLM streams: abort when no data arrives for this long after the first chunk. */
  idleTimeoutMs?: number;
}

export interface ProviderAdapter {
  kind: 'mt' | 'llm';
  limits: { maxItems: number; maxChars: number };
  /**
   * On normal completion exactly one `item` per index has been yielded; failures are
   * thrown as AppError.
   */
  translate(batch: string[], ctx: ProviderContext): AsyncIterable<ProviderEvent>;
}
