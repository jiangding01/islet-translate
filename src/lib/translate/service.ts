import { type ConfigV1, type Engine, engineFamily, isEngineId } from '@/lib/config/types';
import { type AppError, appError, type Result } from '@/lib/errors';
import { isLanguageCode, type LanguageCode } from '@/lib/languages';
import {
  TRANSLATE_PAYLOAD_LIMITS,
  type TranslateChunk,
  type TranslateDisposition,
  type TranslateDone,
  type TranslateItem,
  type TranslateRequest,
} from '@/lib/messaging/protocol';
import type { LookupPhonetic } from '@/lib/phonetic/lookup';
import { phoneticKey } from '@/lib/phonetic/word';
import type { TranslationCache } from './cache';
import { makeCacheKey, sha256Hex, stableStringify } from './cache-key';
import { createSameLanguageCheck, type DetectLanguage, detectWithBrowser } from './language';
import { checkEngineEndpoint } from './permissions';
import { buildPrompt, promptDigest } from './prompt';
import { abortedError } from './providers/errors';
import { getAdapter as registryAdapter, resolveProviderSettings } from './providers/registry';
import { createScheduler, type Scheduler } from './scheduler';
import type { SecretStore } from './secrets';
import type { ProviderAdapter } from './types';

export interface TranslateServiceDeps {
  /** Current configuration (the background passes the repository's snapshot data). */
  getConfig(): Promise<ConfigV1>;
  secrets: Pick<SecretStore, 'get'>;
  cache: TranslationCache;
  getAdapter?: (engine: Engine) => ProviderAdapter;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** `null` disables detection; omitted uses chrome.i18n.detectLanguage. */
  detectLanguage?: DetectLanguage | null;
  /** Endpoint gate (built-in origin, or https/localhost with the host permission). */
  checkPermission?: (engine: Engine, baseURL: string) => Promise<Result<unknown>>;
  /** Shared scheduler; by default the service creates its own. */
  scheduler?: Scheduler;
  /** British / American IPA for `phonetic` requests; without it they get no phonetic chunk. */
  lookupPhonetic?: LookupPhonetic;
}

export interface TranslateContext {
  /** Aborted on cancel or disconnect. */
  signal: AbortSignal;
  emit(chunk: TranslateChunk): void;
  /** Fairness group (one per Port). Defaults to a group per request. */
  caller?: string;
}

export interface TranslateService {
  translate(payload: TranslateRequest, ctx: TranslateContext): Promise<TranslateDone>;
  readonly scheduler: Scheduler;
}

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Replaces lone surrogates with U+FFFD (they break encodeURIComponent and
 * hashing), drops zero-width characters (U+200B–U+200D, U+FEFF), then trims.
 */
export function preprocessText(text: string): string {
  return text.toWellFormed().replace(ZERO_WIDTH, '').trim();
}

function comparable(text: string): string {
  return preprocessText(text).replace(/\s+/g, ' ').toLowerCase();
}

/** `unchanged` when the translation equals the source after trim, whitespace folding and case folding. */
export function classifyTranslation(
  source: string,
  translation: string,
): Extract<TranslateDisposition, 'translated' | 'unchanged'> {
  return comparable(source) === comparable(translation) ? 'unchanged' : 'translated';
}

function invalidPayloadError(): AppError {
  return appError('validation', 'validation/invalid-payload', 'Malformed translate request');
}

/** In-flight translate requests allowed per caller (one Port). */
export const MAX_REQUESTS_PER_CALLER = 8;

export function portBusyError(): AppError {
  return appError(
    'rate-limit',
    'rate-limit/port-busy',
    'Too many requests in flight on this port',
    {
      retryable: true,
    },
  );
}

/**
 * Cooldown scope: one per engine family and endpoint origin (custom providers on
 * the same server share it); Google has a fixed endpoint.
 */
export function cooldownKeyFor(engine: Engine, baseURL: string): string {
  if (engine === 'google') return 'google';
  let origin = baseURL;
  try {
    origin = new URL(baseURL).origin;
  } catch {
    // Unparsable endpoints were already rejected by the endpoint gate.
  }
  return `${engineFamily(engine)}|${origin}`;
}

