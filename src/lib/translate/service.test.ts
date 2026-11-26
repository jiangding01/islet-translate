import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import { appError, fail, ok } from '@/lib/errors';
import type { GlossaryEntry } from '@/lib/glossary/types';
import { createPortClient, type PortLike, servePort } from '@/lib/messaging/port';
import type { TranslateChunk, TranslateDone, TranslateRequest } from '@/lib/messaging/protocol';
import type { PhoneticHit } from '@/lib/phonetic/lookup';
import { createTranslationCache, openCacheDb } from './cache';
import type { ItemOutcome } from './codec';
import type { DetectLanguage } from './language';
import { checkEngineEndpoint } from './permissions';
import type { Scheduler } from './scheduler';
import {
  classifyTranslation,
  cooldownKeyFor,
  createTranslateService,
  parseTranslateRequest,
  preprocessText,
  type TranslateServiceDeps,
} from './service';
import { gatedSseResponse, jsonResponse, sseResponse } from './test-utils';

// ------------------------------------------------------------ in-memory port

type Listener<T extends unknown[]> = (...args: T) => void;

function endpoint() {
  const messageListeners: Listener<[unknown]>[] = [];
  const disconnectListeners: Listener<[]>[] = [];
  return {
    messageListeners,
    disconnectListeners,
    onMessage: { addListener: (cb: Listener<[unknown]>) => void messageListeners.push(cb) },
    onDisconnect: { addListener: (cb: Listener<[]>) => void disconnectListeners.push(cb) },
  };
}

/** Chrome-like pair: structured-cloned async delivery, throws after disconnect. */
function createPortPair() {
  let connected = true;
  const a = endpoint();
  const b = endpoint();
  const side = (self: typeof a, other: typeof a): PortLike => ({
    onMessage: self.onMessage,
    onDisconnect: self.onDisconnect,
    postMessage(message) {
      if (!connected) throw new Error('Attempting to use a disconnected port object');
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (connected) for (const listener of other.messageListeners) listener(copy);
      });
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      queueMicrotask(() => {
        for (const listener of other.disconnectListeners) listener();
      });
    },
  });
  return {
    client: side(a, b),
    server: side(b, a),
    /** Connection lost: both ends see onDisconnect. */
    breakConnection() {
      connected = false;
      for (const listener of [...a.disconnectListeners, ...b.disconnectListeners]) listener();
    },
  };
}

// ------------------------------------------------------------ fake providers

interface FetchCall {
  url: string;
  method: string;
  signal: AbortSignal;
  aborted: boolean;
}

type Handler = (texts: string[], call: FetchCall) => Response | Promise<Response>;
type TextHandler = (text: string, call: FetchCall) => Response | Promise<Response>;

const googleOk: Handler = (texts) => jsonResponse(texts.map((text) => [`G:${text}`, 'en']));
const singleOk: Handler = ([text]) => jsonResponse([[[`S:${text}`, text, null, null]]]);
const openaiDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const openaiReply = (items: { i: number; t: string }[]) =>
  sseResponse([openaiDelta(JSON.stringify(items)), 'data: [DONE]\n\n']);
const openaiOk: Handler = (texts) => openaiReply(texts.map((text, i) => ({ i, t: `O:${text}` })));
/** Text-format reply in two increments: "流:" then the source. */
const openaiTextOk: TextHandler = (text) =>
  sseResponse([openaiDelta('流:'), openaiDelta(text), 'data: [DONE]\n\n']);
/**
 * The text between a text prompt's nonce markers, or undefined for a batch prompt. Not anchored
 * at the start: glossary lines may come first (M4-C).
 */
const TEXT_MARKERS = /-----BEGIN ([0-9a-f]+)-----\n([\s\S]*)\n-----END \1-----$/;

/** Never answers; rejects like real fetch once aborted. */
const hang: Handler = (_texts, call) =>
  new Promise<Response>((_, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener('abort', onAbort, { once: true });
  });

function createProviders() {
  const calls: FetchCall[] = [];
  const handlers: { google: Handler; single: Handler; openai: Handler; openaiText: TextHandler } = {
    google: googleOk,
    single: singleOk,
    openai: openaiOk,
    openaiText: openaiTextOk,
  };
  /** Texts sent to a provider, one entry per fetch (Google batches: one per text). */
  const sent: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal as AbortSignal;
    const call: FetchCall = { url, method: init?.method ?? 'GET', signal, aborted: false };
    signal.addEventListener('abort', () => {
      call.aborted = true;
    });
    calls.push(call);
    if (url.includes('/translate_a/t?')) {
      const texts = new URLSearchParams(String(init?.body)).getAll('q');
      sent.push(...texts);
      return handlers.google(texts, call);
    }
    if (url.includes('/translate_a/single?')) {
      return handlers.single([new URL(url).searchParams.get('q') ?? ''], call);
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const content = body.messages[1]?.content ?? '';
      const marked = TEXT_MARKERS.exec(content)?.[2];
      if (marked !== undefined) {
        sent.push(marked);
        return handlers.openaiText(marked, call);
      }
      // The batch is the last line (glossary lines may come first, M4-C).
      const items = JSON.parse(content.slice(content.lastIndexOf('\n') + 1)) as {
        i: number;
        t: string;
      }[];
      sent.push(...items.map((item) => item.t));
      return handlers.openai(
        items.map((item) => item.t),
        call,
      );
    }
    throw new TypeError(`unexpected fetch ${url}`);
  });
  return {
    fetch: fetchFn as unknown as typeof fetch,
    calls,
    handlers,
    sent,
    aborts: () => calls.filter((call) => call.aborted).length,
  };
}

// ------------------------------------------------------------ harness

let dbSeq = 0;

function setup(overrides: Partial<TranslateServiceDeps> = {}) {
  const providers = createProviders();
  const config: ConfigV1 = createDefaultConfig('zh-CN');
  config.providers.openai.model = 'gpt-test';
  const cache = createTranslationCache({ open: () => openCacheDb(`service-${dbSeq++}`) });
  const detect = vi.fn<DetectLanguage>(async () => ({ isReliable: false, languages: [] }));
  const service = createTranslateService({
    getConfig: async () => structuredClone(config),
    secrets: { get: async (provider) => (provider === 'openai' ? 'sk-test-secret' : undefined) },
    cache,
    fetch: providers.fetch,
    random: () => 0,
    detectLanguage: detect,
    checkPermission: async () => ok(undefined),
    ...overrides,
  });
  const pairs: ReturnType<typeof createPortPair>[] = [];
  const client = createPortClient<TranslateRequest, TranslateChunk, TranslateDone>(() => {
    const pair = createPortPair();
    // One fairness group per port, as the background registers it.
    const caller = `port-${pairs.length}`;
    servePort<TranslateRequest, TranslateChunk, TranslateDone>(pair.server, (payload, ctx) =>
      service.translate(payload, { ...ctx, caller }),
    );
    pairs.push(pair);
    return pair.client;
  });

  function request(payload: TranslateRequest) {
    const chunks: TranslateChunk[] = [];
    const handle = client.request(payload, (chunk) => chunks.push(chunk));
    return { ...handle, chunks };
  }

  async function run(payload: TranslateRequest) {
    const handle = request(payload);
    const outcome = await handle.outcome;
    const byId = Object.fromEntries(handle.chunks.map((chunk) => [chunk.id, chunk]));
    return { outcome, chunks: handle.chunks, byId };
  }

  return { providers, config, cache, detect, service, client, pairs, request, run };
}

const items = (...texts: string[]) => texts.map((text, index) => ({ id: `i${index}`, text }));

/** Waits until the cache holds `count` entries (writes are fire-and-forget). */
async function cached(cache: ReturnType<typeof setup>['cache'], count: number) {
  await vi.waitFor(async () => expect((await cache.stats()).count).toBe(count));
}

/** Not faked by the tests (they fake setTimeout only), so it runs after pending promise jobs. */
const macrotask = (globalThis as unknown as { setImmediate(callback: () => void): void })
  .setImmediate;

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => macrotask(resolve));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------ unit helpers

