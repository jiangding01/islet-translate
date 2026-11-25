import { describe, expect, it } from 'vitest';
import { normalizeBaseURL } from '@/lib/endpoint';
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
import { createOpenAICompatAdapter } from './openai-compat';

const adapter = createOpenAICompatAdapter();
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const OUTPUT = '[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]';

const run = (fn: ReturnType<typeof mockFetch>, overrides = {}) =>
  collect(adapter.translate(['hello', 'world'], makeCtx({ fetch: fn, ...overrides })));

describe('normalizeBaseURL', () => {
  it.each([
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['  https://x.com/v1  ', 'https://x.com/v1'],
    ['https://x.com/v1/chat/completions', 'https://x.com/v1'],
    ['https://x.com/v1/chat/completions/', 'https://x.com/v1'],
    ['https://x.com/v1/responses', 'https://x.com/v1'],
    ['https://x.com/v1/completions', 'https://x.com/v1'],
    ['https://x.com/v1/Chat/Completions', 'https://x.com/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBaseURL(input)).toBe(expected);
  });
});

describe('openai-compat adapter', () => {
  it('exposes llm limits', () => {
    expect(adapter.kind).toBe('llm');
    expect(adapter.limits).toEqual({ maxItems: 20, maxChars: 3000 });
  });

  it('merges the engine extra body fields, which cannot override the request itself', async () => {
    const fn = mockFetch(sseResponse([delta(OUTPUT), 'data: [DONE]\n\n']));
    await run(fn, {
      settings: {
        baseURL: 'https://api.example.com/v1',
        model: 'm',
        extraBody: { thinking: { type: 'disabled' }, model: 'other', stream: false },
      },
    });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
  });

  it('sends no extra body fields when the engine has none', async () => {
    const fn = mockFetch(sseResponse([delta(OUTPUT), 'data: [DONE]\n\n']));
    await run(fn);
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual([
      'messages',
      'model',
      'stream',
    ]);
  });

  it('sends a streaming chat completion with a Bearer header', async () => {
    const fn = mockFetch(sseResponse([delta(OUTPUT), 'data: [DONE]\n\n']));
    const events = await run(fn);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-key');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('m');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(body.messages[1].content).toContain('"i":1');
    expect(events).toEqual([
      { type: 'item', index: 0, text: '你好' },
      { type: 'item', index: 1, text: '世界' },
    ]);
  });

  it('omits Authorization without a key', async () => {
    const fn = mockFetch(sseResponse([delta(OUTPUT), 'data: [DONE]\n\n']));
    await run(fn, { apiKey: undefined });
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('accumulates deltas split across chunks, with comments', async () => {
    const full = `: ping\n\n${delta(OUTPUT.slice(0, 10))}${delta(OUTPUT.slice(10))}data: [DONE]\n\n`;
    const middle = Math.floor(full.length / 2);
    const fn = mockFetch(sseResponse([full.slice(0, middle), full.slice(middle)]));
    expect(await run(fn)).toHaveLength(2);
  });

  it('accepts a stream that ends with finish_reason but no [DONE]', async () => {
    const stop = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
    const fn = mockFetch(sseResponse([delta(OUTPUT), stop]));
    expect(await run(fn)).toHaveLength(2);
  });

  it.each([
    [401, 'provider/unauthorized', false],
    [404, 'provider/not-found', false],
    [500, 'provider/server-error', true],
  ])('maps HTTP %i', async (status, code, retryable) => {
    const fn = mockFetch(new Response('{}', { status }));
    await expect(run(fn)).rejects.toMatchObject({ code, retryable });
  });

  it('tells a local server rejecting the extension origin apart from a bad key', async () => {
    const local = { settings: { baseURL: 'http://localhost:11434/v1', model: 'm' } };
    await expect(run(mockFetch(new Response('', { status: 403 })), local)).rejects.toMatchObject({
      code: 'provider/local-origin-rejected',
      retryable: false,
    });
    // A remote 403 and a local 401 stay key problems.
    await expect(run(mockFetch(new Response('', { status: 403 })))).rejects.toMatchObject({
      code: 'provider/unauthorized',
    });
    await expect(run(mockFetch(new Response('', { status: 401 })), local)).rejects.toMatchObject({
      code: 'provider/unauthorized',
    });
  });

  it('maps 429 with retry-after as retryable rate limiting', async () => {
    const fn = mockFetch(
      jsonResponse({ error: { code: 'rate_limit' } }, 429, { 'retry-after': '2' }),
    );
    await expect(run(fn)).rejects.toMatchObject({
      code: 'rate-limit/too-many-requests',
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('maps 429 insufficient_quota as non-retryable', async () => {
    const fn = mockFetch(jsonResponse({ error: { code: 'insufficient_quota' } }, 429));
    await expect(run(fn)).rejects.toMatchObject({
      code: 'provider/quota-exceeded',
      retryable: false,
    });
  });

  it('reports a stream cut mid-way as a retryable network error', async () => {
    const fn = mockFetch(sseResponse([delta('[{"i":0')], new Error('reset')));
    await expect(run(fn)).rejects.toMatchObject({ code: 'network/fetch-failed', retryable: true });
    const early = mockFetch(sseResponse([delta('[{"i":0')]));
    await expect(run(early)).rejects.toMatchObject({ code: 'network/stream-interrupted' });
  });

  it('fails with bad-response when the model output is not valid', async () => {
    const fn = mockFetch(sseResponse([delta('sorry, no'), 'data: [DONE]\n\n']));
    await expect(run(fn)).rejects.toMatchObject({ code: 'validation/bad-response' });
  });

  it('requires a model', async () => {
    const fn = mockFetch();
    await expect(
      run(fn, { settings: { baseURL: 'https://x.com', model: ' ' } }),
    ).rejects.toMatchObject({ code: 'config/model-required' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('never puts the key or the source text into error messages', async () => {
    const failures = [
      mockFetch(new Response('sk-secret-key hello', { status: 401 })),
      mockFetch(new Response('sk-secret-key hello', { status: 500 })),
      mockFetch(new TypeError('sk-secret-key hello')),
      mockFetch(sseResponse([delta('hello sk-secret-key'), 'data: [DONE]\n\n'])),
    ];
    for (const fn of failures) {
      const error = await run(fn).catch((e: unknown) => e);
      const text = JSON.stringify(error);
      expect(text).not.toContain('sk-secret-key');
      expect(text).not.toContain('hello');
    }
  });

  it('stops a runaway stream instead of accumulating without limit', async () => {
    const chunks = Array.from({ length: 70 }, () => delta('x'.repeat(1000)));
    const fn = mockFetch(sseResponse([...chunks, 'data: [DONE]\n\n']));
    await expect(run(fn)).rejects.toMatchObject({ code: 'provider/output-truncated' });
  });

  it.each([
    ['length', 'provider/output-truncated'],
    ['content_filter', 'provider/content-blocked'],
  ])('maps finish_reason %s to %s, not retryable', async (reason, code) => {
    const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
    const fn = mockFetch(sseResponse([delta(OUTPUT), end, 'data: [DONE]\n\n']));
    await expect(run(fn)).rejects.toMatchObject({ code, retryable: false });
  });
});

describe('openai-compat adapter: items as they complete', () => {
  const finish = (reason: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
  const runBatch = (fn: ReturnType<typeof mockFetch>, overrides = {}) =>
    collectSettled(adapter.translate(['a', 'b', 'c'], makeCtx({ fetch: fn, ...overrides })));
  const item = (index: number, text: string) => ({ type: 'item', index, text });
  const code = (value: string) => expect.objectContaining({ code: value });

  it('yields the first item before the stream ends', async () => {
    const { response, release } = gatedSseResponse(
      [delta('[{"i":0,"t":"你好"},'), delta('{"i":1,')],
      [delta('"t":"世界"}]'), 'data: [DONE]\n\n'],
    );
    const events = adapter.translate(['hello', 'world'], makeCtx({ fetch: mockFetch(response) }));
    const iterator = events[Symbol.asyncIterator]();
    // The rest is held back until release(): a late first item never resolves here.
    expect(await iterator.next()).toEqual({ done: false, value: item(0, '你好') });
    release();
    expect(await iterator.next()).toEqual({ done: false, value: item(1, '世界') });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('fails with bad-response, yielding nothing more, when the whole output differs', async () => {
    const raw =
      '[{"i":0,"t":"草稿"},{"i":1,"t":"b"}]</think>[{"i":0,"t":"终稿"},{"i":1,"t":"乙"},{"i":2,"t":"丙"}]';
    const result = await runBatch(mockFetch(sseResponse([delta(raw), 'data: [DONE]\n\n'])));
    expect(result.events).toEqual([item(0, '草稿')]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  const CLEAN = [delta('[{"i":0,"t":"甲"},'), delta('{"i":1,"t":"乙"},{"i":2,"t":"丙')];
  const TAINTED = [delta('[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]'), delta('</think>[{"i":0,"t":"甲')];
  // Item 1 is far longer than its source: the length check closes the scanner.
  const SUSPECT = [
    delta('[{"i":0,"t":"甲"},'),
    delta('{"i":1,"t":"乙乙乙乙乙乙乙乙乙乙乙"},{"i":2,"t":"丙'),
  ];
  const ENDINGS: [string, (chunks: string[]) => Response, object, string][] = [
    [
      'finish_reason length',
      (chunks) => sseResponse([...chunks, finish('length')]),
      {},
      'provider/output-truncated',
    ],
    ['no [DONE]', (chunks) => sseResponse(chunks), {}, 'network/stream-interrupted'],
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

  it('fails a suspect output whose array never closes but whose stream ends normally with bad-response', async () => {
    const result = await runBatch(mockFetch(sseResponse([...SUSPECT, 'data: [DONE]\n\n'])));
    expect(result.events).toEqual([item(0, '甲')]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  it.each(ENDINGS)(
    'turns %s after the length check closed the scanner into bad-response',
    async (_name, reply, ctx) => {
      const result = await runBatch(mockFetch(reply(SUSPECT)), ctx);
      expect(result.events).toEqual([item(0, '甲')]);
      expect(result.error).toEqual(code('validation/bad-response'));
    },
  );

  it('reports an array that never closes as output-truncated, a short one as bad-response', async () => {
    const open = await runBatch(mockFetch(sseResponse([...CLEAN, 'data: [DONE]\n\n'])));
    expect(open.events).toEqual([item(0, '甲'), item(1, '乙')]);
    expect(open.error).toEqual(code('provider/output-truncated'));
    const short = await runBatch(
      mockFetch(sseResponse([delta('[{"i":0,"t":"甲"}]'), 'data: [DONE]\n\n'])),
    );
    expect(short.events).toEqual([item(0, '甲')]);
    expect(short.error).toEqual(code('validation/bad-response'));
  });
});

describe('openai-compat adapter: text format', () => {
  const runText = (fn: ReturnType<typeof mockFetch>, source = 'Hello', overrides = {}) =>
    collect(adapter.translate([source], makeCtx({ fetch: fn, prompt: TEXT_PROMPT, ...overrides })));
  const reply = (...parts: string[]) => sseResponse([...parts.map(delta), 'data: [DONE]\n\n']);

  it('sends the text between markers made of a fresh nonce per request', async () => {
    const fn = mockFetch(reply('你好'), reply('你好'));
    await runText(fn);
    await runText(fn);
    const bodies = fn.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    const nonces = bodies.map((body) => {
      const nonce = /^SYS ([0-9a-f]{16})$/.exec(body.messages[0].content)?.[1];
      expect(body.messages[1].content).toBe(`[${nonce}]\nHello\n[/${nonce}]`);
      return nonce;
    });
    expect(nonces[0]).toBeDefined();
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('yields a delta per increment, then the whole text as the item', async () => {
    const empty = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
    const fn = mockFetch(
      sseResponse([empty, delta('你'), delta(''), delta('好'), 'data: [DONE]\n\n']),
    );
    expect(await runText(fn)).toEqual([
      { type: 'delta', index: 0, delta: '你' },
      { type: 'delta', index: 0, delta: '好' },
      { type: 'item', index: 0, text: '你好' },
    ]);
  });

  it('keeps reasoning out of the increments and the result', async () => {
    const fn = mockFetch(reply('<think>', 'Hello means', '…</think>\n', '你好'));
    expect(await runText(fn)).toEqual([
      { type: 'delta', index: 0, delta: '你好' },
      { type: 'item', index: 0, text: '你好' },
    ]);
  });

  it.each([
    ['a think block', '<think>hmm</think>\n你好', 'Hello', '你好'],
    ['an unclosed think block after the text', '你好<think>more', 'Hello', '你好'],
    ['wrapping ASCII quotes', '"你好"', 'Hello', '你好'],
    ['wrapping curly quotes', '“你好”', 'Hello', '你好'],
    ['wrapping corner brackets', '「你好」', 'Hello', '你好'],
    ['quotes the source also has', '"你好"', '"Hello"', '"你好"'],
    ['quotes when the source is quoted in another style', '“你好”', '"Hello"', '“你好”'],
    ['quotes that do not wrap the whole reply', '"甲" 和 "乙"', 'A and B', '"甲" 和 "乙"'],
    ['a 译文 label', '译文：你好', 'Hello', '你好'],
    ['a 翻译 label', '翻译: 你好', 'Hello', '你好'],
    ['a Translation label', 'Translation: Hallo', 'Hello', 'Hallo'],
    ['a label and quotes', 'Translation: "Hallo"', 'Hello', 'Hallo'],
    ['a label the source also has', '翻译：你好', 'Translation: hello', '翻译：你好'],
    ['surrounding whitespace', '\n  你好 \n', 'Hello', '你好'],
  ])('cleans %s', async (_name, output, source, expected) => {
    const events = await runText(mockFetch(reply(output)), source);
    expect(events.at(-1)).toEqual({ type: 'item', index: 0, text: expected });
  });

  it.each([
    ['only a think block', '<think>nothing to say</think>'],
    ['only a label', '译文：'],
    ['only quotes', '“ ”'],
    ['whitespace', '  \n '],
  ])('fails with empty-translation when %s is left', async (_name, output) => {
    await expect(runText(mockFetch(reply(output)))).rejects.toMatchObject({
      code: 'validation/empty-translation',
    });
  });

  it('refuses more than one item', async () => {
    const fn = mockFetch();
    await expect(
      collect(adapter.translate(['a', 'b'], makeCtx({ fetch: fn, prompt: TEXT_PROMPT }))),
    ).rejects.toMatchObject({ code: 'internal/text-batch' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the output ceiling and finish_reason handling', async () => {
    const chunks = Array.from({ length: 70 }, () => delta('x'.repeat(1000)));
    const runaway = mockFetch(sseResponse([...chunks, 'data: [DONE]\n\n']));
    await expect(runText(runaway)).rejects.toMatchObject({ code: 'provider/output-truncated' });
    const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;
    const cut = mockFetch(sseResponse([delta('你'), end]));
    await expect(runText(cut)).rejects.toMatchObject({ code: 'provider/output-truncated' });
  });
});