export function payloadTooLargeError(): AppError {
  return appError('validation', 'validation/payload-too-large', 'Too many items or characters');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates the untrusted payload shape and size. Throws AppError. */
export function parseTranslateRequest(payload: unknown): TranslateRequest {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw invalidPayloadError();
  const items: TranslateItem[] = [];
  const ids = new Set<string>();
  let chars = 0;
  for (const item of payload.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') {
      throw invalidPayloadError();
    }
    // Chunks are matched to items by id: duplicates would be ambiguous.
    if (ids.has(item.id)) throw invalidPayloadError();
    ids.add(item.id);
    chars += item.text.length;
    items.push({ id: item.id, text: item.text });
  }
  if (
    items.length > TRANSLATE_PAYLOAD_LIMITS.maxItems ||
    chars > TRANSLATE_PAYLOAD_LIMITS.maxChars
  ) {
    throw payloadTooLargeError();
  }
  const { source, target } = payload;
  if (source !== undefined && source !== 'auto' && !isLanguageCode(source)) {
    throw invalidPayloadError();
  }
  if (target !== undefined && !isLanguageCode(target)) throw invalidPayloadError();
  const { engine } = payload;
  if (engine !== undefined && !isEngineId(engine)) throw invalidPayloadError();
  const request: TranslateRequest = { items, source, target, engine };
  const { stream, force } = payload;
  if (stream !== undefined) {
    // Stream chunks carry no batch semantics: one item per request.
    if (stream !== true || items.length !== 1) throw invalidPayloadError();
    request.stream = true;
  }
  if (force !== undefined) {
    if (force !== true) throw invalidPayloadError();
    request.force = true;
  }
  const { phonetic } = payload;
  if (phonetic !== undefined) {
    if (phonetic !== true) throw invalidPayloadError();
    // A per-word extra: a batch simply does not get it.
    if (items.length === 1) request.phonetic = true;
  }
  return request;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortedError();
}

interface Pending {
  id: string;
  raw: string;
  text: string;
}

/**
 * Port `et-translate` handler logic: preprocess, same-language skip (unless
 * `force`), cache lookup, then one scheduler submission; emits one final chunk
 * per item (preceded by reset / delta chunks for a `stream` request that reaches
 * the provider, followed by a `revoked` chunk when an AI batch takes back what it
 * delivered early) and resolves with `{ total, failed }`. Results reach the cache through the scheduler, so
 * they are stored even when this caller has gone away.
 */