describe('preprocessing and classification', () => {
  it('drops zero-width characters and trims', () => {
    expect(preprocessText('​ Hello‌ world‍﻿ ')).toBe('Hello world');
  });

  it('classifies translations equal after normalization as unchanged', () => {
    expect(classifyTranslation('GitHub  API', 'github api ')).toBe('unchanged');
    expect(classifyTranslation('Hello', '你好')).toBe('translated');
  });

  it('rejects malformed payloads', () => {
    expect(() => parseTranslateRequest({ items: 'x' })).toThrow(
      expect.objectContaining({ code: 'validation/invalid-payload' }),
    );
    expect(() => parseTranslateRequest({ items: [{ id: 1, text: 'a' }] })).toThrow(
      expect.objectContaining({ code: 'validation/invalid-payload' }),
    );
    expect(() => parseTranslateRequest({ items: [], target: 'xx' })).toThrow(
      expect.objectContaining({ code: 'validation/invalid-payload' }),
    );
  });

  it('rejects a payload with duplicate item ids', () => {
    expect(() =>
      parseTranslateRequest({
        items: [
          { id: 'a', text: 'one' },
          { id: 'a', text: 'two' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'validation/invalid-payload' }));
  });

  it('accepts a one-off engine and rejects an unknown one', () => {
    expect(parseTranslateRequest({ items: [], engine: 'google' }).engine).toBe('google');
    expect(() => parseTranslateRequest({ items: [], engine: 'bing' })).toThrow(
      expect.objectContaining({ code: 'validation/invalid-payload' }),
    );
  });

  it('repairs lone surrogates', () => {
    expect(preprocessText('a\uD800b\uDC00')).toBe('a\uFFFDb\uFFFD');
  });
});

// ------------------------------------------------------------ integration

describe('translate service over the port', () => {
  it('uses a one-off engine for the request without touching the config', async () => {
    const { providers, config, run } = setup();
    config.translation.engine = 'openai';
    const result = await run({ items: items('Hello'), source: 'en', engine: 'google' });
    expect(result.byId.i0).toMatchObject({ text: 'G:Hello', disposition: 'translated' });
    expect(providers.calls[0]?.url).toContain('/translate_a/t?');
    expect(config.translation.engine).toBe('openai');
  });

  it('runs req → chunk → done, then serves the second request from the cache', async () => {
    const { providers, cache, run } = setup();
    const first = await run({ items: items('Hello', 'World') });
    expect(first.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(first.byId).toEqual({
      i0: { id: 'i0', text: 'G:Hello', disposition: 'translated', cached: false },
      i1: { id: 'i1', text: 'G:World', disposition: 'translated', cached: false },
    });
    expect(providers.calls).toHaveLength(1);
    expect(providers.calls[0]?.method).toBe('POST');

    await cached(cache, 2);
    const second = await run({ items: items('Hello', 'World') });
    expect(second.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(second.chunks.every((chunk) => 'cached' in chunk && chunk.cached)).toBe(true);
    expect(providers.calls).toHaveLength(1);
  });

  it('skips items detected as already in the target language', async () => {
    const { providers, detect, run } = setup();
    detect.mockImplementation(async (text) =>
      /[一-鿿]/.test(text)
        ? { isReliable: true, languages: [{ language: 'zh', percentage: 99 }] }
        : { isReliable: true, languages: [{ language: 'en', percentage: 99 }] },
    );
    // Under the echo threshold (see echo.ts): the fake engine returns the source after a prefix.
    const result = await run({
      items: items('这是一段足够长的中文文本内容', 'This is English text'),
    });
    expect(result.byId.i0).toEqual({
      id: 'i0',
      text: '这是一段足够长的中文文本内容',
      disposition: 'same-language',
      cached: false,
    });
    expect(result.byId.i1).toMatchObject({ disposition: 'translated', cached: false });
    expect(providers.calls).toHaveLength(1);
  });

  it('does not detect when the source language is explicit', async () => {
    const { detect, run } = setup();
    await run({ items: items('这是一段足够长的中文文本内容'), source: 'en' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('splits an LLM batch whose item count does not match, down to single items', async () => {
    const { providers, config, cache, run } = setup();
    config.translation.engine = 'openai';
    let first = true;
    providers.handlers.openai = (texts, call) => {
      if (first) {
        first = false;
        return openaiReply([{ i: 0, t: 'only one' }]);
      }
      return openaiOk(texts, call);
    };
    const result = await run({ items: items('one', 'two', 'three'), source: 'en' });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 3, failed: 0 } });
    // Item 0 is shown as soon as it arrives (ids in order, so it cannot be told apart from
    // a good answer), then revoked once the batch fails its check; nothing of the batch is
    // cached, and the rest is halved.
    expect(result.chunks.map((chunk) => ('text' in chunk ? chunk.text : chunk))).toEqual([
      'only one',
      { id: 'i0', revoked: 'only one' },
      'O:two',
      'O:three',
    ]);
    expect(providers.calls).toHaveLength(3); // [one, two, three] → [two] + [three]
    await cached(cache, 2);
  });

  it('sends the first item of an LLM batch before the rest of the batch arrives', async () => {
    const { providers, config, request } = setup();
    config.translation.engine = 'openai';
    let release: () => void = () => undefined;
    providers.handlers.openai = (texts) => {
      const gated = gatedSseResponse(
        [openaiDelta(`[${JSON.stringify({ i: 0, t: `O:${texts[0]}` })},`)],
        [openaiDelta(`${JSON.stringify({ i: 1, t: `O:${texts[1]}` })}]`), 'data: [DONE]\n\n'],
      );
      release = gated.release;
      return gated.response;
    };
    const handle = request({ items: items('one', 'two'), source: 'en' });
    await vi.waitFor(() => expect(handle.chunks.map((chunk) => chunk.id)).toEqual(['i0']));
    expect(handle.chunks[0]).toMatchObject({ id: 'i0', text: 'O:one', cached: false });
    release();
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(handle.chunks.map((chunk) => chunk.id)).toEqual(['i0', 'i1']);
  });

  it('fails only the item that stays malformed after splitting', async () => {
    const { providers, config, cache, run } = setup();
    config.translation.engine = 'openai';
    providers.handlers.openai = (texts) =>
      texts.includes('bad')
        ? openaiReply([])
        : openaiReply(texts.map((text, i) => ({ i, t: `O:${text}` })));
    const result = await run({ items: items('good', 'bad'), source: 'en' });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 2, failed: 1 } });
    expect(result.byId.i0).toMatchObject({ text: 'O:good', disposition: 'translated' });
    expect(result.byId.i1).toMatchObject({ error: { code: 'validation/bad-response' } });
    await cached(cache, 1);
  });

  it('aborts the fetch when the caller cancels', async () => {
    const { providers, service, request } = setup();
    providers.handlers.google = hang;
    const handle = request({ items: items('Hello') });
    await vi.waitFor(() => expect(providers.calls).toHaveLength(1));
    handle.cancel();
    expect(await handle.outcome).toEqual({ status: 'cancelled' });
    await vi.waitFor(() => expect(providers.aborts()).toBe(1));
    await vi.waitFor(() => expect(service.scheduler.inspect().active.mt).toBe(0));
    expect(service.scheduler.inspect().segments).toBe(0);
  });

  it('aborts every request of a port when it disconnects', async () => {
    const { providers, service, request, pairs } = setup();
    providers.handlers.google = hang;
    const first = request({ items: items('one') });
    const second = request({ items: items('two', 'three') });
    await vi.waitFor(() => expect(providers.calls).toHaveLength(2));
    pairs[0]?.breakConnection();
    expect(await first.outcome).toMatchObject({
      status: 'error',
      error: { code: 'network/port-disconnected' },
    });
    expect(await second.outcome).toMatchObject({ status: 'error' });
    await vi.waitFor(() => expect(providers.aborts()).toBe(2));
    await vi.waitFor(() => expect(service.scheduler.inspect().active.mt).toBe(0));
  });

  it('rejects oversized payloads', async () => {
    const { providers, run } = setup();
    const tooMany = await run({
      items: Array.from({ length: 201 }, (_, i) => ({ id: `${i}`, text: 'x' })),
    });
    expect(tooMany.outcome).toMatchObject({
      status: 'error',
      error: { code: 'validation/payload-too-large' },
    });
    const tooLong = await run({ items: [{ id: 'a', text: 'x'.repeat(50_001) }] });
    expect(tooLong.outcome).toMatchObject({
      status: 'error',
      error: { code: 'validation/payload-too-large' },
    });
    expect(providers.calls).toHaveLength(0);
  });

  it('uses a different cache key after switching the engine', async () => {
    const { providers, config, cache, run } = setup();
    await run({ items: items('Hello') });
    await cached(cache, 1);
    config.translation.engine = 'openai';
    const result = await run({ items: items('Hello') });
    expect(result.byId.i0).toEqual({
      id: 'i0',
      text: 'O:Hello',
      disposition: 'translated',
      cached: false,
    });
    expect(providers.calls.map((call) => new URL(call.url).hostname)).toEqual([
      'translate.googleapis.com',
      'api.openai.com',
    ]);
  });

  it('ends an unanswered segment with a timeout at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { providers, service, request } = setup();
    providers.handlers.google = hang;
    const handle = request({ items: items('Hello') });
    // Hashing and IndexedDB run on real time: wait for the submission before moving the clock.
    for (let i = 0; i < 1000 && providers.calls.length === 0; i += 1) await flush();
    expect(providers.calls).toHaveLength(1);
    // Header timeout at 15s, retry at 16s, segment deadline at 30s from submission.
    await vi.advanceTimersByTimeAsync(29_999);
    await flush();
    expect(handle.chunks).toEqual([]);
    expect(providers.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 1, failed: 1 } });
    expect(handle.chunks).toEqual([
      { id: 'i0', error: expect.objectContaining({ code: 'network/timeout' }) },
    ]);
    expect(providers.aborts()).toBe(2);
    expect(service.scheduler.inspect().segments).toBe(0);
  });

  it('reports a missing host permission for the custom endpoint without fetching', async () => {
    const denied = appError('config', 'config/permission-missing', 'denied');
    const { providers, config, run } = setup({ checkPermission: async () => fail(denied) });
    config.translation.engine = 'custom-aaaaaaaa';
    config.customProviders['custom-aaaaaaaa'] = {
      name: 'LLM',
      baseURL: 'https://llm.example.com/v1',
      model: 'm',
    };
    const result = await run({ items: items('Hello') });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 1, failed: 1 } });
    expect(result.byId.i0).toMatchObject({ error: { code: 'config/permission-missing' } });
    expect(providers.calls).toHaveLength(0);
  });
});

