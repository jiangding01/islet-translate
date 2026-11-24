import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import { appError, fail, ok } from '@/lib/errors';
import { createPortClient, type PortLike, servePort } from '@/lib/messaging/port';
import type { TranslateChunk, TranslateDone, TranslateRequest } from '@/lib/messaging/protocol';
import type { PhoneticHit } from '@/lib/phonetic/lookup';
import { createTranslationCache, openCacheDb } from './cache';
import type { DetectLanguage } from './language';
import { checkEngineEndpoint } from './permissions';
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
/** The text between a text prompt's nonce markers, or undefined for a batch prompt. */
const TEXT_MARKERS = /^-----BEGIN ([0-9a-f]+)-----\n([\s\S]*)\n-----END \1-----$/;

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
      const items = JSON.parse(content.slice(content.indexOf('['))) as { i: number; t: string }[];
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
    // a good answer: docs/known-issues.md), but the batch is not cached; the rest is halved.
    expect(Object.values(result.byId).map((chunk) => 'text' in chunk && chunk.text)).toEqual([
      'only one',
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