export function createTranslateService(deps: TranslateServiceDeps): TranslateService {
  const scheduler =
    deps.scheduler ?? createScheduler({ fetch: deps.fetch, now: deps.now, random: deps.random });
  const getAdapter = deps.getAdapter ?? registryAdapter;
  const isSameLanguage = createSameLanguageCheck(
    deps.detectLanguage === undefined ? detectWithBrowser : (deps.detectLanguage ?? undefined),
  );
  const checkPermission = deps.checkPermission ?? checkEngineEndpoint;
  const { cache } = deps;
  let sequence = 0;

  /** Emits the phonetic chunk of a `phonetic` request, if any; never rejects. */
  async function lookupPhoneticFor(
    request: TranslateRequest,
    emit: (chunk: TranslateChunk) => void,
  ): Promise<void> {
    const item = request.items[0];
    if (!request.phonetic || !deps.lookupPhonetic || !item || request.items.length !== 1) return;
    // The background's own word check: the flag alone is not trusted.
    if (phoneticKey(item.text) === undefined) return;
    try {
      const hit = await deps.lookupPhonetic(item.text);
      if (!hit || (!hit.uk && !hit.us)) return;
      const phonetic: { uk?: string; us?: string } = {};
      if (hit.uk) phonetic.uk = hit.uk;
      if (hit.us) phonetic.us = hit.us;
      emit(hit.lemma ? { id: item.id, phonetic, lemma: hit.lemma } : { id: item.id, phonetic });
    } catch {
      // A phonetic is an extra: it never fails the translation.
    }
  }

  /** In-flight requests per caller; an entry is removed when it drops to zero. */
  const inflight = new Map<string, number>();

  async function translate(payload: TranslateRequest, ctx: TranslateContext) {
    const caller = ctx.caller ?? `request-${++sequence}`;
    const count = inflight.get(caller) ?? 0;
    if (count >= MAX_REQUESTS_PER_CALLER) throw portBusyError();
    inflight.set(caller, count + 1);
    try {
      return await run(payload, ctx, caller);
    } finally {
      const left = (inflight.get(caller) ?? 1) - 1;
      if (left > 0) inflight.set(caller, left);
      else inflight.delete(caller);
    }
  }

  async function run(payload: TranslateRequest, ctx: TranslateContext, caller: string) {
    const request = parseTranslateRequest(payload);
    const { signal } = ctx;
    throwIfAborted(signal);

    let failed = 0;
    const emit = (chunk: TranslateChunk) => {
      if (signal.aborted) return;
      if ('error' in chunk) failed += 1;
      ctx.emit(chunk);
    };
    // Looked up alongside the translation, never before it; awaited before the request
    // ends, so the chunk always precedes `done`.
    const phonetic = lookupPhoneticFor(request, emit);
    const done = async (): Promise<TranslateDone> => {
      await phonetic;
      return { total: request.items.length, failed };
    };

    // 1. Preprocess: blank items are returned as they are, without a request.
    const pending: Pending[] = [];
    for (const item of request.items) {
      const text = preprocessText(item.text);
      if (text === '') {
        emit({ id: item.id, text: item.text, disposition: 'unchanged', cached: false });
      } else {
        pending.push({ id: item.id, raw: item.text, text });
      }
    }
    if (pending.length === 0) return done();

    const config = await deps.getConfig();
    throwIfAborted(signal);
    const source: LanguageCode | 'auto' = request.source ?? config.language.source;
    const target: LanguageCode = request.target ?? config.language.target;
    // The session's engine (fixed at start, "这次先用 Google" can change it) wins over the default.
    const engine = request.engine ?? config.translation.engine;
    const adapter = getAdapter(engine);
    const settings = resolveProviderSettings(engine, config);

    // 2. Same-language skip (only when the source is detected, and not when forced).
    let candidates = pending;
    if (source === 'auto' && !request.force) {
      const same = await Promise.all(pending.map((item) => isSameLanguage(item.text, target)));
      throwIfAborted(signal);
      candidates = [];
      pending.forEach((item, index) => {
        if (same[index]) {
          emit({ id: item.id, text: item.raw, disposition: 'same-language', cached: false });
        } else {
          candidates.push(item);
        }
      });
      if (candidates.length === 0) return done();
    }

    // 3. Cache lookup.
    // Stream requests use the plain-text prompt; its digest keeps their cache apart.
    const prompt =
      adapter.kind === 'llm'
        ? buildPrompt({ source, target, format: request.stream ? 'text' : 'batch' })
        : undefined;
    const digest = prompt ? await promptDigest(prompt) : '';
    // '' by default, as before M4-A: only params that change the request key it apart.
    const params = settings.cacheParams
      ? await sha256Hex(stableStringify(settings.cacheParams))
      : '';
    const keyed = await Promise.all(
      candidates.map(async (item) => ({
        ...item,
        key: await makeCacheKey({
          // Family, not id: re-adding the same endpoint and model reuses the cache.
          engine: engineFamily(engine),
          endpoint: settings.baseURL,
          model: settings.model,
          source,
          target,
          promptDigest: digest,
          paramsDigest: params,
          text: item.text,
        }),
      })),
    );
    const hits = await cache.getMany([...new Set(keyed.map((item) => item.key))]);
    throwIfAborted(signal);
    const misses: typeof keyed = [];
    for (const item of keyed) {
      const hit = hits.get(item.key);
      if (hit === undefined) misses.push(item);
      else {
        emit({
          id: item.id,
          text: hit,
          disposition: classifyTranslation(item.text, hit),
          cached: true,
        });
      }
    }

    try {
      if (misses.length === 0) return done();

      // 4. Preconditions shared by every remaining item.
      const permission = await checkPermission(engine, settings.baseURL);
      throwIfAborted(signal);
      if (!permission.ok) {
        for (const item of misses) emit({ id: item.id, error: permission.error });
        return done();
      }
      const apiKey = engine === 'google' ? undefined : await deps.secrets.get(engine);
      throwIfAborted(signal);

      // 5. Schedule; chunks are emitted as segments finish. Stream requests also get
      // reset / delta chunks (Google never produces deltas).
      const idOf = new Map(misses.map((item) => [item.key, item.id]));
      const streamCallbacks = request.stream
        ? {
            onReset: (key: string) => {
              const id = idOf.get(key);
              if (id !== undefined) emit({ id, reset: true });
            },
            onDelta: (key: string, delta: string) => {
              const id = idOf.get(key);
              if (id !== undefined) emit({ id, delta });
            },
          }
        : {};
      // A verdict still pending when the request is cancelled or the port goes no longer matters.
      const left = new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(true), { once: true });
      });
      const outcomes = scheduler.submit({
        caller,
        signal,
        engine,
        cooldownKey: cooldownKeyFor(engine, settings.baseURL),
        adapter,
        context: { source, target, settings, apiKey, prompt },
        segments: misses.map((item) => ({ key: item.key, text: item.text })),
        persist: (entries) => cache.put(entries),
        ...streamCallbacks,
      });
      await Promise.all(
        outcomes.map(async (pendingOutcome, index) => {
          const outcome = await pendingOutcome;
          const item = misses[index];
          if (!item) return;
          if (outcome.ok) {
            const disposition = classifyTranslation(item.text, outcome.text);
            emit({ id: item.id, text: outcome.text, disposition, cached: false });
            // Delivered before its AI batch was checked: the item ends only once the batch
            // has, so a revocation always comes before `done`.
            if (
              outcome.verdict &&
              disposition === 'translated' &&
              !(await Promise.race([outcome.verdict, left]))
            ) {
              emit({ id: item.id, revoked: outcome.text });
            }
          } else {
            emit({ id: item.id, error: outcome.error });
          }
        }),
      );
      throwIfAborted(signal);
      return done();
    } finally {
      // One batched lastUsedAt refresh per request; best effort.
      if (hits.size > 0) void cache.touch([...hits.keys()]);
    }
  }

  return { translate, scheduler };
}