describe('translate service: endpoint checks', () => {
  const denyAll = vi.fn(async () => false);
  const realCheck = (engine: Parameters<typeof checkEngineEndpoint>[0], baseURL: string) =>
    checkEngineEndpoint(engine, baseURL, { contains: denyAll });

  it('rejects openai on a non-built-in https endpoint without the grant', async () => {
    const { providers, config, run } = setup({ checkPermission: realCheck });
    config.translation.engine = 'openai';
    config.providers.openai.baseURL = 'https://proxy.example.com/v1';
    const result = await run({ items: items('Hello'), source: 'en' });
    expect(result.byId.i0).toMatchObject({ error: { code: 'config/permission-missing' } });
    expect(providers.calls).toHaveLength(0);
  });

  it('rejects openai on plain http to a non-local host', async () => {
    const { providers, config, run } = setup({ checkPermission: realCheck });
    config.translation.engine = 'openai';
    config.providers.openai.baseURL = 'http://proxy.example.com/v1';
    const result = await run({ items: items('Hello'), source: 'en' });
    expect(result.byId.i0).toMatchObject({ error: { code: 'config/invalid-base-url' } });
    expect(providers.calls).toHaveLength(0);
  });

  it('lets built-in endpoints through without asking for a grant', async () => {
    denyAll.mockClear();
    const { providers, config, run } = setup({ checkPermission: realCheck });
    config.translation.engine = 'openai';
    const result = await run({ items: items('Hello'), source: 'en' });
    expect(result.byId.i0).toMatchObject({ text: 'O:Hello' });
    expect(providers.calls).toHaveLength(1);
    expect(denyAll).not.toHaveBeenCalled();
  });
});

describe('translate service: per-port limit and cooldown scope', () => {
  it('rejects a ninth in-flight request on the same port with port-busy', async () => {
    const { providers, run, request } = setup();
    /** Texts whose fetch hangs, in the order the scheduler started them. */
    const started: string[] = [];
    providers.handlers.google = (texts, call) => {
      if (!texts.some((text) => text.startsWith('hang'))) return googleOk(texts, call);
      started.push(...texts);
      return hang(texts, call);
    };
    // Finished and failed requests free their slot.
    for (let i = 0; i < 8; i += 1) await run({ items: items(`done${i}`) });
    for (let i = 0; i < 8; i += 1) {
      expect((await run({ items: [{ id: 'x', text: 1 as never }] })).outcome).toMatchObject({
        status: 'error',
      });
    }
    const hanging = Array.from({ length: 8 }, (_, i) => request({ items: items(`hang${i}`) }));
    // Six run at once (the mt concurrency); the other two wait in the queue.
    await vi.waitFor(() => expect(started).toHaveLength(6));
    const callsBefore = providers.calls.length;
    const busy = await run({ items: items('extra') });
    expect(busy.outcome).toMatchObject({
      status: 'error',
      error: { code: 'rate-limit/port-busy', retryable: true },
    });
    expect(providers.calls).toHaveLength(callsBefore);
    // A cancelled request frees its slot as well. Requests reach the scheduler in
    // no fixed order (async hashing and cache reads), so cancel one whose fetch is
    // running: cancelling a queued one has no fetch to abort.
    const running = hanging[Number(started[0]?.slice('hang'.length))];
    running?.cancel();
    expect(await running?.outcome).toEqual({ status: 'cancelled' });
    await vi.waitFor(() => expect(providers.aborts()).toBe(1));
    await flush();
    const after = request({ items: items('after') });
    for (const handle of hanging) if (handle !== running) handle.cancel();
    expect(await after.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(after.chunks).toEqual([
      { id: 'i0', text: 'G:after', disposition: 'translated', cached: false },
    ]);
  });

  it('scopes cooldowns by engine and endpoint origin', async () => {
    const { service, config, run } = setup();
    const submit = vi.spyOn(service.scheduler, 'submit');
    await run({ items: items('Hello') });
    config.translation.engine = 'openai';
    await run({ items: items('Hello'), source: 'en' });
    expect(submit.mock.calls.map((call) => call[0].cooldownKey)).toEqual([
      'google',
      'openai|https://api.openai.com',
    ]);
  });
});

describe('translate service: preprocessing and results', () => {
  it('strips zero-width characters before translating', async () => {
    const { run } = setup();
    const result = await run({ items: items('​Hello﻿ ') });
    expect(result.byId.i0).toMatchObject({ text: 'G:Hello', disposition: 'translated' });
  });

  it('returns blank items unchanged without a request', async () => {
    const { providers, run } = setup();
    const result = await run({ items: items(' ​‌ ', '') });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(result.byId.i0).toEqual({
      id: 'i0',
      text: ' ​‌ ',
      disposition: 'unchanged',
      cached: false,
    });
    expect(result.byId.i1).toMatchObject({ disposition: 'unchanged' });
    expect(providers.calls).toHaveLength(0);
  });

  it('reports an empty translation as an error and does not cache it', async () => {
    const { providers, cache, run } = setup();
    providers.handlers.google = (texts) =>
      jsonResponse(texts.map((text) => [text === 'Empty' ? '  ' : `G:${text}`, 'en']));
    const result = await run({ items: items('Fine', 'Empty') });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 2, failed: 1 } });
    expect(result.byId.i1).toMatchObject({ error: { code: 'validation/empty-translation' } });
    await cached(cache, 1);
    const again = await run({ items: items('Empty') });
    expect(again.byId.i0).toMatchObject({ error: { code: 'validation/empty-translation' } });
    expect(providers.calls).toHaveLength(2);
  });

  it('marks a translation equal to the source as unchanged and caches it', async () => {
    const { providers, cache, run } = setup();
    providers.handlers.google = (texts) =>
      jsonResponse(texts.map((text) => [` ${text.toLowerCase()} `, 'en']));
    const result = await run({ items: items('GitHub  API') });
    expect(result.byId.i0).toMatchObject({ disposition: 'unchanged', cached: false });
    await cached(cache, 1);
    const again = await run({ items: items('GitHub  API') });
    expect(again.byId.i0).toMatchObject({ disposition: 'unchanged', cached: true });
  });

  it('translates text with a lone surrogate through the Google single fallback', async () => {
    const { providers, run } = setup();
    providers.handlers.google = () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await run({ items: items('Hello \uD800world') });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(result.byId.i0).toMatchObject({ text: 'S:Hello \uFFFDworld' });
    expect(providers.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('falls back to the per-item Google endpoint on a network error', async () => {
    const { providers, run } = setup();
    providers.handlers.google = () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await run({ items: items('Hello', 'World') });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(result.byId.i0).toMatchObject({ text: 'S:Hello' });
    expect(result.byId.i1).toMatchObject({ text: 'S:World' });
    expect(providers.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /translate_a/t',
      'GET /translate_a/single',
      'GET /translate_a/single',
    ]);
  });
});

// ------------------------------------------------------------ cache keys and request params

