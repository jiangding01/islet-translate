import { describe, expect, it, vi } from 'vitest';
import { collect, jsonResponse, makeCtx, mockFetch } from '../test-utils';
import { createGoogleAdapter } from './google';

const adapter = createGoogleAdapter();
const run = (batch: string[], fetchImpl: ReturnType<typeof mockFetch>) =>
  collect(adapter.translate(batch, makeCtx({ fetch: fetchImpl, source: 'auto', target: 'en' })));
const call = (fn: ReturnType<typeof mockFetch>, index: number) => {
  const [url, init] = fn.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init };
};

describe('google adapter', () => {
  it('exposes mt limits', () => {
    expect(adapter.kind).toBe('mt');
    expect(adapter.limits).toEqual({ maxItems: 50, maxChars: 5000 });
  });

  it('POSTs a form body with repeated q and keeps the text out of the URL', async () => {
    const fn = mockFetch(
      jsonResponse([
        ['Hello', 'zh-CN'],
        ['World', 'zh-CN'],
      ]),
    );
    const events = await run(['你好', '世界'], fn);
    const { url, init } = call(fn, 0);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(
      /^application\/x-www-form-urlencoded/,
    );
    expect(url).toBe('https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=en');
    expect(url).not.toContain(encodeURIComponent('你好'));
    expect((init.body as URLSearchParams).getAll('q')).toEqual(['你好', '世界']);
    expect(events).toEqual([
      { type: 'item', index: 0, text: 'Hello' },
      { type: 'item', index: 1, text: 'World' },
    ]);
  });

  it.each([
    ['array of arrays', [['Hi', 'zh-CN']]],
    ['plain string', 'Hi'],
    ['flat array with language', ['Hi', 'zh-CN']],
  ])('parses a single-item response: %s', async (_name, body) => {
    const events = await run(['你好'], mockFetch(jsonResponse(body)));
    expect(events).toEqual([{ type: 'item', index: 0, text: 'Hi' }]);
  });

  it.each([403, 404, 500, 503])('falls back to the single endpoint on HTTP %i', async (status) => {
    const fn = mockFetch(
      new Response('', { status }),
      jsonResponse([
        [
          ['One', 'a'],
          [' two', 'b'],
        ],
        null,
        'zh-CN',
      ]),
      jsonResponse([[['Three', 'c']]]),
    );
    const events = await run(['a', 'b'], fn);
    expect(events.map((e) => (e.type === 'item' ? e.text : ''))).toEqual(['One two', 'Three']);
    const second = call(fn, 1);
    expect(second.init.method).toBe('GET');
    expect(second.url).toContain('/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=a');
  });

  it('falls back on a network error and on an unparseable body', async () => {
    const single = () => jsonResponse([[['ok', 'x']]]);
    const net = await run(['x'], mockFetch(new TypeError('offline'), single()));
    expect(net).toEqual([{ type: 'item', index: 0, text: 'ok' }]);
    const bad = await run(['x'], mockFetch(jsonResponse({ unexpected: true }), single()));
    expect(bad).toEqual([{ type: 'item', index: 0, text: 'ok' }]);
  });

  it('does not fall back on 400, 429, or an aborted request', async () => {
    const fn400 = mockFetch(new Response('', { status: 400 }));
    await expect(run(['x'], fn400)).rejects.toMatchObject({ code: 'provider/bad-request' });
    expect(fn400).toHaveBeenCalledTimes(1);

    const fn429 = mockFetch(new Response('', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(run(['x'], fn429)).rejects.toMatchObject({
      code: 'rate-limit/too-many-requests',
      retryAfterMs: 3000,
    });
    expect(fn429).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const fnAbort = mockFetch(new DOMException('aborted', 'AbortError'));
    await expect(
      collect(adapter.translate(['x'], makeCtx({ fetch: fnAbort, signal: controller.signal }))),
    ).rejects.toMatchObject({ code: 'network/aborted' });
    expect(fnAbort).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for items whose encoded size exceeds 6000 bytes', async () => {
    const fn = mockFetch(new Response('', { status: 500 }));
    await expect(run(['你'.repeat(700)], fn)).rejects.toMatchObject({
      code: 'provider/server-error',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports an error when the result count differs, without falling back', async () => {
    const fn = mockFetch(jsonResponse([['only', 'en']]));
    await expect(run(['a', 'b'], fn)).rejects.toMatchObject({ code: 'validation/bad-response' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty array', []],
    ['array with null', [null]],
    ['array of non-string rows', [[null, 'en']]],
  ])('treats an odd primary response as malformed: %s', async (_name, body) => {
    const fn = mockFetch(jsonResponse(body), jsonResponse([[['ok', 'x']]]));
    const events = await run(['x'], fn);
    // Not taken as a result: the single endpoint answered instead.
    expect(events).toEqual([{ type: 'item', index: 0, text: 'ok' }]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  describe('items that echo source sentences', () => {
    const SOURCE =
      'How is this different from Dify, n8n or Flowise? Those are general-purpose AI and automation workflow builders.';
    const ECHOED =
      'How is this different from Dify, n8n or Flowise? 这些是通用的 AI 和自动化工作流构建器。';
    const GOOD = ['这与 Dify、n8n 或 Flowise 有何不同？', '这些是通用的 AI 和自动化工作流构建器。'];
    const runZh = (batch: string[], fetchImpl: ReturnType<typeof mockFetch>) =>
      collect(
        adapter.translate(batch, makeCtx({ fetch: fetchImpl, source: 'auto', target: 'zh-CN' })),
      );
    const texts = (events: Awaited<ReturnType<typeof runZh>>) =>
      events.map((e) => (e.type === 'item' ? e.text : ''));

    it('retries only the echoed item on the single endpoint and takes the better answer', async () => {
      const fn = mockFetch(
        jsonResponse([
          [ECHOED, 'en'],
          ['你好', 'en'],
        ]),
        jsonResponse([GOOD.map((text) => [text, 'x']), null, 'en']),
      );
      const events = await runZh([SOURCE, 'Hello'], fn);
      expect(texts(events)).toEqual([GOOD.join(''), '你好']);
      expect(fn).toHaveBeenCalledTimes(2);
      const second = call(fn, 1);
      expect(second.init.method).toBe('GET');
      expect(second.url).toContain(
        `/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(SOURCE)}`,
      );
    });

    it('keeps the first answer when the retry fails or still echoes', async () => {
      const failed = mockFetch(
        jsonResponse([[ECHOED, 'en']]),
        new Response('', { status: 429, headers: { 'retry-after': '3' } }),
      );
      expect(texts(await runZh([SOURCE], failed))).toEqual([ECHOED]);
      expect(failed).toHaveBeenCalledTimes(2);

      const blocked = mockFetch(
        jsonResponse([[ECHOED, 'en']]),
        new Response('<html>', { status: 200 }),
      );
      expect(texts(await runZh([SOURCE], blocked))).toEqual([ECHOED]);

      const still = mockFetch(jsonResponse([[ECHOED, 'en']]), jsonResponse([[[ECHOED, 'x']]]));
      expect(texts(await runZh([SOURCE], still))).toEqual([ECHOED]);
    });

    it('stops retrying after a failed retry', async () => {
      const fn = mockFetch(
        jsonResponse([
          [ECHOED, 'en'],
          [ECHOED, 'en'],
        ]),
        new Response('', { status: 429 }),
      );
      const events = await runZh([SOURCE, `${SOURCE} `], fn);
      expect(texts(events)).toEqual([ECHOED, ECHOED]);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('sends no retry for complete translations or an English target', async () => {
      const fn = mockFetch(jsonResponse([[GOOD.join(''), 'en']]));
      expect(texts(await runZh([SOURCE], fn))).toEqual([GOOD.join('')]);
      expect(fn).toHaveBeenCalledTimes(1);
      const en = mockFetch(jsonResponse([[SOURCE, 'en']]));
      expect(texts(await run([SOURCE], en))).toEqual([SOURCE]);
      expect(en).toHaveBeenCalledTimes(1);
    });
  });
  describe('items whose inline tags were dropped', () => {
    // claude.dev, 2026-11-17: the plain endpoint dropped <t0>, HTML mode kept it.
    const SOURCE =
      'Our code is written and <t0>reviewed by Claude</t0>. At this scale, evidence matters.';
    const DROPPED = '我们的代码由 Claude 编写和审查。在这种规模下，证据很重要。';
    const HTML_REPLY =
      '我们的代码都是<a id="t0">由 Claude 编写和审查的</a>。在这种规模下，证据很重要。';
    const RESTORED = '我们的代码都是<t0>由 Claude 编写和审查的</t0>。在这种规模下，证据很重要。';
    const runZh = (
      batch: string[],
      fetchImpl: ReturnType<typeof mockFetch>,
      signal?: AbortSignal,
    ) =>
      collect(
        adapter.translate(
          batch,
          makeCtx({
            fetch: fetchImpl,
            source: 'en',
            target: 'zh-CN',
            ...(signal ? { signal } : {}),
          }),
        ),
      );
    const texts = (events: Awaited<ReturnType<typeof runZh>>) =>
      events.map((e) => (e.type === 'item' ? e.text : ''));

    it('sends the broken items once more as HTML and takes the restored tags', async () => {
      const fn = mockFetch(
        jsonResponse([
          [DROPPED, 'en'],
          ['你好', 'en'],
          [DROPPED, 'en'],
        ]),
        jsonResponse([HTML_REPLY, HTML_REPLY]),
      );
      const events = await runZh([SOURCE, 'Hello', `${SOURCE} `], fn);
      expect(texts(events)).toEqual([RESTORED, '你好', RESTORED]);
      expect(fn).toHaveBeenCalledTimes(2);
      const second = call(fn, 1);
      expect(second.init.method).toBe('POST');
      expect(second.url).toBe(
        'https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN&format=html',
      );
      expect((second.init.body as URLSearchParams).getAll('q')).toEqual([
        'Our code is written and <a id="t0">reviewed by Claude</a>. At this scale, evidence matters.',
        'Our code is written and <a id="t0">reviewed by Claude</a>. At this scale, evidence matters. ',
      ]);
    });

    it('keeps the translated answer when the HTML retry only echoes the source', async () => {
      const echoed =
        'Our code is written and <a id="t0">reviewed by Claude</a>. At this scale, evidence matters.';
      const fn = mockFetch(jsonResponse([[DROPPED, 'en']]), jsonResponse([echoed]));
      expect(texts(await runZh([SOURCE], fn))).toEqual([DROPPED]);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('sends nothing more when the tags came back intact', async () => {
      const fn = mockFetch(jsonResponse([[RESTORED, 'en']]));
      expect(texts(await runZh([SOURCE], fn))).toEqual([RESTORED]);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('keeps the first answer when the HTML retry fails or still loses the tags', async () => {
      const limited = mockFetch(
        jsonResponse([[DROPPED, 'en']]),
        new Response('', { status: 429, headers: { 'retry-after': '3' } }),
      );
      expect(texts(await runZh([SOURCE], limited))).toEqual([DROPPED]);
      expect(limited).toHaveBeenCalledTimes(2);

      const blocked = mockFetch(
        jsonResponse([[DROPPED, 'en']]),
        new Response('<html>', { status: 200 }),
      );
      expect(texts(await runZh([SOURCE], blocked))).toEqual([DROPPED]);

      const still = mockFetch(jsonResponse([[DROPPED, 'en']]), jsonResponse([DROPPED]));
      expect(texts(await runZh([SOURCE], still))).toEqual([DROPPED]);

      const offline = mockFetch(jsonResponse([[DROPPED, 'en']]), new TypeError('offline'));
      expect(texts(await runZh([SOURCE], offline))).toEqual([DROPPED]);
    });

    it('retries only what fits in one request', async () => {
      const long = `${'word '.repeat(950)}<t0>link</t0>.`;
      const fn = mockFetch(
        jsonResponse([
          ['丢了', 'en'],
          ['丢了', 'en'],
        ]),
        jsonResponse(['<a id="t0">链接</a>']),
      );
      const events = await runZh([long, long], fn);
      expect(texts(events)).toEqual(['<t0>链接</t0>', '丢了']);
      expect((call(fn, 1).init.body as URLSearchParams).getAll('q')).toHaveLength(1);
    });

    it('fails with the abort when the request is cancelled during the retry', async () => {
      const controller = new AbortController();
      const fn = mockFetch(jsonResponse([[DROPPED, 'en']]));
      // Second call (the HTML retry): the user cancels while it is in flight.
      fn.mockImplementationOnce(async () => jsonResponse([[DROPPED, 'en']])).mockImplementationOnce(
        async () => {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        },
      );
      await expect(runZh([SOURCE], fn, controller.signal)).rejects.toMatchObject({
        code: 'network/aborted',
      });
    });
  });
});

describe('google adapter: glossary term marks (M4-C)', () => {
  const runTerms = (batch: string[], fetchImpl: ReturnType<typeof mockFetch>) =>
    collect(
      adapter.translate(
        batch,
        makeCtx({ fetch: fetchImpl, source: 'auto', target: 'zh-CN', terms: true }),
      ),
    );
  /** Answers every q of an HTML request as `译:` plus the q. */
  const htmlEcho = (init: RequestInit) =>
    jsonResponse((init.body as URLSearchParams).getAll('q').map((q) => [`译:${q}`, 'en']));

  it('goes straight to HTML mode and never to the plain endpoint or /single', async () => {
    const fn = mockFetch(
      jsonResponse([['译:<span translate="no" id="g0">Sonnet</span> 很好', 'en']]),
    );
    const events = await runTerms(['<g0>Sonnet</g0> is good'], fn);
    expect(fn).toHaveBeenCalledTimes(1);
    const { url, init } = call(fn, 0);
    expect(url).toContain('/translate_a/t?');
    expect(url).toContain('&format=html');
    expect((init.body as URLSearchParams).getAll('q')).toEqual([
      '<span translate="no" id="g0">Sonnet</span> is good',
    ]);
    expect(events).toEqual([{ type: 'item', index: 0, text: '译:<g0>Sonnet</g0> 很好' }]);
  });

  it('does not retry an echoed or tag-losing answer', async () => {
    // An echo of a long English sentence would go to /single in plain mode.
    const source = '<g0>Sonnet</g0> writes the whole report every single morning for the town.';
    const echo =
      '<span translate="no" id="g0">Sonnet</span> writes the whole report every single morning for the town.';
    const fn = mockFetch(jsonResponse([[echo, 'en']]));
    const events = await runTerms([source], fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'item', index: 0, text: source }]);
  });

  it('cuts requests by HTML length and answers an oversized item with its unmarked source', async () => {
    const long = `<g0>x</g0> ${'a'.repeat(3000)}`;
    const huge = `<g0>y</g0> ${'b'.repeat(4980)}`;
    const calls: string[][] = [];
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push((init.body as URLSearchParams).getAll('q'));
      return htmlEcho(init);
    });
    const events = await runTerms(
      [long, huge, long],
      fn as unknown as ReturnType<typeof mockFetch>,
    );
    // Each long item is about 3040 characters of HTML: one per request. The huge one is never sent.
    expect(calls).toHaveLength(2);
    expect(calls.every((qs) => qs.length === 1)).toBe(true);
    expect(events.map((event) => (event.type === 'item' ? event.text.slice(0, 13) : ''))).toEqual([
      '译:<g0>x</g0> ',
      `y ${'b'.repeat(11)}`,
      '译:<g0>x</g0> ',
    ]);
  });

  it.each([
    ['403', () => new Response('', { status: 403 })],
    ['503', () => new Response('', { status: 503 })],
    ['a network error', () => new TypeError('offline')],
  ])(
    'answers every item with its unmarked source after %s, without /single',
    async (_name, reply) => {
      const fn = mockFetch(reply());
      const events = await runTerms(['<t0><g0>Sonnet</g0></t0> is good', '<g0>A</g0> ok'], fn);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        { type: 'item', index: 0, text: '<t0>Sonnet</t0> is good' },
        { type: 'item', index: 1, text: 'A ok' },
      ]);
    },
  );

  it('still throws on 429 and 400, and once aborted', async () => {
    const limited = mockFetch(new Response('', { status: 429 }));
    await expect(runTerms(['<g0>Sonnet</g0> is good'], limited)).rejects.toMatchObject({
      code: 'rate-limit/too-many-requests',
    });
    expect(limited).toHaveBeenCalledTimes(1);
    const bad = mockFetch(new Response('', { status: 400 }));
    await expect(runTerms(['<g0>Sonnet</g0> is good'], bad)).rejects.toMatchObject({
      code: 'provider/bad-request',
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch(new Response('', { status: 503 }));
    await expect(
      collect(
        adapter.translate(
          ['<g0>Sonnet</g0> is good'],
          makeCtx({ fetch: aborted, target: 'zh-CN', terms: true, signal: controller.signal }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it('answers an item whose reply does not convert back with its source, marks removed', async () => {
    const fn = mockFetch(
      jsonResponse([
        ['Sonnet 很好', 'en'],
        ['<span translate="no" id="g0">A</span> 好', 'en'],
      ]),
    );
    const events = await runTerms(['<t0><g0>Sonnet</g0></t0> is good', '<g0>A</g0> ok'], fn);
    expect(events).toEqual([
      { type: 'item', index: 0, text: '<t0>Sonnet</t0> is good' },
      { type: 'item', index: 1, text: '<g0>A</g0> 好' },
    ]);
  });
});
