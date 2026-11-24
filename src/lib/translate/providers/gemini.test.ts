import { describe, expect, it } from 'vitest';
import {
  collect,
  collectSettled,
  gatedSseResponse,
  jsonResponse,
  makeCtx,
  mockFetch,
  sseResponse,
  stalledSseResponse,
  TEXT_PROMPT,
} from '../test-utils';
import { createGeminiAdapter } from './gemini';

const adapter = createGeminiAdapter();
const part = (text: string, extra = {}) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text, ...extra }] } }] })}\n\n`;
const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const OUTPUT = '[{"i":0,"t":"你好"}]';
const run = (fn: ReturnType<typeof mockFetch>, overrides = {}) =>
  collect(adapter.translate(['hello'], makeCtx({ fetch: fn, ...overrides })));

describe('gemini adapter', () => {
  it('builds the URL, key header, systemInstruction and contents', async () => {
    const fn = mockFetch(sseResponse([part(OUTPUT)]));
    const events = await run(fn, { settings: { baseURL: '', model: 'models/my-model' } });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/my-model:streamGenerateContent?alt=sse',
    );
    expect(url).not.toContain('sk-secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('sk-secret-key');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toContain('"t":"hello"');
    expect(events).toEqual([{ type: 'item', index: 0, text: '你好' }]);
  });

  it('accumulates text across chunks and skips thought parts', async () => {
    const fn = mockFetch(
      sseResponse([
        part('thinking...', { thought: true }),
        part(OUTPUT.slice(0, 8)),
        part(OUTPUT.slice(8)),
      ]),
    );
    expect(await run(fn)).toEqual([{ type: 'item', index: 0, text: '你好' }]);
  });

  it.each([
    [401, 'provider/unauthorized'],
    [403, 'provider/unauthorized'],
    [404, 'provider/not-found'],
    [429, 'rate-limit/too-many-requests'],
    [503, 'provider/server-error'],
  ])('maps HTTP %i', async (status, code) => {
    await expect(run(mockFetch(new Response('{}', { status })))).rejects.toMatchObject({ code });
  });

  it('maps a 400 invalid-key response to unauthorized', async () => {
    const fn = mockFetch(
      jsonResponse({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }, 400),
    );
    await expect(run(fn)).rejects.toMatchObject({ code: 'provider/unauthorized' });
  });

  it('requires a model', async () => {
    const fn = mockFetch();
    await expect(run(fn, { settings: { baseURL: '', model: '' } })).rejects.toMatchObject({
      code: 'config/model-required',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('maps promptFeedback.blockReason to content-blocked', async () => {
    const fn = mockFetch(sseResponse([chunk({ promptFeedback: { blockReason: 'SAFETY' } })]));
    await expect(run(fn)).rejects.toMatchObject({
      code: 'provider/content-blocked',
      retryable: false,
    });
  });

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])(
    'maps finishReason %s to content-blocked',
    async (finishReason) => {
      const fn = mockFetch(
        sseResponse([
          part(OUTPUT),
          chunk({ candidates: [{ content: { parts: [] }, finishReason }] }),
        ]),
      );
      await expect(run(fn)).rejects.toMatchObject({
        code: 'provider/content-blocked',
        retryable: false,
      });
    },
  );

  it('stops a runaway stream instead of accumulating without limit', async () => {
    const parts = Array.from({ length: 70 }, () =>
      chunk({ candidates: [{ content: { parts: [{ text: 'x'.repeat(1000) }] } }] }),
    );
    await expect(run(mockFetch(sseResponse(parts)))).rejects.toMatchObject({
      code: 'provider/output-truncated',
    });
  });

  it('maps finishReason MAX_TOKENS to output-truncated', async () => {
    const fn = mockFetch(
      sseResponse([
        chunk({
          candidates: [{ content: { parts: [{ text: '[{"i":0' }] }, finishReason: 'MAX_TOKENS' }],
        }),
      ]),
    );
    await expect(run(fn)).rejects.toMatchObject({
      code: 'provider/output-truncated',
      retryable: false,
    });
  });

  it('accepts finishReason STOP', async () => {
    const fn = mockFetch(
      sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: OUTPUT }] }, finishReason: 'STOP' }] }),
      ]),
    );
    expect(await run(fn)).toEqual([{ type: 'item', index: 0, text: '你好' }]);
  });

  it('maps an error object in the stream to server-error', async () => {
    const fn = mockFetch(sseResponse([part('[{"i":0'), chunk({ error: { code: 500 } })]));
    await expect(run(fn)).rejects.toMatchObject({ code: 'provider/server-error' });
  });
});

describe('gemini adapter: items as they complete', () => {
  const runBatch = (fn: ReturnType<typeof mockFetch>, overrides = {}) =>
    collectSettled(adapter.translate(['a', 'b', 'c'], makeCtx({ fetch: fn, ...overrides })));
  const item = (index: number, text: string) => ({ type: 'item', index, text });
  const code = (value: string) => expect.objectContaining({ code: value });
  const maxTokens = chunk({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });

  it('yields the first item before the stream ends', async () => {
    const { response, release } = gatedSseResponse(
      [part('[{"i":0,"t":"你好"},'), part('{"i":1,')],
      [part('"t":"世界"}]')],
    );
    const events = adapter.translate(['hello', 'world'], makeCtx({ fetch: mockFetch(response) }));
    const iterator = events[Symbol.asyncIterator]();
    // The rest is held back until release(): a late first item never resolves here.
    expect(await iterator.next()).toEqual({ done: false, value: item(0, '你好') });
    release();
    expect(await iterator.next()).toEqual({ done: false, value: item(1, '世界') });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('fills in the rest from the whole output, then fails with bad-response, when they differ', async () => {
    const raw =
      '[{"i":0,"t":"草稿"},{"i":1,"t":"b"}]</think>[{"i":0,"t":"终稿"},{"i":1,"t":"乙"},{"i":2,"t":"丙"}]';
    const result = await runBatch(mockFetch(sseResponse([part(raw)])));
    expect(result.events).toEqual([item(0, '草稿'), item(1, '乙'), item(2, '丙')]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  const CLEAN = [part('[{"i":0,"t":"甲"},'), part('{"i":1,"t":"乙"},{"i":2,"t":"丙')];
  const TAINTED = [part('[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]'), part('</think>[{"i":0,"t":"甲')];
  const ENDINGS: [string, (chunks: string[]) => Response, object, string][] = [
    [
      'MAX_TOKENS',
      (chunks) => sseResponse([...chunks, maxTokens]),
      {},
      'provider/output-truncated',
    ],
    [
      'a broken connection',
      (chunks) => sseResponse(chunks, new Error('reset')),
      {},
      'network/fetch-failed',
    ],
    [
      'an idle timeout',
      (chunks) => stalledSseResponse(chunks),
      { idleTimeoutMs: 20 },
      'network/timeout',
    ],
  ];

  it.each(ENDINGS)(
    'yields two items, then fails with %s as is',
    async (_name, reply, ctx, error) => {
      const result = await runBatch(mockFetch(reply(CLEAN)), ctx);
      expect(result.events).toEqual([item(0, '甲'), item(1, '乙')]);
      expect(result.error).toEqual(code(error));
    },
  );

  it.each(ENDINGS)('turns %s after a draft array into bad-response', async (_name, reply, ctx) => {
    const result = await runBatch(mockFetch(reply(TAINTED)), ctx);
    expect(result.events).toEqual([item(0, '甲'), item(1, '乙')]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  it('reports a stream that ends inside the array as output-truncated, a short array as bad-response', async () => {
    const open = await runBatch(mockFetch(sseResponse(CLEAN)));
    expect(open.events).toEqual([item(0, '甲'), item(1, '乙')]);
    expect(open.error).toEqual(code('provider/output-truncated'));
    const short = await runBatch(mockFetch(sseResponse([part('[{"i":0,"t":"甲"}]')])));
    expect(short.events).toEqual([item(0, '甲')]);
    expect(short.error).toEqual(code('validation/bad-response'));
  });
});

describe('gemini adapter: text format', () => {
  const runText = (fn: ReturnType<typeof mockFetch>, source = 'Hello') =>
    collect(adapter.translate([source], makeCtx({ fetch: fn, prompt: TEXT_PROMPT })));

  it('sends the text between nonce markers in systemInstruction and contents', async () => {
    const fn = mockFetch(sseResponse([part('你好')]), sseResponse([part('你好')]));
    await runText(fn);
    await runText(fn);
    const nonces = fn.mock.calls.map((call) => {
      const body = JSON.parse((call as unknown as [string, RequestInit])[1].body as string);
      const nonce = /^SYS ([0-9a-f]{16})$/.exec(body.systemInstruction.parts[0].text)?.[1];
      expect(body.contents[0].parts[0].text).toBe(`[${nonce}]\nHello\n[/${nonce}]`);
      return nonce;
    });
    expect(nonces[0]).toBeDefined();
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('yields deltas without thought parts, then the cleaned text', async () => {
    const fn = mockFetch(
      sseResponse([
        part('the user wants…', { thought: true }),
        part('"你'),
        chunk({
          candidates: [
            { content: { parts: [{ text: 'more thought', thought: true }, { text: '好"' }] } },
          ],
        }),
      ]),
    );
    expect(await runText(fn)).toEqual([
      { type: 'delta', index: 0, delta: '"你' },
      { type: 'delta', index: 0, delta: '好"' },
      { type: 'item', index: 0, text: '你好' },
    ]);
  });

  it('removes a label prefix', async () => {
    const events = await runText(mockFetch(sseResponse([part('Translation: '), part('Hallo')])));
    expect(events.at(-1)).toEqual({ type: 'item', index: 0, text: 'Hallo' });
  });

  it('fails with empty-translation when only thoughts arrive', async () => {
    const fn = mockFetch(sseResponse([part('thinking', { thought: true })]));
    await expect(runText(fn)).rejects.toMatchObject({ code: 'validation/empty-translation' });
  });

  it('keeps MAX_TOKENS as output-truncated', async () => {
    const fn = mockFetch(
      sseResponse([
        chunk({
          candidates: [{ content: { parts: [{ text: '你' }] }, finishReason: 'MAX_TOKENS' }],
        }),
      ]),
    );
    await expect(runText(fn)).rejects.toMatchObject({ code: 'provider/output-truncated' });
  });
});