/** The cache keys a request looks up, for a config; nothing is fetched. */
async function lookedUpKeys(config: ConfigV1, payload: Partial<TranslateRequest> = {}) {
  const keys: string[] = [];
  const service = createTranslateService({
    getConfig: async () => structuredClone(config),
    secrets: { get: async () => 'k' },
    cache: {
      ...createTranslationCache({ open: () => openCacheDb(`service-${dbSeq++}`) }),
      getMany: async (wanted) => {
        keys.push(...wanted);
        throw new Error('stop after the lookup');
      },
    },
    fetch: (async () => {
      throw new Error('no fetch');
    }) as unknown as typeof fetch,
    detectLanguage: async () => ({ isReliable: false, languages: [] }),
    checkPermission: async () => ok(undefined),
  });
  await service
    .translate(
      { items: [{ id: 'a', text: 'Hello' }], ...payload } as TranslateRequest,
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        caller: 'c',
      } as never,
    )
    .catch(() => undefined);
  expect(keys).toHaveLength(1);
  return keys[0];
}

function keyConfig(engine: ConfigV1['translation']['engine']): ConfigV1 {
  const config = createDefaultConfig('zh-CN');
  config.translation.engine = engine;
  config.providers.gemini.model = 'gemini-2.5-flash';
  config.customProviders['custom-aaaaaaaa'] = {
    name: 'A',
    baseURL: 'http://localhost:11434/v1',
    model: 'q',
  };
  return config;
}

describe('translate service: cache keys of request params (M4-A)', () => {
  // Captured from the code before M4-A (main 1712d02), same config and request: the
  // defaults (now lowest thinking for OpenAI and Gemini) must keep every existing key.
  const BEFORE = {
    openai: 'v1:be11acccab02adc2b3f02f060c4d3c886836805a6e732b1dc2cd2329f6475877',
    openaiStream: 'v1:43bf751643cd851f04ccf27221de11344419495d7348bb4f58a59e5d202e547d',
    deepseek: 'v1:db626260440bcbe1bd6bd4d2f56436ff0bf53ac695e8cf772bd0187932bd8af8',
    gemini: 'v1:829ced55fd7e638bc2991e538466ba238ba005e0e09fbaad3da39880bfbacaae',
    custom: 'v1:ffc1e58c8041a2a21301b5b8fc0890a9a2405597ec5e8363066db6cde0ff0f31',
  };

  it('keeps the exact cache key of every default request', async () => {
    expect(await lookedUpKeys(keyConfig('openai'))).toBe(BEFORE.openai);
    expect(await lookedUpKeys(keyConfig('openai'), { stream: true })).toBe(BEFORE.openaiStream);
    expect(await lookedUpKeys(keyConfig('deepseek'))).toBe(BEFORE.deepseek);
    expect(await lookedUpKeys(keyConfig('gemini'))).toBe(BEFORE.gemini);
    expect(await lookedUpKeys(keyConfig('custom-aaaaaaaa'))).toBe(BEFORE.custom);
  });

  it('keys thinking apart only when it changes the request', async () => {
    for (const engine of ['openai', 'deepseek', 'gemini'] as const) {
      const config = keyConfig(engine);
      config.providers[engine].thinking = true;
      const on = await lookedUpKeys(config);
      expect(on).not.toBe(BEFORE[engine]);
    }
    // Not in the rule table, or a proxy: the request is the same either way.
    const unknown = keyConfig('openai');
    unknown.providers.openai.model = 'gpt-4o';
    const off = await lookedUpKeys(unknown);
    unknown.providers.openai.thinking = true;
    expect(await lookedUpKeys(unknown)).toBe(off);
    const proxy = keyConfig('openai');
    proxy.providers.openai.baseURL = 'https://proxy.example.com/v1';
    const proxyOff = await lookedUpKeys(proxy);
    proxy.providers.openai.thinking = true;
    expect(await lookedUpKeys(proxy)).toBe(proxyOff);
    const old = keyConfig('gemini');
    old.providers.gemini.model = 'gemini-2.0-flash';
    const oldOff = await lookedUpKeys(old);
    old.providers.gemini.thinking = true;
    expect(await lookedUpKeys(old)).toBe(oldOff);
  });

  it('keys extra fields by their parsed value, and ignores empty or invalid ones', async () => {
    const withExtra = (text: string) => {
      const config = keyConfig('custom-aaaaaaaa');
      config.customProviders['custom-aaaaaaaa'] = {
        name: 'A',
        baseURL: 'http://localhost:11434/v1',
        model: 'q',
        extraBody: text,
      };
      return lookedUpKeys(config);
    };
    for (const text of ['', '  ', '{}', '{ }', '[1]', '{oops']) {
      expect(await withExtra(text)).toBe(BEFORE.custom);
    }
    const compact = await withExtra('{"think":false,"top_k":5}');
    expect(compact).not.toBe(BEFORE.custom);
    expect(await withExtra('{\n  "top_k": 5,\n  "think": false\n}')).toBe(compact);
    expect(await withExtra('{"think":true,"top_k":5}')).not.toBe(compact);

    const openai = keyConfig('openai');
    openai.providers.openai.extraBody = '{"service_tier": "flex"}';
    expect(await lookedUpKeys(openai)).not.toBe(BEFORE.openai);
  });

  it('sends the lowest thinking and the extra fields with the request', async () => {
    const { providers, config, run } = setup();
    config.translation.engine = 'openai';
    config.providers.openai.model = 'gpt-5-mini';
    config.providers.openai.extraBody = '{"service_tier": "flex"}';
    await run({ items: items('Hello') });
    const init = (providers.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      reasoning_effort: 'minimal',
      service_tier: 'flex',
      model: 'gpt-5-mini',
      stream: true,
    });
  });
});

