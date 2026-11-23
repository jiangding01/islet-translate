import { defineExtensionMessaging } from '@webext-core/messaging';
import type {
  ConfigChange,
  ConfigPath,
  ConfigSnapshot,
  CustomProviderId,
  Engine,
  PageMode,
} from '@/lib/config/types';
import type { AppError, Result } from '@/lib/errors';
import type { LanguageCode } from '@/lib/languages';
import type { ProviderIcon } from '@/lib/provider-icons';
import type { SiteMemory } from '@/lib/site-memory';

export interface PageInfo {
  title: string;
  /** `<html lang>`; empty when the page does not declare one. */
  language: string;
}

/** Built-in engines that take a key, or a custom provider id. */
export type SecretProviderId = 'openai' | 'deepseek' | 'gemini' | CustomProviderId;

/** Never carries the key itself: `last4` is empty for short keys. */
export interface SecretStatusInfo {
  configured: boolean;
  last4: string;
}

/**
 * Unsaved settings-page values; `apiKey` falls back to the key saved for `engine`
 * when omitted or blank. A custom id need not exist in the config yet.
 */
export interface ProviderTestDraft {
  engine: Engine;
  baseURL: string;
  model: string;
  apiKey?: string;
}

export interface ProviderTestResult {
  latencyMs: number;
  text: string;
}

/** A page-translation session as the toolbar panel sees it (content script → popup). */
export interface PageState {
  phase: 'idle' | 'running' | 'done';
  mode: PageMode;
  /** Units with a rendered translation. */
  translated: number;
  /** Units whose last attempt failed and can be retried. */
  failed: number;
  /** Paragraphs too long to translate, marked in the page and never sent; only present above zero. */
  skipped?: number;
  /** Engine-level problem that paused the session; it is shown once, not per paragraph. */
  engineError?: AppError;
  /** Engine this session actually uses: fixed at start, "这次先用" can change it. */
  engine?: Engine;
  /** Set once the session stopped for good (extension context invalidated); absent otherwise. */
  halted?: true;
  /**
   * Only paragraphs the reader held Ctrl over are translated: no isle, no status dot, the
   * panel still offers to translate the page. Absent for a whole-page session and when idle.
   */
  scope?: 'units';
}

/** One row of the page isle's engine list. A whitelist: no key material, URL or model. */
export interface EngineOption {
  id: Engine;
  name: string;
  /** Short label shown in a small square where the engine has no vendor icon. */
  short: string;
  /** Vendor icon (path data, never markup); absent for unrecognized custom providers. */
  icon?: ProviderIcon;
  ready: boolean;
  /** Why the engine is not ready, in the settings page's wording. */
  note?: string;
}

export interface EngineOptions {
  /** The default engine set in the config (a running session keeps the one it started with). */
  configured: Engine;
  options: EngineOption[];
}

/** Status the content script reports so the toolbar icon can show its dot. */
export type PageStatus = 'idle' | 'running' | 'done' | 'error';

export interface CacheStatsInfo {
  count: number;
  totalBytes: number;
}

/**
 * One-shot messages between contexts. Every reply is a `Result`: handlers are
 * wrapped with `handle()` and senders go through `call()`, so nothing throws
 * across a context boundary. Payloads are not validated: every sender is this
 * extension's own code (config writes are validated by the repository, and
 * accepted from extension pages only).
 */