describe('translate service: translation styles (M4-B)', () => {
  // The same keys as before M4-B (locked in the M4-A block above): general adds nothing.
  const GENERAL = {
    openai: 'v1:be11acccab02adc2b3f02f060c4d3c886836805a6e732b1dc2cd2329f6475877',
    openaiStream: 'v1:43bf751643cd851f04ccf27221de11344419495d7348bb4f58a59e5d202e547d',
    custom: 'v1:ffc1e58c8041a2a21301b5b8fc0890a9a2405597ec5e8363066db6cde0ff0f31',
  };
  const styled = (
    engine: ConfigV1['translation']['engine'],
    style: ConfigV1['translation']['style'],
  ) => {
    const config = keyConfig(engine);
    config.translation.style = style;
    config.customStyles['style-aaaaaaaa'] = { name: 'Short', description: 'Use short sentences.' };
    return config;
  };

  it('keeps every key of the general style', async () => {
    expect(await lookedUpKeys(styled('openai', 'general'))).toBe(GENERAL.openai);
    expect(await lookedUpKeys(styled('openai', 'general'), { stream: true })).toBe(
      GENERAL.openaiStream,
    );
    expect(await lookedUpKeys(styled('custom-aaaaaaaa', 'general'))).toBe(GENERAL.custom);
  });

  it('keys each style apart, for page and stream requests', async () => {
    for (const stream of [false, true]) {
      const payload = stream ? { stream: true as const } : {};
      const general = await lookedUpKeys(styled('openai', 'general'), payload);
      const tech = await lookedUpKeys(styled('openai', 'tech'), payload);
      const literary = await lookedUpKeys(styled('openai', 'literary'), payload);
      const custom = await lookedUpKeys(styled('openai', 'style-aaaaaaaa'), payload);
      expect(new Set([general, tech, literary, custom]).size).toBe(4);
      // The same style keeps its key.
      expect(await lookedUpKeys(styled('openai', 'tech'), payload)).toBe(tech);
    }
  });

  it('changes the key of a custom style when its description changes', async () => {
    const before = await lookedUpKeys(styled('openai', 'style-aaaaaaaa'));
    const edited = styled('openai', 'style-aaaaaaaa');
    edited.customStyles['style-aaaaaaaa'] = { name: 'Short', description: 'Be terse.' };
    expect(await lookedUpKeys(edited)).not.toBe(before);
    // The name is never sent, so renaming keeps the key.
    const renamed = styled('openai', 'style-aaaaaaaa');
    renamed.customStyles['style-aaaaaaaa'] = { name: 'Other', description: 'Use short sentences.' };
    expect(await lookedUpKeys(renamed)).toBe(before);
  });

  it('falls back to the general prompt when the chosen custom style is gone', async () => {
    const config = styled('openai', 'style-aaaaaaaa');
    config.customStyles = {};
    expect(await lookedUpKeys(config)).toBe(GENERAL.openai);
    const blank = styled('openai', 'style-aaaaaaaa');
    blank.customStyles['style-aaaaaaaa'] = { name: 'Blank', description: '  ' };
    expect(await lookedUpKeys(blank)).toBe(GENERAL.openai);
  });

  it('leaves Google alone: same key, and the style is never read', async () => {
    const general = await lookedUpKeys(styled('google', 'general'));
    expect(await lookedUpKeys(styled('google', 'tech'))).toBe(general);
    expect(await lookedUpKeys(styled('google', 'style-aaaaaaaa'))).toBe(general);
    // A record resolveStyle would throw on (Object.hasOwn(null)): Google never resolves it.
    const unreadable = styled('google', 'style-aaaaaaaa');
    unreadable.customStyles = null as never;
    expect(await lookedUpKeys(unreadable)).toBe(general);
  });

  it('sends the style line right after the task line', async () => {
    const { providers, config, run } = setup();
    config.translation.engine = 'openai';
    config.translation.style = 'tech';
    await run({ items: items('Hello') });
    const init = (providers.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const lines = body.messages[0]?.content.split('\n') ?? [];
    expect(lines[0]).toContain('You are a professional translation engine.');
    expect(lines[1]).toMatch(/^Style: technical documentation\./);
  });
});

describe('cooldownKeyFor', () => {
  it('scopes by engine family and origin, so custom providers on one server share it', () => {
    expect(cooldownKeyFor('google', '')).toBe('google');
    expect(cooldownKeyFor('openai', 'https://api.openai.com/v1')).toBe(
      'openai|https://api.openai.com',
    );
    const a = cooldownKeyFor('custom-aaaaaaaa', 'http://localhost:11434/v1');
    expect(a).toBe('custom|http://localhost:11434');
    expect(cooldownKeyFor('custom-bbbbbbbb', 'http://localhost:11434/v2')).toBe(a);
  });
});

// ------------------------------------------------------------ stream requests

describe('translate service: stream requests', () => {
  const zhDetect: DetectLanguage = async (text) => ({
    isReliable: true,
    languages: [{ language: /[一-鿿]/.test(text) ? 'zh' : 'en', percentage: 99 }],
  });

  it('accepts stream and force only as `true`, and stream only for a single item', () => {
    const one = [{ id: 'a', text: 'x' }];
    expect(parseTranslateRequest({ items: one, stream: true, force: true })).toMatchObject({
      stream: true,
      force: true,
    });
    for (const payload of [
      { items: [...one, { id: 'b', text: 'y' }], stream: true },
      { items: [], stream: true },
      { items: one, stream: 1 },
      { items: one, force: 'yes' },
    ]) {
      expect(() => parseTranslateRequest(payload)).toThrow(
        expect.objectContaining({ code: 'validation/invalid-payload' }),
      );
    }
  });

  it('fails a multi-item stream request over the port without fetching', async () => {
    const { providers, run } = setup();
    const result = await run({ items: items('Hello', 'World'), stream: true });
    expect(result.outcome).toMatchObject({
      status: 'error',
      error: { code: 'validation/invalid-payload' },
    });
    expect(providers.calls).toHaveLength(0);
  });

  it('streams reset and delta chunks from the LLM, then the final chunk', async () => {
    const { config, run } = setup();
    config.translation.engine = 'openai';
    const result = await run({ items: items('Hello'), stream: true });
    expect(result.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(result.chunks).toEqual([
      { id: 'i0', reset: true },
      { id: 'i0', delta: '流:' },
      { id: 'i0', delta: 'Hello' },
      { id: 'i0', text: '流:Hello', disposition: 'translated', cached: false },
    ]);
  });

  it('sends a reset before the retry, so increments are never repeated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { config, providers, request } = setup();
    config.translation.engine = 'openai';
    let attempt = 0;
    providers.handlers.openaiText = (text) => {
      attempt += 1;
      if (attempt === 1) return sseResponse([openaiDelta('半截')], new Error('reset'));
      return openaiTextOk(text, {} as FetchCall);
    };
    const handle = request({ items: items('Hello'), stream: true });
    for (let i = 0; i < 1000 && handle.chunks.length < 2; i += 1) await flush();
    expect(handle.chunks).toEqual([
      { id: 'i0', reset: true },
      { id: 'i0', delta: '半截' },
    ]);
    // Retry after 1s (no jitter).
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 1000 && handle.chunks.length < 6; i += 1) await flush();
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(handle.chunks.slice(2)).toEqual([
      { id: 'i0', reset: true },
      { id: 'i0', delta: '流:' },
      { id: 'i0', delta: 'Hello' },
      { id: 'i0', text: '流:Hello', disposition: 'translated', cached: false },
    ]);
  });

  it('answers a cache hit with the final chunk only', async () => {
    const { config, cache, providers, run } = setup();
    config.translation.engine = 'openai';
    await run({ items: items('Hello'), stream: true });
    await cached(cache, 1);
    const second = await run({ items: items('Hello'), stream: true });
    expect(second.chunks).toEqual([
      { id: 'i0', text: '流:Hello', disposition: 'translated', cached: true },
    ]);
    expect(providers.calls).toHaveLength(1);
  });

  it('caches stream (text) and page (batch) LLM translations apart', async () => {
    const { config, cache, providers, run } = setup();
    config.translation.engine = 'openai';
    await run({ items: items('Hello') });
    await cached(cache, 1);
    const streamed = await run({ items: items('Hello'), stream: true });
    expect(streamed.chunks.at(-1)).toMatchObject({ text: '流:Hello', cached: false });
    expect(providers.calls).toHaveLength(2);
  });

  it('sends no delta for Google', async () => {
    const { run } = setup();
    const result = await run({ items: items('Hello'), stream: true });
    expect(result.chunks.some((chunk) => 'delta' in chunk)).toBe(false);
    expect(result.chunks.at(-1)).toEqual({
      id: 'i0',
      text: 'G:Hello',
      disposition: 'translated',
      cached: false,
    });
  });

  it('still reports same-language and unchanged results on a stream request', async () => {
    const { detect, providers, run } = setup();
    detect.mockImplementation(zhDetect);
    const same = await run({ items: items('这是一段已经是中文的文字内容'), stream: true });
    expect(same.chunks).toEqual([
      {
        id: 'i0',
        text: '这是一段已经是中文的文字内容',
        disposition: 'same-language',
        cached: false,
      },
    ]);
    providers.handlers.google = (texts) => jsonResponse(texts.map((text) => [text, 'en']));
    const unchanged = await run({ items: items('GitHub API'), stream: true });
    expect(unchanged.chunks.at(-1)).toMatchObject({ text: 'GitHub API', disposition: 'unchanged' });
  });

  it('skips the same-language check with force and returns a translation', async () => {
    const { detect, providers, run } = setup();
    detect.mockImplementation(zhDetect);
    const result = await run({
      items: items('这是一段已经是中文的文字内容'),
      stream: true,
      force: true,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(providers.calls).toHaveLength(1);
    expect(result.chunks.at(-1)).toEqual({
      id: 'i0',
      text: 'G:这是一段已经是中文的文字内容',
      disposition: 'translated',
      cached: false,
    });
  });

  it.each([
    ['google', false],
    ['openai', true],
  ] as const)(
    'looks a selected word up under its own key and text, not its paragraph (%s)',
    async (engine, streamWord) => {
      const { config, cache, providers, run } = setup();
      config.translation.engine = engine;
      const getMany = vi.spyOn(cache, 'getMany');
      // Under the echo threshold (see echo.ts), so the fake "G:" answer is cached.
      const paragraph = 'The quick brown fox.';
      await run({ items: items(paragraph) });
      await cached(cache, 1);
      const word = await run({ items: items('fox'), stream: streamWord || undefined, force: true });
      const [paragraphKeys, wordKeys] = getMany.mock.calls.map(([keys]) => keys);
      expect(paragraphKeys).toHaveLength(1);
      expect(wordKeys).toHaveLength(1);
      expect(wordKeys?.[0]).not.toBe(paragraphKeys?.[0]);
      expect(providers.sent).toEqual([paragraph, 'fox']);
      expect(word.chunks.at(-1)).toMatchObject({ cached: false, disposition: 'translated' });
    },
  );
});

// ------------------------------------------------------------ phonetic requests

describe('translate service: phonetic', () => {
  /** A lookup the test answers by hand. */
  function deferredLookup() {
    const calls: string[] = [];
    let answer: (hit: PhoneticHit | undefined) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const lookupPhonetic = vi.fn(
      (text: string) =>
        new Promise<PhoneticHit | undefined>((resolve, reject) => {
          calls.push(text);
          answer = resolve;
          fail = reject;
        }),
    );
    return {
      lookupPhonetic,
      calls,
      answer: (hit: PhoneticHit | undefined) => answer(hit),
      fail: (error: Error) => fail(error),
    };
  }

  it('accepts phonetic only as `true`, and drops it for a batch without failing', () => {
    const one = [{ id: 'a', text: 'word' }];
    expect(parseTranslateRequest({ items: one, phonetic: true }).phonetic).toBe(true);
    const batch = parseTranslateRequest({
      items: [...one, { id: 'b', text: 'other' }],
      phonetic: true,
    });
    expect(batch.phonetic).toBeUndefined();
    expect(() => parseTranslateRequest({ items: one, phonetic: 'yes' })).toThrow(
      expect.objectContaining({ code: 'validation/invalid-payload' }),
    );
  });

  it('sends the phonetic chunk alongside the translation, before the request ends', async () => {
    const lookup = deferredLookup();
    const { request } = setup({ lookupPhonetic: lookup.lookupPhonetic });
    const handle = request({ items: items('Hello'), phonetic: true });
    // The translation does not wait for the lookup …
    await vi.waitFor(() =>
      expect(handle.chunks).toContainEqual(expect.objectContaining({ text: 'G:Hello' })),
    );
    expect(lookup.calls).toEqual(['Hello']);
    let settled = false;
    void handle.outcome.then(() => {
      settled = true;
    });
    await flush();
    // … but the request does not end before it.
    expect(settled).toBe(false);
    lookup.answer({ uk: 'həˈləʊ', us: 'həˈloʊ' });
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(handle.chunks.at(-1)).toEqual({ id: 'i0', phonetic: { uk: 'həˈləʊ', us: 'həˈloʊ' } });
  });

  it('passes the headword on with its readings, and sends one accent alone', async () => {
    const { run } = setup({ lookupPhonetic: async () => ({ uk: 'ˈæbsənt', lemma: 'absent' }) });
    const result = await run({ items: items('absented'), phonetic: true, stream: true });
    expect(result.chunks).toContainEqual({
      id: 'i0',
      phonetic: { uk: 'ˈæbsənt' },
      lemma: 'absent',
    });
    const us = await setup({ lookupPhonetic: async () => ({ us: 'ˈpaɪθɑːn' }) }).run({
      items: items('python'),
      phonetic: true,
    });
    expect(us.chunks).toContainEqual({ id: 'i0', phonetic: { us: 'ˈpaɪθɑːn' } });
  });

  it('sends nothing for a hit with neither accent', async () => {
    const { run } = setup({ lookupPhonetic: async () => ({ lemma: 'x' }) });
    const result = await run({ items: items('Hello'), phonetic: true });
    expect(result.chunks.some((chunk) => 'phonetic' in chunk)).toBe(false);
  });

  it('looks nothing up without the flag, for a batch, or for text that is not one word', async () => {
    const lookupPhonetic = vi.fn(async (): Promise<PhoneticHit> => ({ uk: 'x' }));
    const { run } = setup({ lookupPhonetic });
    await run({ items: items('Hello') });
    await run({ items: items('Hello', 'World'), phonetic: true });
    for (const text of ['hello world', 'café', 'x2', 'a'.repeat(41)]) {
      const result = await run({ items: items(text), phonetic: true });
      expect(result.chunks.some((chunk) => 'phonetic' in chunk)).toBe(false);
    }
    expect(lookupPhonetic).not.toHaveBeenCalled();
  });

  it('sends nothing when the word is unknown or the lookup fails, and still translates', async () => {
    const lookup = deferredLookup();
    const { request } = setup({ lookupPhonetic: lookup.lookupPhonetic });
    const missing = request({ items: items('Hello'), phonetic: true });
    await vi.waitFor(() => expect(lookup.calls).toHaveLength(1));
    lookup.answer(undefined);
    expect(await missing.outcome).toMatchObject({ status: 'done' });
    const failing = request({ items: items('World'), phonetic: true });
    await vi.waitFor(() => expect(lookup.calls).toHaveLength(2));
    lookup.fail(new Error('boom'));
    expect(await failing.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    for (const handle of [missing, failing]) {
      expect(handle.chunks).toHaveLength(1);
      expect(handle.chunks[0]).toMatchObject({ disposition: 'translated' });
    }
  });

  it('still sends the phonetic on a cache hit, and keeps the flag out of the cache key', async () => {
    const lookupPhonetic = vi.fn(async (): Promise<PhoneticHit> => ({ uk: 'ˈhjuːmən' }));
    const { cache, providers, run } = setup({ lookupPhonetic });
    await run({ items: items('Human') });
    await cached(cache, 1);
    const hit = await run({ items: items('Human'), phonetic: true });
    expect(providers.calls).toHaveLength(1);
    expect(hit.chunks).toHaveLength(2);
    expect(hit.chunks).toEqual(
      expect.arrayContaining([
        { id: 'i0', text: 'G:Human', disposition: 'translated', cached: true },
        { id: 'i0', phonetic: { uk: 'ˈhjuːmən' } },
      ]),
    );
  });

  it('sends nothing once the request was aborted', async () => {
    const lookup = deferredLookup();
    const { service, providers } = setup({ lookupPhonetic: lookup.lookupPhonetic });
    providers.handlers.google = hang;
    const controller = new AbortController();
    const emit = vi.fn();
    const pending = service
      .translate({ items: items('Hello'), phonetic: true }, { signal: controller.signal, emit })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(lookup.calls).toHaveLength(1));
    controller.abort();
    lookup.answer({ uk: 'həˈləʊ' });
    expect(await pending).toMatchObject({ code: 'network/aborted' });
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ revoked translations

describe('translate service: revoked translations', () => {
  /** A scheduler whose items all come back at once, sharing one verdict the test decides. */
  function verdictScheduler(text: (source: string) => string = (source) => `F:${source}`) {
    let decide: (keep: boolean) => void = () => undefined;
    const verdict = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const scheduler: Scheduler = {
      submit: (request) =>
        request.segments.map((segment) =>
          Promise.resolve<ItemOutcome>({ ok: true, text: text(segment.text), verdict }),
        ),
      inspect: () => ({
        active: { mt: 0, llm: 0 },
        queued: 0,
        waiting: 0,
        segments: 0,
        callers: 0,
      }),
    };
    return { scheduler, decide };
  }

  function llmSetup(scheduler: Scheduler) {
    const t = setup({ scheduler });
    t.config.translation.engine = 'openai';
    return t;
  }

  /** Whether the promise is still pending after the queued work has run. */
  async function pending(promise: Promise<unknown>) {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    return !settled;
  }

  it('sends the translation, then the revocation, then done', async () => {
    const { scheduler, decide } = verdictScheduler();
    const { request } = llmSetup(scheduler);
    const handle = request({ items: items('Hello', 'World'), source: 'en' });
    await vi.waitFor(() => expect(handle.chunks).toHaveLength(2));
    expect(await pending(handle.outcome)).toBe(true);
    decide(false);
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(handle.chunks).toEqual([
      { id: 'i0', text: 'F:Hello', disposition: 'translated', cached: false },
      { id: 'i1', text: 'F:World', disposition: 'translated', cached: false },
      { id: 'i0', revoked: 'F:Hello' },
      { id: 'i1', revoked: 'F:World' },
    ]);
  });

  it('sends no revocation for a translation that is kept', async () => {
    const { scheduler, decide } = verdictScheduler();
    const { request } = llmSetup(scheduler);
    const handle = request({ items: items('Hello'), source: 'en' });
    await vi.waitFor(() => expect(handle.chunks).toHaveLength(1));
    decide(true);
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    expect(handle.chunks).toHaveLength(1);
  });

  it('sends no revocation for a result that is not a translation', async () => {
    const { scheduler, decide } = verdictScheduler((source) => source.toLowerCase());
    const { request } = llmSetup(scheduler);
    const handle = request({ items: items('GitHub'), source: 'en' });
    await vi.waitFor(() => expect(handle.chunks).toHaveLength(1));
    // Not waiting for the verdict: done comes at once.
    expect(await handle.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
    decide(false);
    await flush();
    expect(handle.chunks).toEqual([
      { id: 'i0', text: 'github', disposition: 'unchanged', cached: false },
    ]);
  });

  it('stops waiting for the verdict when the request is cancelled', async () => {
    const { scheduler } = verdictScheduler();
    const { service } = llmSetup(scheduler);
    const controller = new AbortController();
    const chunks: TranslateChunk[] = [];
    const translating = service.translate(
      { items: items('Hello'), source: 'en' },
      { signal: controller.signal, emit: (chunk) => chunks.push(chunk) },
    );
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(await pending(translating)).toBe(true);
    controller.abort();
    await expect(translating).rejects.toMatchObject({ code: 'network/aborted' });
    expect(chunks).toHaveLength(1);
  });

  it('stops waiting for the verdict when the port disconnects', async () => {
    const { scheduler } = verdictScheduler();
    const { service } = llmSetup(scheduler);
    const pair = createPortPair();
    const served: Promise<unknown>[] = [];
    servePort<TranslateRequest, TranslateChunk, TranslateDone>(pair.server, (payload, ctx) => {
      const translating = service.translate(payload, ctx);
      served.push(translating);
      return translating;
    });
    const client = createPortClient<TranslateRequest, TranslateChunk, TranslateDone>(
      () => pair.client,
    );
    const chunks: TranslateChunk[] = [];
    client.request({ items: items('Hello'), source: 'en' }, (chunk) => chunks.push(chunk));
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(served).toHaveLength(1);
    expect(await pending(served[0] as Promise<unknown>)).toBe(true);
    pair.breakConnection();
    expect(await pending(served[0] as Promise<unknown>)).toBe(false);
  });

  it('shows a misplaced batch, revokes it before done, and the items asked again go one by one', async () => {
    const { providers, config, cache, request, run } = setup();
    config.translation.engine = 'openai';
    let release: () => void = () => undefined;
    providers.handlers.openai = (texts, call) => {
      if (texts.length < 4) return openaiOk(texts, call);
      // The model skipped "one": the ids run on, every text one item off.
      const gated = gatedSseResponse(
        [openaiDelta('[{"i":0,"t":"O:two"},')],
        [openaiDelta('{"i":1,"t":"O:three"}]'), 'data: [DONE]\n\n'],
      );
      release = gated.release;
      return gated.response;
    };
    const first = request({ items: items('one', 'two', 'three', 'four'), source: 'en' });
    await vi.waitFor(() =>
      expect(first.chunks).toEqual([expect.objectContaining({ id: 'i0', text: 'O:two' })]),
    );
    release();
    expect(await first.outcome).toEqual({ status: 'done', data: { total: 4, failed: 0 } });
    expect(first.chunks.filter((chunk) => 'revoked' in chunk)).toEqual([
      { id: 'i0', revoked: 'O:two' },
      { id: 'i1', revoked: 'O:three' },
    ]);
    // The rest was halved and came back right.
    expect(first.chunks.slice(-2).map((chunk) => 'text' in chunk && chunk.text)).toEqual([
      'O:three',
      'O:four',
    ]);
    expect(providers.calls).toHaveLength(3);
    // The page asks again for what was revoked: each runs as a batch of its own.
    const again = await run({ items: items('one', 'two'), source: 'en' });
    expect(again.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
    expect(again.chunks).toEqual([
      { id: 'i0', text: 'O:one', disposition: 'translated', cached: false },
      { id: 'i1', text: 'O:two', disposition: 'translated', cached: false },
    ]);
    expect(providers.calls).toHaveLength(5);
    expect(providers.sent.slice(-2)).toEqual(['one', 'two']);
    await cached(cache, 4);
  });
});

// ------------------------------------------------------------ glossary (M4-C)

describe('translate service: glossary (M4-C)', () => {
  const GLOSSARY_LEAD = 'Glossary for this request, given as a JSON array';
  let termSeq = 0;
  const term = (source: string, fields: Partial<GlossaryEntry> = {}): GlossaryEntry => {
    termSeq += 1;
    return {
      id: `term-${String(termSeq).padStart(8, '0')}`,
      source,
      target: '',
      lang: '',
      caseSensitive: false,
      ...fields,
    };
  };
  const SONNET = term('Sonnet', { caseSensitive: true });
  const PR = term('pull request', { target: '拉取请求', lang: 'zh-CN' });
  const QWEN = term('通义千问', { target: 'Qwen', lang: 'en' });
  const HAIKU = term('Haiku');

  /** A service whose glossary is `glossary.entries` (replace the array to change it). */
  function withGlossary(entries: GlossaryEntry[]) {
    const glossary = { entries };
    const harness = setup({ getGlossary: async () => glossary.entries });
    return { ...harness, glossary };
  }

  /** Request bodies sent to the fake providers, in order. */
  const bodies = (providers: ReturnType<typeof createProviders>) =>
    (providers.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.map(
      ([url, init]) => ({ url, body: init?.body }),
    );
  const userMessages = (providers: ReturnType<typeof createProviders>) =>
    bodies(providers)
      .filter(({ url }) => url.endsWith('/chat/completions'))
      .map(
        ({ body }) =>
          (JSON.parse(String(body)) as { messages: { content: string }[] }).messages[1]?.content ??
          '',
      );

  /** The cache keys one request looks up; nothing is fetched. */
  async function keysFor(
    config: ConfigV1,
    entries: GlossaryEntry[],
    texts: string[],
    payload: Partial<TranslateRequest> = {},
  ) {
    const keys: string[] = [];
    const service = createTranslateService({
      getConfig: async () => structuredClone(config),
      secrets: { get: async () => 'k' },
      cache: {
        ...createTranslationCache({ open: () => openCacheDb(`service-${dbSeq++}`) }),
        getMany: async (wanted) => {
          keys.push(...wanted);
          throw new Error('stop after the lookup');
        },
      },
      fetch: (async () => {
        throw new Error('no fetch');
      }) as unknown as typeof fetch,
      detectLanguage: async () => ({ isReliable: false, languages: [] }),
      checkPermission: async () => ok(undefined),
      getGlossary: async () => entries,
    });
    await service
      .translate(
        {
          items: texts.map((text, index) => ({ id: `k${index}`, text })),
          ...payload,
        } as TranslateRequest,
        { signal: new AbortController().signal, emit: () => undefined, caller: 'c' } as never,
      )
      .catch(() => undefined);
    return keys;
  }

  describe('cache keys', () => {
    // The keys locked in the M4-A block: a glossary that finds nothing changes none of them.
    const BEFORE = {
      openai: 'v1:be11acccab02adc2b3f02f060c4d3c886836805a6e732b1dc2cd2329f6475877',
      openaiStream: 'v1:43bf751643cd851f04ccf27221de11344419495d7348bb4f58a59e5d202e547d',
      custom: 'v1:ffc1e58c8041a2a21301b5b8fc0890a9a2405597ec5e8363066db6cde0ff0f31',
    };

    it('keeps every locked key when no term is found', async () => {
      const entries = [SONNET, PR, HAIKU];
      expect(await keysFor(keyConfig('openai'), entries, ['Hello'])).toEqual([BEFORE.openai]);
      expect(await keysFor(keyConfig('openai'), entries, ['Hello'], { stream: true })).toEqual([
        BEFORE.openaiStream,
      ]);
      expect(await keysFor(keyConfig('custom-aaaaaaaa'), entries, ['Hello'])).toEqual([
        BEFORE.custom,
      ]);
      const google = await keysFor(keyConfig('google'), [], ['Hello']);
      expect(await keysFor(keyConfig('google'), entries, ['Hello'])).toEqual(google);
    });

    it('keys a segment with terms apart, by the terms found in it only', async () => {
      for (const engine of ['openai', 'google'] as const) {
        const config = keyConfig(engine);
        const text = 'Sonnet opened a pull request';
        const [plain] = await keysFor(config, [], [text]);
        const [keyed] = await keysFor(config, [SONNET, PR, HAIKU], [text]);
        expect(keyed).not.toBe(plain);
        // Stable, and blind to entries the segment does not hold or to their order.
        expect(await keysFor(config, [HAIKU, PR, SONNET], [text])).toEqual([keyed]);
        expect(
          await keysFor(config, [SONNET, PR, { ...HAIKU, target: 'x', lang: 'zh-CN' }], [text]),
        ).toEqual([keyed]);
        // Changing a term the segment holds changes its key.
        expect(await keysFor(config, [SONNET, { ...PR, target: '合并请求' }], [text])).not.toEqual([
          keyed,
        ]);
      }
    });
  });

  describe('AI engines', () => {
    it('sends segments without terms in their own request, exactly as before', async () => {
      const { providers, config, run } = withGlossary([SONNET, PR, HAIKU]);
      config.translation.engine = 'openai';
      const result = await run({ items: items('Hello', 'Sonnet opened a pull request') });
      expect(result.outcome).toEqual({ status: 'done', data: { total: 2, failed: 0 } });
      expect(result.byId.i0).toMatchObject({ text: 'O:Hello' });
      expect(result.byId.i1).toMatchObject({ text: 'O:Sonnet opened a pull request' });
      const users = userMessages(providers);
      expect(users).toHaveLength(2);
      expect(users).toContain('Translate this JSON array:\n[{"i":0,"t":"Hello"}]');
      const withTerms = users.find((user) => user.startsWith(GLOSSARY_LEAD)) ?? '';
      const lines = withTerms.split('\n');
      // Only the terms of this group, sorted by source: no Haiku.
      expect(JSON.parse(lines[1] ?? '')).toEqual([
        { source: 'Sonnet', target: '' },
        { source: 'pull request', target: '拉取请求' },
      ]);
      expect(lines.slice(2).join('\n')).toBe(
        'Translate this JSON array:\n[{"i":0,"t":"Sonnet opened a pull request"}]',
      );
    });

    it('sends the union of the terms of every segment of the group', async () => {
      const { providers, config, run } = withGlossary([SONNET, PR, HAIKU]);
      config.translation.engine = 'openai';
      await run({ items: items('Sonnet is here', 'a pull request too') });
      const users = userMessages(providers);
      expect(users).toHaveLength(1);
      expect(JSON.parse(users[0]?.split('\n')[1] ?? '')).toEqual([
        { source: 'Sonnet', target: '' },
        { source: 'pull request', target: '拉取请求' },
      ]);
    });

    it('puts the terms before the markers of a stream request', async () => {
      const { providers, config, run } = withGlossary([SONNET]);
      config.translation.engine = 'openai';
      const result = await run({ items: items('Sonnet streams'), stream: true });
      expect(result.byId.i0).toMatchObject({ text: '流:Sonnet streams' });
      const [user] = userMessages(providers);
      expect(user?.split('\n')[0]).toMatch(/^Glossary for this request/);
      expect(user?.split('\n')[2]).toMatch(/^-----BEGIN [0-9a-f]+-----$/);
    });
  });

  describe('Google', () => {
    it('sends terms as untranslated spans in HTML mode and fills them in', async () => {
      const { providers, run } = withGlossary([SONNET, PR]);
      const result = await run({ items: items('Sonnet opened a pull request') });
      expect(result.byId.i0).toEqual({
        id: 'i0',
        text: 'G:Sonnet opened a 拉取请求',
        disposition: 'translated',
        cached: false,
      });
      expect(providers.calls).toHaveLength(1);
      expect(providers.calls[0]?.url).toContain('&format=html');
      expect(providers.sent).toEqual([
        '<span translate="no" id="g0">Sonnet</span> opened a <span translate="no" id="g1">pull request</span>',
      ]);
    });

    it('adds the missing spaces for a spaced target, and keeps line breaks', async () => {
      const { providers, run } = withGlossary([QWEN, SONNET]);
      providers.handlers.google = (texts) =>
        jsonResponse(
          texts.map((text) => [
            text.includes('g0') && text.includes('通义千问')
              ? 'We used<span translate="no" id="g0">X</span>and it worked'
              : `G:${text.replace(/<br>/g, '<br> ')}`,
            'zh-CN',
          ]),
        );
      const english = await run({ items: items('我们用了通义千问，效果很好'), target: 'en' });
      expect(english.byId.i0).toMatchObject({ text: 'We used Qwen and it worked' });
      const lines = await run({ items: items('Sonnet\nsecond line') });
      expect(lines.byId.i0).toMatchObject({ text: 'G:Sonnet\nsecond line' });
      expect(providers.sent.at(-1)).toBe(
        '<span translate="no" id="g0">Sonnet</span><br>second line',
      );
    });

    it('caches the marked reply and fills it in again on a cache hit', async () => {
      const { providers, cache, run } = withGlossary([SONNET, PR]);
      // Short enough not to count as an echo of the source (echo.ts): the fake answers G:<source>.
      await run({ items: items('Sonnet: a pull request') });
      await cached(cache, 1);
      const second = await run({ items: items('Sonnet: a pull request') });
      expect(second.byId.i0).toEqual({
        id: 'i0',
        text: 'G:Sonnet: a 拉取请求',
        disposition: 'translated',
        cached: true,
      });
      expect(providers.calls).toHaveLength(1);
    });

    it('falls back without terms when the marks are lost: one request, not cached with terms', async () => {
      const { providers, cache, run } = withGlossary([SONNET]);
      // HTML mode drops every span; the plain endpoint answers as usual.
      providers.handlers.google = (texts, call) =>
        call.url.includes('format=html')
          ? jsonResponse(texts.map((text) => [`H:${text.replace(/<[^>]+>/g, '')}`, 'en']))
          : googleOk(texts, call);
      const result = await run({ items: items('Sonnet is good', 'Hello', 'Sonnet is fine') });
      expect(result.outcome).toEqual({ status: 'done', data: { total: 3, failed: 0 } });
      expect(result.byId.i0).toMatchObject({ text: 'G:Sonnet is good', cached: false });
      expect(result.byId.i2).toMatchObject({ text: 'G:Sonnet is fine', cached: false });
      expect(result.byId.i1).toMatchObject({ text: 'G:Hello' });
      // [Hello] and the marked pair go out together; the two fallbacks share one request.
      expect(providers.calls.map((call) => call.url.includes('format=html'))).toEqual([
        false,
        true,
        false,
      ]);
      expect(providers.sent.slice(-2)).toEqual(['Sonnet is good', 'Sonnet is fine']);
      // Hello and the two fallbacks, under keys without terms; nothing under a key with terms.
      await cached(cache, 3);
      await flush();
      expect((await cache.stats()).count).toBe(3);
    });

    it('asks again without terms when the HTML request fails over (403), so the words stay', async () => {
      const { providers, run } = withGlossary([SONNET]);
      // Every POST /t answers 403: plain mode then falls back to /single.
      providers.handlers.google = () => new Response('', { status: 403 });
      const result = await run({ items: items('Sonnet is good') });
      expect(result.outcome).toEqual({ status: 'done', data: { total: 1, failed: 0 } });
      expect(result.byId.i0).toMatchObject({ text: 'S:Sonnet is good', disposition: 'translated' });
      expect(providers.calls.map((call) => call.url.includes('format=html'))).toEqual([
        true,
        false,
        false,
      ]);
      expect(providers.calls[2]?.url).toContain('/translate_a/single?');
    });

    it('takes a fallback from the cache without terms first', async () => {
      const { providers, cache, glossary, run } = withGlossary([]);
      await run({ items: items('Sonnet is good') });
      await cached(cache, 1);
      glossary.entries = [SONNET];
      providers.handlers.google = (texts) =>
        jsonResponse(texts.map((text) => [`H:${text.replace(/<[^>]+>/g, '')}`, 'en']));
      const result = await run({ items: items('Sonnet is good') });
      expect(result.byId.i0).toMatchObject({ text: 'G:Sonnet is good', cached: true });
      expect(providers.calls).toHaveLength(2);
    });

    it('ends a request cancelled during the fallback as cancelled', async () => {
      const { providers, request } = withGlossary([SONNET]);
      providers.handlers.google = (texts, call) =>
        call.url.includes('format=html')
          ? jsonResponse(texts.map((text) => [`H:${text.replace(/<[^>]+>/g, '')}`, 'en']))
          : hang(texts, call);
      const handle = request({ items: items('Sonnet is good') });
      await vi.waitFor(() => expect(providers.calls).toHaveLength(2));
      handle.cancel();
      expect(await handle.outcome).toEqual({ status: 'cancelled' });
      await vi.waitFor(() => expect(providers.aborts()).toBe(1));
    });

    it('never marks a segment that already reads like a mark', async () => {
      const { providers, run } = withGlossary([SONNET]);
      const result = await run({ items: items('Sonnet uses <g0> tags') });
      expect(result.byId.i0).toMatchObject({ text: 'G:Sonnet uses <g0> tags' });
      expect(providers.calls[0]?.url).not.toContain('format=html');
    });
  });

  describe('segments that are only terms', () => {
    it.each(['google', 'openai'] as const)('answers them locally (%s)', async (engine) => {
      const { providers, config, cache, run } = withGlossary([SONNET, PR]);
      config.translation.engine = engine;
      const result = await run({ items: items('Sonnet', '<t0>pull request</t0>!', ' Sonnet · ') });
      expect(result.outcome).toEqual({ status: 'done', data: { total: 3, failed: 0 } });
      expect(result.byId.i0).toEqual({
        id: 'i0',
        text: 'Sonnet',
        disposition: 'unchanged',
        cached: false,
      });
      expect(result.byId.i1).toEqual({
        id: 'i1',
        text: '<t0>拉取请求</t0>!',
        disposition: 'translated',
        cached: false,
      });
      expect(result.byId.i2).toMatchObject({ text: 'Sonnet ·', disposition: 'unchanged' });
      expect(providers.calls).toHaveLength(0);
      await flush();
      expect((await cache.stats()).count).toBe(0);
    });
  });
});