export interface ProtocolMap {
  'app.getStatus'(): Result<{ version: string }>;
  'config.patch'(changes: ConfigChange[]): Result<ConfigSnapshot>;
  'config.reset'(paths?: ConfigPath[]): Result<ConfigSnapshot>;
  /** Settings page only (`validation/forbidden-sender` otherwise). */
  'secrets.set'(args: { provider: SecretProviderId; key: string | null }): Result<SecretStatusInfo>;
  /** Every built-in provider, plus each custom provider that has a key. */
  'secrets.status'(): Result<Partial<Record<SecretProviderId, SecretStatusInfo>>>;
  'provider.test'(draft: ProviderTestDraft): Result<ProviderTestResult>;
  'cache.stats'(): Result<CacheStatsInfo>;
  'cache.clear'(): Result<null>;
  /** popup → top frame (frameId 0) of a given tab. */
  'page.getInfo'(): Result<PageInfo>;
  /** popup → content (frameId 0): page-translation session control. */
  'page.getState'(): Result<PageState>;
  'page.start'(args: { engine?: Engine }): Result<PageState>;
  'page.stop'(): Result<PageState>;
  'page.setMode'(mode: PageMode): Result<PageState>;
  'page.retryFailed'(): Result<PageState>;
  /** background → content: the translate-page shortcut. */
  'page.toggle'(): Result<PageState>;
  /** content → background: engines the isle can offer; read-only, never carries keys or URLs. */
  'engine.options'(): Result<EngineOptions>;
  /** content → background: drives the toolbar icon's status dot for the sender tab. */
  'page.status'(status: PageStatus): Result<null>;
  /** extension pages → background: "总是翻译此站". */
  'site.setAlways'(args: { origin: string; always: boolean }): Result<SiteMemory>;
  /**
   * background → content (frameId 0): open the selection card. From the context menu
   * `selectionText` and the menu's `frameId` are set; from the shortcut both are absent.
   */
  'selection.open'(args: { selectionText?: string; frameId?: number }): Result<null>;
  /** background → content (frameId 0): the open-palette shortcut opens or closes the palette. */
  'palette.toggle'(): Result<null>;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

// ---------------------------------------------------------------- Port et-translate

export { TRANSLATE_PORT_NAME } from './port-name';

/** Larger payloads are rejected with `validation/payload-too-large`. */
export const TRANSLATE_PAYLOAD_LIMITS = { maxItems: 200, maxChars: 50_000 } as const;

export interface TranslateItem {
  id: string;
  text: string;
}

export interface TranslateRequest {
  items: TranslateItem[];
  /** Defaults to the configured source / target language. */
  source?: LanguageCode | 'auto';
  target?: LanguageCode;
  /** Engine this session uses (fixed at start, "这次先用 Google" can change it); never written to the config. */
  engine?: Engine;
  /**
   * Stream the translation as `delta` / `reset` chunks before the final chunk.
   * Single item only (`validation/invalid-payload` otherwise).
   */
  stream?: true;
  /** Skip the same-language check: the user explicitly asked (menu, shortcut). */
  force?: true;
  /**
   * Also send the item's British and American IPA in a `phonetic` chunk when it is a single
   * English word the bundled tables know. Single item only (ignored otherwise); never part of the cache
   * key. The caller decides whether the text is English.
   */
  phonetic?: true;
}

/**
 * - `translated`: `text` is the translation.
 * - `unchanged`: nothing to translate (blank input) or the translation equals the source.
 * - `same-language`: detected as already in the target language; `text` is the source.
 */
export type TranslateDisposition = 'translated' | 'unchanged' | 'same-language';

/**
 * One final chunk per item, in completion order. Stream requests may send `reset`
 * (drop the increments received so far: a new attempt starts) and `delta`
 * (append) chunks before it; the final chunk replaces whatever was accumulated.
 * A `phonetic` request may also get one `phonetic` chunk, before or after the final
 * chunk but always before the request ends; it is not a result, so consumers must test
 * for it (like `delta` / `reset`) before treating a chunk as final.
 */
export type TranslateChunk =
  | { id: string; text: string; disposition: TranslateDisposition; cached: boolean }
  | { id: string; error: AppError }
  | { id: string; delta: string }
  | { id: string; reset: true }
  /**
   * British and American IPA without slashes, at least one of them. `lemma` is set only
   * when the readings are the headword's (the form's own could not be derived).
   */
  | { id: string; phonetic: { uk?: string; us?: string }; lemma?: string };

export interface TranslateDone {
  total: number;
  failed: number;
}
