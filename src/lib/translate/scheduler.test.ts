import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import type { ItemOutcome } from './codec';
import { abortedError, badResponseError, safeFetch } from './providers/errors';
import { createOpenAICompatAdapter } from './providers/openai-compat';
import {
  type CacheEntry,
  createScheduler,
  SCHEDULER_LIMITS,
  SCHEDULER_STREAM,
  type Scheduler,
  type TaskContext,
} from './scheduler';
import { PROMPT, sseResponse } from './test-utils';
import type { ProviderAdapter, ProviderEvent } from './types';

// ------------------------------------------------------------ fake network

interface Reply {
  status: number;
  texts?: string[];
  retryAfterMs?: number;
}

interface Call {
  at: number;
  texts: string[];
  signal: AbortSignal;
  aborted: boolean;
  settled: boolean;
  reply(reply: Reply): void;
  echo(): void;
  fail(error?: unknown): void;
}

/**
 * A fetch whose calls the test answers by hand. With `honorAbort: false` an
 * aborted call stays pending until the test settles it, like a slow network
 * teardown.
 */
function createNetwork(options: { honorAbort?: boolean } = {}) {
  const honorAbort = options.honorAbort ?? true;
  const calls: Call[] = [];
  const fetchFn = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const call: Call = {
          at: Date.now(),
          texts: JSON.parse(String(init?.body)) as string[],
          signal,
          aborted: false,
          settled: false,
          reply(reply) {
            if (call.settled) return;
            call.settled = true;
            resolve({ ok: reply.status < 300, status: reply.status, reply } as unknown as Response);
          },
          echo() {
            call.reply({ status: 200, texts: call.texts.map((text) => `T:${text}`) });
          },
          fail(error = new TypeError('network')) {
            if (call.settled) return;
            call.settled = true;
            reject(error);
          },
        };
        signal.addEventListener(
          'abort',
          () => {
            call.aborted = true;
            if (honorAbort) call.fail(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
        calls.push(call);
      }),
  );
  return {
    fetch: fetchFn as unknown as typeof fetch,
    calls,
    aborts: () => calls.filter((call) => call.aborted).length,
    inFlight: () => calls.filter((call) => !call.settled).length,
    bodies: () => calls.map((call) => call.texts),
  };
}

/** Minimal adapter on top of the fake network; errors mirror providers/errors. */
function fakeAdapter(kind: 'mt' | 'llm', maxItems = 1): ProviderAdapter {
  return {
    kind,
    limits: { maxItems, maxChars: 100_000 },
    async *translate(batch, ctx) {
      const response = await safeFetch(ctx, 'https://provider.test/', {
        method: 'POST',
        body: JSON.stringify(batch),
      });
      const { reply } = response as unknown as { reply: Reply };
      if (reply.status === 429) {
        throw appError('rate-limit', 'rate-limit/too-many-requests', 'HTTP 429', {
          retryable: true,
          retryAfterMs: reply.retryAfterMs,
        });
      }
      if (reply.status >= 500) {
        throw appError('provider', 'provider/server-error', 'HTTP 500', { retryable: true });
      }
      if (reply.status >= 400) throw appError('provider', 'provider/unauthorized', 'HTTP 401');
      const texts = reply.texts ?? [];
      if (texts.length !== batch.length) throw badResponseError('Item count mismatch');
      for (const [index, text] of texts.entries()) yield { type: 'item', index, text };
    },
  };
}

const MT = fakeAdapter('mt');
const MT4 = fakeAdapter('mt', 4);
const LLM = fakeAdapter('llm');

const CONTEXT: TaskContext = {
  source: 'auto',
  target: 'zh-CN',
  settings: { baseURL: 'https://api.test/v1', model: 'm' },
  prompt: PROMPT,
};

interface SubmitOptions {
  caller?: string;
  adapter?: ProviderAdapter;
  engine?: string;
  cooldownKey?: string;
  deadlineMs?: number;
}

function setup(
  options: { honorAbort?: boolean; random?: () => number; fetch?: typeof fetch } = {},
) {
  const net = createNetwork(options);
  const persisted: CacheEntry[] = [];
  const scheduler = createScheduler({
    fetch: options.fetch ?? net.fetch,
    random: options.random ?? (() => 0),
  });
  function submit(
    texts: string[],
    submitOptions: SubmitOptions = {},
    target: Scheduler = scheduler,
  ) {
    const controller = new AbortController();
    const results: (ItemOutcome | undefined)[] = texts.map(() => undefined);
    const outcomes = target.submit({
      caller: submitOptions.caller ?? 'A',
      signal: controller.signal,
      engine: submitOptions.engine ?? 'google',
      cooldownKey: submitOptions.cooldownKey,
      adapter: submitOptions.adapter ?? MT,
      context: CONTEXT,
      segments: texts.map((text) => ({ key: `k:${text}`, text })),
      persist: (entries) => {
        persisted.push(...entries);
      },
      deadlineMs: submitOptions.deadlineMs,
    });
    outcomes.forEach((outcome, index) => {
      void outcome.then((result) => {
        results[index] = result;
      });
    });
    return { results, cancel: () => controller.abort() };
  }
  return { net, scheduler, persisted, submit };
}

/** Not faked by the tests (they fake setTimeout only), so it runs after pending promise jobs. */
const macrotask = (globalThis as unknown as { setImmediate(callback: () => void): void })
  .setImmediate;

async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => macrotask(resolve));
}

/** Advances fake time to an absolute millisecond (time starts at 0). */
async function at(time: number) {
  await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()));
  await flush();
}

const ok = (text: string) => ({ ok: true, text });
const err = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------ tests

describe('scheduler: concurrency and pacing', () => {
  it('keeps real in-flight MT requests at or below 6', async () => {
    const { net, scheduler, submit } = setup();
    submit(Array.from({ length: 10 }, (_, i) => `t${i}`));
    await at(2000);
    expect(net.calls).toHaveLength(6);
    expect(net.inFlight()).toBe(6);
    expect(scheduler.inspect().active.mt).toBe(6);

    net.calls[0]?.echo();
    await at(2100);
    expect(net.calls).toHaveLength(7);
    expect(net.inFlight()).toBe(6);
  });

  it('keeps real in-flight LLM requests at or below 3', async () => {
    const { net, scheduler, submit } = setup();
    submit(['a', 'b', 'c', 'd', 'e'], { adapter: LLM, engine: 'openai' });
    await at(5000);
    expect(net.calls).toHaveLength(3);
    expect(scheduler.inspect().active.llm).toBe(3);
    net.calls[1]?.echo();
    await at(6000);
    expect(net.calls).toHaveLength(4);
    expect(net.inFlight()).toBe(3);
  });

  it('spaces request starts by the per-kind interval', async () => {
    const mt = setup();
    mt.submit(['a', 'b', 'c']);
    await at(1000);
    expect(mt.net.calls.map((call) => call.at)).toEqual([0, 50, 100]);

    vi.setSystemTime(0);
    const llm = setup();
    llm.submit(['a', 'b', 'c'], { adapter: LLM, engine: 'openai' });
    await at(199);
    expect(llm.net.calls).toHaveLength(1);
    await at(1000);
    expect(llm.net.calls.map((call) => call.at)).toEqual([0, 200, 400]);
  });

  it('holds the slot after a cancel until the aborted fetch has settled', async () => {
    const { net, scheduler, submit } = setup({ honorAbort: false });
    const a = submit(['a1', 'a2', 'a3'], { adapter: LLM, engine: 'openai' });
    await at(500);
    const b = submit(['b1'], { caller: 'B', adapter: LLM, engine: 'openai' });
    await at(1000);
    expect(net.bodies()).toEqual([['a1'], ['a2'], ['a3']]);

    a.cancel();
    await at(1001);
    expect(a.results).toEqual([
      err('network/aborted'),
      err('network/aborted'),
      err('network/aborted'),
    ]);
    expect(net.aborts()).toBe(3);
    // The network has not let go yet: the slots stay taken and B keeps waiting.
    expect(net.inFlight()).toBe(3);
    expect(scheduler.inspect().active.llm).toBe(3);
    await at(20_000);
    expect(net.calls).toHaveLength(3);

    net.calls[0]?.fail();
    await at(20_500);
    expect(net.calls).toHaveLength(4);
    expect(net.calls[3]?.texts).toEqual(['b1']);
    expect(scheduler.inspect().active.llm).toBe(3);
    net.calls[3]?.echo();
    await at(21_000);
    expect(b.results).toEqual([ok('T:b1')]);
  });

  it('holds the slot after a header timeout until the aborted fetch has settled', async () => {
    const { net, scheduler, submit } = setup({ honorAbort: false });
    submit(['a1', 'a2', 'a3'], { adapter: LLM, engine: 'openai' });
    await at(25_400);
    expect(net.aborts()).toBe(3);
    // Retries became due at ~26s, but the timed-out fetches still occupy every slot.
    await at(40_000);
    expect(net.calls).toHaveLength(3);
    expect(scheduler.inspect()).toMatchObject({ active: { llm: 3 }, queued: 3 });

    net.calls[0]?.fail();
    await at(40_100);
    expect(net.calls).toHaveLength(4);
    expect([['a1'], ['a2'], ['a3']]).toContainEqual(net.calls[3]?.texts);
  });
});

describe('scheduler: retries', () => {
  it('retries a retryable error once after 1s x 2^n plus jitter', async () => {
    const { net, submit } = setup({ random: () => 0.5 });
    const { results } = submit(['a']);
    await at(0);
    net.calls[0]?.reply({ status: 500 });
    await at(1049);
    expect(net.calls).toHaveLength(1);
    await at(1050); // 1000 * (1 + 0.5 * 10%)
    expect(net.calls).toHaveLength(2);
    net.calls[1]?.reply({ status: 500 });
    await at(10_000);
    expect(net.calls).toHaveLength(2);
    expect(results).toEqual([err('provider/server-error')]);
  });

  it('keeps jitter within 10%', async () => {
    const { net, submit } = setup({ random: () => 0.999 });
    submit(['a']);
    await at(0);
    net.calls[0]?.reply({ status: 500 });
    await at(1098);
    expect(net.calls).toHaveLength(1);
    await at(1100); // 1000 * (1 + 0.999 * 10%) = 1099.9
    expect(net.calls).toHaveLength(2);
  });

  it('prefers retryAfterMs over the backoff', async () => {
    const { net, submit } = setup();
    const { results } = submit(['a']);
    await at(0);
    net.calls[0]?.reply({ status: 429, retryAfterMs: 5000 });
    await at(4999);
    expect(net.calls).toHaveLength(1);
    await at(5000);
    expect(net.calls).toHaveLength(2);
    net.calls[1]?.echo();
    await at(5100);
    expect(results).toEqual([ok('T:a')]);
  });

  it('does not retry non-retryable errors', async () => {
    const { net, submit } = setup();
    const { results } = submit(['a']);
    await at(0);
    net.calls[0]?.reply({ status: 401 });
    await at(0);
    expect(results).toEqual([err('provider/unauthorized')]);
    await at(10_000);
    expect(net.calls).toHaveLength(1);
  });

  it('gives up with a timeout when the retry wait would pass the deadline', async () => {
    const { net, scheduler, submit } = setup();
    const { results } = submit(['a']);
    await at(0);
    net.calls[0]?.reply({ status: 429, retryAfterMs: 40_000 }); // MT deadline is 30s
    await at(1);
    expect(results).toEqual([err('network/timeout')]);
    expect(scheduler.inspect()).toMatchObject({ waiting: 0, queued: 0, segments: 0 });
    await at(60_000);
    expect(net.calls).toHaveLength(1);
  });
});

describe('scheduler: timeouts', () => {
  it('aborts the fetch when response headers take too long', async () => {
    const { net, submit } = setup();
    const { results } = submit(['a']);
    await at(14_999);
    expect(net.aborts()).toBe(0);
    await at(15_000);
    expect(net.aborts()).toBe(1);
    expect(results).toEqual([undefined]); // retryable: the retry is pending
    await at(16_000);
    expect(net.calls).toHaveLength(2);
  });

  it('honors a shorter per-request deadline (connection tests)', async () => {
    const { net, scheduler, submit } = setup();
    const { results } = submit(['a'], { deadlineMs: 5_000 });
    await at(4_999);
    expect(results).toEqual([undefined]);
    await at(5_000);
    expect(results).toEqual([err('network/timeout')]);
    expect(net.aborts()).toBe(1);
    expect(scheduler.inspect()).toMatchObject({ active: { mt: 0 }, segments: 0 });
  });

  it('runs the segment deadline across retries and splits, then ends', async () => {
    const { net, scheduler, submit } = setup();
    const { results } = submit(['a', 'b'], { adapter: MT4 });
    await at(10_000);
    net.calls[0]?.reply({ status: 200, texts: ['only one'] }); // malformed: split
    await at(10_050);
    expect(net.bodies()).toEqual([['a', 'b'], ['a'], ['b']]);
    // Each half times out waiting for headers (25s / 25.05s) and is retried 1s later.
    await at(26_050);
    expect(net.calls).toHaveLength(5);
    expect(net.aborts()).toBe(2);

    await at(29_999);
    expect(results).toEqual([undefined, undefined]);
    await at(30_000);
    expect(results).toEqual([err('network/timeout'), err('network/timeout')]);
    expect(net.aborts()).toBe(4);
    expect(net.inFlight()).toBe(0);
    expect(scheduler.inspect()).toMatchObject({ active: { mt: 0 }, queued: 0, segments: 0 });
  });

  describe('LLM idle timeout', () => {
    const adapter = createOpenAICompatAdapter();
    const OUTPUT = JSON.stringify([{ i: 0, t: '你好' }]);
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: OUTPUT } }] })}\n\n`;

    function streamingFetch() {
      const streams: { push(text: string): void; close(): void; cancelled: boolean }[] = [];
      const fn = vi.fn(async () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const handle = {
          cancelled: false,
          push: (text: string) => controller?.enqueue(new TextEncoder().encode(text)),
          close: () => controller?.close(),
        };
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          cancel() {
            handle.cancelled = true;
          },
        });
        streams.push(handle);
        return new Response(stream, { status: 200 });
      });
      return { fetch: fn as unknown as typeof fetch, fn, streams };
    }

    it('does not count the wait before the first chunk', async () => {
      const network = streamingFetch();
      const { submit } = setup({ fetch: network.fetch });
      const { results } = submit(['hello'], { adapter, engine: 'openai' });
      // Longer than both the 25s header timeout and the 60s idle timeout.
      await at(100_000);
      expect(network.streams[0]?.cancelled).toBe(false);
      network.streams[0]?.push(delta);
      network.streams[0]?.push('data: [DONE]\n\n');
      await at(100_001);
      expect(results).toEqual([ok('你好')]);
      expect(network.fn).toHaveBeenCalledTimes(1);
    });

    it('fails an attempt after 60s without data once data has started', async () => {
      const network = streamingFetch();
      const { submit } = setup({ fetch: network.fetch });
      submit(['hello'], { adapter, engine: 'openai' });
      await at(1000);
      network.streams[0]?.push(': keep-alive\n\n');
      await at(60_999);
      expect(network.streams[0]?.cancelled).toBe(false);
      await at(61_000);
      expect(network.streams[0]?.cancelled).toBe(true);
      await at(62_000); // retried after the 1s backoff
      expect(network.fn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('scheduler: rate-limit cooldown', () => {
  it('pauses the engine after a 429, then lets a single probe through', async () => {
    const { net, submit } = setup();
    const { results } = submit(['a', 'b', 'c', 'd']);
    const other = submit(['x'], { caller: 'B', engine: 'gemini' });
    await at(0);
    net.calls[0]?.reply({ status: 429 }); // no retry-after: 2s cooldown
    await at(1999);
    // Only the other engine went ahead.
    expect(net.bodies()).toEqual([['a'], ['x']]);
    await at(2000);
    expect(net.bodies()).toEqual([['a'], ['x'], ['a']]);
    await at(5000);
    expect(net.calls).toHaveLength(3); // nothing else while the probe is out

    net.calls[2]?.echo();
    await at(5200);
    expect(net.bodies().slice(3)).toEqual([['b'], ['c'], ['d']]);
    expect(results[0]).toEqual(ok('T:a'));
    expect(other.results).toEqual([undefined]);
  });

  it('cools down again when the probe is rate limited', async () => {
    const { net, submit } = setup();
    const { results } = submit(['a', 'b', 'c']);
    await at(0);
    net.calls[0]?.reply({ status: 429 });
    await at(2000);
    net.calls[1]?.reply({ status: 429, retryAfterMs: 3000 }); // a has no retry left
    await at(2001);
    expect(results[0]).toEqual(err('rate-limit/too-many-requests'));
    await at(4999);
    expect(net.calls).toHaveLength(2);
    await at(5001);
    expect(net.bodies()).toEqual([['a'], ['a'], ['b']]);
    await at(8000);
    expect(net.calls).toHaveLength(3);
  });

  it('does not let a request started before the 429 end the recovery', async () => {
    const { net, submit } = setup();
    submit(['a', 'b', 'c', 'd']);
    await at(50);
    expect(net.calls).toHaveLength(2);
    net.calls[0]?.reply({ status: 429 });
    await at(100);
    net.calls[1]?.echo(); // late success from before the 429
    await at(2100);
    // Still recovering: exactly one probe (a's retry).
    expect(net.bodies()).toEqual([['a'], ['b'], ['a']]);
    await at(4000);
    expect(net.calls).toHaveLength(3);
  });
});

describe('scheduler: cooldown hardening', () => {
  it('caps an oversized retry-after at 60s and does not spin the wake timer', async () => {
    const { net, submit } = setup();
    submit(['a', 'b'], { adapter: LLM, engine: 'openai' });
    await at(0);
    expect(net.calls).toHaveLength(1);
    net.calls[0]?.reply({ status: 429, retryAfterMs: 10 ** 10 });
    await at(1000);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await at(30_000);
    expect(timers.mock.calls.length).toBeLessThan(5);
    timers.mockRestore();
    await at(59_999);
    expect(net.calls).toHaveLength(1);
    await at(60_000);
    expect(net.bodies()).toEqual([['a'], ['b']]);
  });

  it('keeps cooldowns of different cooldown keys apart', async () => {
    const { net, submit } = setup();
    submit(['t'], { caller: 'test', engine: 'openai', cooldownKey: 'test:1' });
    await at(0);
    net.calls[0]?.reply({ status: 429, retryAfterMs: 30_000 });
    await at(10);
    const real = submit(['a', 'b'], {
      engine: 'openai',
      cooldownKey: 'openai|https://api.openai.com',
    });
    await at(200);
    expect(net.bodies()).toEqual([['t'], ['a'], ['b']]);
    net.calls[1]?.echo();
    await at(250);
    expect(real.results[0]).toEqual(ok('T:a'));
  });

  it.each([401, 503])('stays in recovery when the probe answers %i', async (status) => {
    const { net, submit } = setup();
    submit(['a', 'b', 'c', 'd']);
    await at(0);
    net.calls[0]?.reply({ status: 429 }); // 2s cooldown; a retries as the probe
    await at(2000);
    expect(net.bodies()).toEqual([['a'], ['a']]);
    net.calls[1]?.reply({ status }); // a has used its retry
    await at(2100);
    // Still recovering: only the next probe goes out.
    expect(net.bodies()).toEqual([['a'], ['a'], ['b']]);
    await at(5000);
    expect(net.calls).toHaveLength(3);
    net.calls[2]?.echo(); // a successful probe ends recovery
    await at(5200);
    expect(net.bodies().slice(3)).toEqual([['c'], ['d']]);
  });
});

describe('scheduler: truncated and blocked batches', () => {
  it.each(['provider/output-truncated', 'provider/content-blocked'] as const)(
    'splits a batch failing with %s down to the offending item, without retrying',
    async (code) => {
      const calls: string[][] = [];
      const adapter: ProviderAdapter = {
        kind: 'mt',
        limits: { maxItems: 4, maxChars: 100_000 },
        async *translate(batch) {
          calls.push([...batch]);
          if (batch.includes('c')) throw appError('provider', code, 'x');
          for (const [index, text] of batch.entries())
            yield { type: 'item', index, text: `T:${text}` };
        },
      };
      const { submit } = setup();
      const { results } = submit(['a', 'b', 'c', 'd'], { adapter });
      await at(1000);
      expect(results).toEqual([ok('T:a'), ok('T:b'), err(code), ok('T:d')]);
      expect(calls).toEqual([['a', 'b', 'c', 'd'], ['a', 'b'], ['c', 'd'], ['c'], ['d']]);
    },
  );
});

describe('scheduler: LLM replies with inline reasoning', () => {
  it('translates the batch in one request when the reasoning quotes an array', async () => {
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const input = JSON.parse(body.messages[1]?.content.replace('USER ', '') ?? '[]') as {
        i: number;
      }[];
      const items = input.map(({ i }) => ({ i, t: `译${i}` }));
      const content = `<think>Input looks like [{"i":0,...}]. OK.</think>\n${JSON.stringify(items)}`;
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });
    const { submit } = setup({ fetch: fn as unknown as typeof fetch });
    const { results } = submit(['a', 'b', 'c', 'd'], {
      adapter: createOpenAICompatAdapter(),
      engine: 'openai',
    });
    await at(5000);
    expect(results).toEqual([ok('译0'), ok('译1'), ok('译2'), ok('译3')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('scheduler: fairness', () => {
  it('rotates between callers', async () => {
    const { net, submit } = setup();
    submit(['a0', 'a1', 'a2']);
    submit(['b0', 'b1', 'b2'], { caller: 'B' });
    await at(1000);
    expect(net.bodies().flat()).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
  });

  it('does not let a large caller starve a later one', async () => {
    const { net, submit } = setup();
    submit(
      Array.from({ length: 20 }, (_, i) => `a${i}`),
      { adapter: LLM, engine: 'openai' },
    );
    await at(500);
    const late = submit(['b0'], { caller: 'B', adapter: LLM, engine: 'openai' });
    await at(1000);
    expect(net.calls).toHaveLength(3);
    net.calls[0]?.echo();
    await at(1001);
    expect(net.calls[3]?.texts).toEqual(['b0']);
    net.calls[3]?.echo();
    await at(1100);
    expect(late.results).toEqual([ok('T:b0')]);
  });
});

describe('scheduler: dedupe and subscriptions', () => {
  it('shares one request for the same key, queued or in flight', async () => {
    const { net, scheduler, submit } = setup();
    const a = submit(['x', 'y'], { adapter: LLM, engine: 'openai' });
    const queued = submit(['y'], { caller: 'B', adapter: LLM, engine: 'openai' });
    await at(0);
    expect(net.calls).toHaveLength(1); // x in flight, y queued
    const inFlight = submit(['x'], { caller: 'C', adapter: LLM, engine: 'openai' });
    expect(scheduler.inspect().segments).toBe(2);
    await at(1000);
    expect(net.bodies()).toEqual([['x'], ['y']]);
    net.calls[0]?.echo();
    net.calls[1]?.echo();
    await at(1001);
    expect(a.results).toEqual([ok('T:x'), ok('T:y')]);
    expect(queued.results).toEqual([ok('T:y')]);
    expect(inFlight.results).toEqual([ok('T:x')]);
    expect(scheduler.inspect().segments).toBe(0);
  });

  it('never adds new segments to a dispatched batch or a split half', async () => {
    const { net, submit } = setup();
    const a = submit(['a', 'b'], { adapter: MT4 });
    await at(0);
    const b = submit(['a', 'c'], { caller: 'B', adapter: MT4 });
    await at(100);
    expect(net.bodies()).toEqual([['a', 'b'], ['c']]);

    net.calls[0]?.reply({ status: 200, texts: ['x'] }); // malformed: split into [a] and [b]
    await at(200);
    expect(net.bodies().slice(2)).toEqual([['a'], ['b']]);
    const c = submit(['b', 'd'], { caller: 'C', adapter: MT4 });
    await at(300);
    expect(net.bodies().slice(4)).toEqual([['d']]);

    for (const call of net.calls.slice(1)) call.echo();
    await at(400);
    expect(a.results).toEqual([ok('T:a'), ok('T:b')]);
    expect(b.results).toEqual([ok('T:a'), ok('T:c')]);
    expect(c.results).toEqual([ok('T:b'), ok('T:d')]);
  });

  it('keeps a batch running while any segment has a subscriber, and caches orphans', async () => {
    const { net, scheduler, persisted, submit } = setup();
    const a = submit(['a', 'b'], { adapter: MT4 });
    const b = submit(['b'], { caller: 'B', adapter: MT4 });
    await at(0);
    a.cancel();
    await at(1);
    expect(a.results).toEqual([err('network/aborted'), err('network/aborted')]);
    expect(net.aborts()).toBe(0);
    expect(scheduler.inspect().active.mt).toBe(1);

    net.calls[0]?.echo();
    await at(2);
    expect(b.results).toEqual([ok('T:b')]);
    expect(persisted).toEqual([
      { key: 'k:a', text: 'T:a' },
      { key: 'k:b', text: 'T:b' },
    ]);
  });

  it('aborts the request once every segment has lost its subscribers', async () => {
    const { net, scheduler, persisted, submit } = setup();
    const a = submit(['a', 'b'], { adapter: MT4 });
    const b = submit(['b'], { caller: 'B', adapter: MT4 });
    await at(0);
    a.cancel();
    await at(1);
    expect(net.aborts()).toBe(0);
    b.cancel();
    await at(2);
    expect(net.aborts()).toBe(1);
    expect(net.calls[0]?.signal.aborted).toBe(true);
    expect(scheduler.inspect()).toMatchObject({ active: { mt: 0 }, segments: 0, queued: 0 });
    expect(persisted).toEqual([]);
    // The keys are free again: a new caller gets a fresh request.
    submit(['a'], { caller: 'C', adapter: MT4 });
    await at(100);
    expect(net.calls).toHaveLength(2);
  });

  it('drops queued halves nobody waits for, keeps halves a newcomer subscribed to', async () => {
    const { net, persisted, submit } = setup();
    const a = submit(['a', 'b', 'c', 'd'], { adapter: MT4 });
    await at(0);
    net.calls[0]?.reply({ status: 200, texts: ['x'] }); // split while the halves wait for the interval
    await at(10);
    const b = submit(['c', 'e'], { caller: 'B', adapter: MT4 });
    a.cancel();
    await at(1000);
    expect(net.bodies()).toEqual([['a', 'b', 'c', 'd'], ['c', 'd'], ['e']]);
    expect(net.aborts()).toBe(0);
    net.calls[1]?.echo();
    net.calls[2]?.echo();
    await at(1001);
    expect(b.results).toEqual([ok('T:c'), ok('T:e')]);
    expect(persisted.map((entry) => entry.key).sort()).toEqual(['k:c', 'k:d', 'k:e']);
  });

  it('does not dispatch a split half whose segments were abandoned before the split', async () => {
    const { net, persisted, submit } = setup();
    const a = submit(['a', 'b', 'c', 'd'], { adapter: MT4 });
    const b = submit(['c', 'd'], { caller: 'B', adapter: MT4 });
    await at(0);
    a.cancel(); // the batch keeps running for B
    await at(1);
    expect(net.aborts()).toBe(0);
    net.calls[0]?.reply({ status: 200, texts: ['x'] });
    await at(1000);
    expect(net.bodies()).toEqual([
      ['a', 'b', 'c', 'd'],
      ['c', 'd'],
    ]);
    net.calls[1]?.echo();
    await at(1001);
    expect(b.results).toEqual([ok('T:c'), ok('T:d')]);
    expect(persisted.map((entry) => entry.key)).toEqual(['k:c', 'k:d']);
  });

  it('aborts an in-flight half when its subscribers cancel; newcomers subscribe to the other', async () => {
    const { net, scheduler, persisted, submit } = setup();
    const a = submit(['a', 'b', 'c', 'd'], { adapter: MT4 });
    const b = submit(['c', 'd'], { caller: 'B', adapter: MT4 });
    await at(0);
    net.calls[0]?.reply({ status: 200, texts: ['x'] });
    await at(100);
    expect(net.bodies().slice(1)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);

    a.cancel();
    await at(101);
    expect(net.calls[1]?.aborted).toBe(true);
    expect(net.calls[2]?.aborted).toBe(false);
    expect(net.aborts()).toBe(1);

    const late = submit(['d'], { caller: 'C', adapter: MT4 }); // joins the running half
    const fresh = submit(['a'], { caller: 'D', adapter: MT4 }); // its half was abandoned
    await at(200);
    expect(net.bodies().slice(3)).toEqual([['a']]);
    expect(scheduler.inspect().active.mt).toBe(2);

    net.calls[2]?.echo();
    net.calls[3]?.echo();
    await at(201);
    expect(b.results).toEqual([ok('T:c'), ok('T:d')]);
    expect(late.results).toEqual([ok('T:d')]);
    expect(fresh.results).toEqual([ok('T:a')]);
    expect(persisted.map((entry) => entry.key).sort()).toEqual(['k:a', 'k:c', 'k:d']);
  });

  it('reports an empty translation as an error and does not cache it', async () => {
    const { net, persisted, submit } = setup();
    const { results } = submit(['a', 'b'], { adapter: MT4 });
    await at(0);
    net.calls[0]?.reply({ status: 200, texts: ['T:a', ' ​ '] });
    await at(1);
    expect(results).toEqual([ok('T:a'), err('validation/empty-translation')]);
    expect(persisted).toEqual([{ key: 'k:a', text: 'T:a' }]);
  });

  it('returns a translation that echoes source sentences but does not cache it', async () => {
    const { net, persisted, submit } = setup();
    const source =
      'Use chat to explore and iterate. Once you find a way of working you want, put it in an SOP.';
    const echoed =
      '使用聊天来探索和迭代。 Once you find a way of working you want, put it in an SOP.';
    const { results } = submit([source, 'b'], { adapter: MT4 });
    await at(0);
    net.calls[0]?.reply({ status: 200, texts: [echoed, 'T:b'] });
    await at(1);
    expect(results).toEqual([ok(echoed), ok('T:b')]);
    expect(persisted).toEqual([{ key: 'k:b', text: 'T:b' }]);
  });
});

describe('scheduler: lifecycle', () => {
  it('starts empty on a new instance (SW restart)', async () => {
    const { net, scheduler, submit } = setup();
    submit(['a', 'b'], { adapter: LLM, engine: 'openai' });
    submit(['c'], { caller: 'B', adapter: LLM, engine: 'openai' });
    await at(100);
    expect(scheduler.inspect()).toMatchObject({ active: { llm: 1 }, segments: 3, callers: 2 });

    const restarted = createScheduler({ fetch: net.fetch });
    expect(restarted.inspect()).toEqual({
      active: { mt: 0, llm: 0 },
      queued: 0,
      waiting: 0,
      segments: 0,
      callers: 0,
    });
    const again = submit(['a'], { caller: 'A2', adapter: LLM, engine: 'openai' }, restarted);
    await at(101);
    expect(net.calls).toHaveLength(2); // no dedupe with the old instance
    net.calls[1]?.echo();
    await at(102);
    expect(again.results).toEqual([ok('T:a')]);
  });

  it('uses the documented limits', () => {
    expect(SCHEDULER_LIMITS.mt).toMatchObject({
      concurrency: 6,
      intervalMs: 50,
      headerTimeoutMs: 15_000,
      deadlineMs: 30_000,
    });
    expect(SCHEDULER_LIMITS.llm).toMatchObject({
      concurrency: 3,
      intervalMs: 200,
      headerTimeoutMs: 25_000,
      idleTimeoutMs: 60_000,
      deadlineMs: 180_000,
    });
  });
});

// ------------------------------------------------------------ streaming

interface StreamCall {
  texts: string[];
  signal: AbortSignal;
  push(delta: string): void;
  end(text?: string): void;
  fail(error: ReturnType<typeof appError>): void;
}

/** LLM adapter whose increments the test pushes by hand; it never fetches. */
function streamingAdapter(kind: 'mt' | 'llm' = 'llm') {
  const streams: StreamCall[] = [];
  const adapter: ProviderAdapter = {
    kind,
    limits: { maxItems: 20, maxChars: 100_000 },
    async *translate(batch, ctx) {
      const queue: (ProviderEvent | ReturnType<typeof appError>)[] = [];
      let wake: () => void = () => undefined;
      const notify = () => wake();
      ctx.signal.addEventListener('abort', notify, { once: true });
      streams.push({
        texts: batch,
        signal: ctx.signal,
        push: (delta) => {
          queue.push({ type: 'delta', index: 0, delta });
          notify();
        },
        end: (text = `T:${batch[0]}`) => {
          batch.forEach((_, index) => {
            queue.push({ type: 'item', index, text: index === 0 ? text : `T:${batch[index]}` });
          });
          notify();
        },
        fail: (error) => {
          queue.push(error);
          notify();
        },
      });
      let items = 0;
      while (items < batch.length) {
        if (ctx.signal.aborted) throw abortedError();
        const next = queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (!('type' in next)) throw next;
        if (next.type === 'item') items += 1;
        yield next;
      }
    },
  };
  return { adapter, streams };
}

const serverError = () =>
  appError('provider', 'provider/server-error', 'HTTP 500', { retryable: true });

function submitStream(
  scheduler: Scheduler,
  texts: string[],
  options: { caller?: string; adapter: ProviderAdapter; listen?: boolean },
) {
  const controller = new AbortController();
  const events: string[] = [];
  const results: (ItemOutcome | undefined)[] = texts.map(() => undefined);
  const listen = options.listen ?? true;
  const outcomes = scheduler.submit({
    caller: options.caller ?? 'S',
    signal: controller.signal,
    engine: 'openai',
    adapter: options.adapter,
    context: CONTEXT,
    segments: texts.map((text) => ({ key: `k:${text}`, text })),
    onDelta: listen ? (key, delta) => events.push(`${key} +${delta}`) : undefined,
    onReset: listen ? (key) => events.push(`${key} reset`) : undefined,
  });
  outcomes.forEach((outcome, index) => {
    void outcome.then((result) => {
      results[index] = result;
      events.push(`${texts[index]} final`);
    });
  });
  return { events, results, cancel: () => controller.abort() };
}

describe('scheduler: streaming', () => {
  it('resets, then forwards increments at most every 50ms, flushing before the result', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const s = submitStream(scheduler, ['x'], { adapter });
    await at(0);
    const stream = streams[0] as StreamCall;
    stream.push('a');
    await at(0);
    expect(s.events).toEqual(['k:x reset', 'k:x +a']);
    await at(10);
    stream.push('b');
    await at(20);
    stream.push('c');
    await at(49);
    expect(s.events).toEqual(['k:x reset', 'k:x +a']);
    await at(50);
    expect(s.events).toEqual(['k:x reset', 'k:x +a', 'k:x +bc']);
    await at(120);
    stream.push('d');
    await at(120);
    expect(s.events.at(-1)).toBe('k:x +d');
    stream.push('e');
    stream.end('abcde');
    await at(130);
    expect(s.events.slice(-2)).toEqual(['k:x +e', 'x final']);
    expect(s.results).toEqual([ok('abcde')]);
    expect(SCHEDULER_STREAM.flushMs).toBe(50);
  });

  it('resets before every attempt and never replays the failed attempt', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const s = submitStream(scheduler, ['x'], { adapter });
    await at(0);
    streams[0]?.push('半');
    await at(10);
    streams[0]?.push('截');
    streams[0]?.fail(serverError());
    await at(100);
    expect(s.events).toEqual(['k:x reset', 'k:x +半']);
    // Failed at 10ms; the retry waits 1s (no jitter in these tests).
    await at(1009);
    expect(streams).toHaveLength(1);
    await at(1010);
    expect(streams).toHaveLength(2);
    expect(s.events).toEqual(['k:x reset', 'k:x +半', 'k:x reset']);
    streams[1]?.push('全文');
    streams[1]?.end('全文');
    await at(1100);
    expect(s.events).toEqual(['k:x reset', 'k:x +半', 'k:x reset', 'k:x +全文', 'x final']);
    expect(s.results).toEqual([ok('全文')]);
  });

  it('ends a runaway stream with output-truncated past max(2000, 8 x source)', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const s = submitStream(scheduler, ['hi'], { adapter });
    await at(0);
    streams[0]?.push('x'.repeat(1500));
    streams[0]?.push('x'.repeat(501));
    await at(10);
    expect(s.results).toEqual([err('provider/output-truncated')]);
    await at(5000);
    expect(streams).toHaveLength(1);

    // Exactly at the cap passes: 2000 chars for a short source.
    const exact = submitStream(scheduler, ['hi2'], { adapter });
    await at(5000);
    streams[1]?.push('x'.repeat(2000));
    streams[1]?.end('done');
    await at(5100);
    expect(exact.results).toEqual([ok('done')]);

    const long = 'y'.repeat(500);
    const t = submitStream(scheduler, [long], { adapter });
    await at(5300);
    streams[2]?.push('z'.repeat(4000));
    streams[2]?.end('done');
    await at(5400);
    expect(t.results).toEqual([ok('done')]);
  });

  it('an interactive job waits out a cooldown too (it skips only the start interval)', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    submitStream(scheduler, ['x'], { adapter });
    await at(0);
    streams[0]?.fail(
      appError('rate-limit', 'rate-limit/too-many-requests', 'HTTP 429', {
        retryable: true,
        retryAfterMs: 3000,
      }),
    );
    await at(100);
    // A new card's request on the same engine, mid-cooldown.
    const late = submitStream(scheduler, ['y'], { caller: 'T', adapter });
    await at(2999);
    expect(streams).toHaveLength(1);
    expect(late.events).toEqual([]);
    await at(3001);
    // Cooldown over: one probe at a time.
    expect(streams).toHaveLength(2);
  });

  it('runs every stream segment as a batch of its own', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    submitStream(scheduler, ['a', 'b'], { adapter, caller: 'P', listen: false });
    submitStream(scheduler, ['c', 'd'], { adapter });
    await at(1000);
    expect(streams.map((stream) => stream.texts)).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('starts a stream before queued jobs of every caller', async () => {
    const { net, scheduler, submit } = setup();
    submit(Array.from({ length: 8 }, (_, i) => `a${i}`));
    await at(1000);
    expect(net.calls).toHaveLength(6);
    // B is next in the round-robin turn when the slot frees up.
    submit(['b0'], { caller: 'B' });
    const { adapter, streams } = streamingAdapter('mt');
    submitStream(scheduler, ['s'], { adapter });
    await at(1100);
    expect(streams).toHaveLength(0);
    net.calls[0]?.echo();
    await at(1200);
    expect(streams.map((stream) => stream.texts)).toEqual([['s']]);
    expect(net.calls).toHaveLength(6);
  });

  it('starts a stream right after a page request starts, without the LLM start interval', async () => {
    const { net, scheduler, submit } = setup();
    submit(['a', 'b', 'c'], { adapter: LLM, engine: 'openai' });
    await at(10);
    expect(net.calls.map((call) => call.at)).toEqual([0]);
    const { adapter, streams } = streamingAdapter();
    submitStream(scheduler, ['s'], { adapter });
    await at(10);
    // Not held until 200ms: the card's first token does not wait for the page's pacing.
    expect(streams).toHaveLength(1);
    streams[0]?.end();
    // The page requests keep their own pace, untouched by the stream's start.
    await at(1000);
    expect(net.calls.map((call) => call.at)).toEqual([0, 200, 400]);
  });

  it('starts a stream at once on the reserved LLM slot while 3 page requests run', async () => {
    const { net, scheduler, submit } = setup();
    submit(['a', 'b', 'c', 'd'], { adapter: LLM, engine: 'openai' });
    await at(1000);
    expect(net.calls).toHaveLength(3);
    const { adapter, streams } = streamingAdapter();
    const first = submitStream(scheduler, ['s1'], { adapter });
    await at(1000);
    expect(streams).toHaveLength(1);
    expect(scheduler.inspect().active.llm).toBe(4);
    // Only one reserved slot, and page requests never take it.
    submitStream(scheduler, ['s2'], { adapter, caller: 'S2' });
    await at(2000);
    expect(streams).toHaveLength(1);
    streams[0]?.end();
    await at(2100);
    expect(first.results).toEqual([ok('T:s1')]);
    expect(streams).toHaveLength(2);
    streams[1]?.end();
    await at(2200);
    expect(net.calls).toHaveLength(3);
    expect(scheduler.inspect()).toMatchObject({ queued: 1, active: { llm: 3 } });
  });

  it('gives a caller that joins an in-flight segment only the final result', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const first = submitStream(scheduler, ['x'], { adapter });
    await at(0);
    streams[0]?.push('a');
    await at(10);
    const joined = submitStream(scheduler, ['x'], { adapter, caller: 'S2' });
    streams[0]?.push('b');
    streams[0]?.end('ab');
    await at(100);
    expect(streams).toHaveLength(1);
    expect(first.events).toEqual(['k:x reset', 'k:x +a', 'k:x +b', 'x final']);
    expect(joined.events).toEqual(['x final']);
    expect(joined.results).toEqual([ok('ab')]);
  });

  it('promotes a queued page job to the front and the reserved slot when a stream joins it', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    for (const text of ['a', 'b', 'c', 'e', 'd']) {
      submitStream(scheduler, [text], { adapter, caller: 'P', listen: false });
    }
    await at(1000);
    expect(streams.map((stream) => stream.texts)).toEqual([['a'], ['b'], ['c']]);
    expect(scheduler.inspect()).toMatchObject({ queued: 2, active: { llm: 3 } });

    const joined = submitStream(scheduler, ['d'], { adapter, caller: 'S' });
    await at(1100);
    // d starts at once on the reserved slot, ahead of e; it is not stuck behind the page queue.
    expect(streams.map((stream) => stream.texts)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(scheduler.inspect()).toMatchObject({ queued: 1, active: { llm: 4 } });
    streams[3]?.end('D');
    await at(1200);
    expect(joined.results).toEqual([ok('D')]);
    // The joiner never started the segment, so it gets only the final result.
    expect(joined.events).toEqual(['d final']);
  });

  it('keeps waiting when a stream joins a page job that already started', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    for (const text of ['a', 'b', 'c', 'd']) {
      submitStream(scheduler, [text], { adapter, caller: 'P', listen: false });
    }
    await at(1000);
    const joined = submitStream(scheduler, ['a'], { adapter, caller: 'S' });
    await at(1100);
    expect(streams).toHaveLength(3);
    streams[0]?.end('A');
    await at(1200);
    expect(joined.results).toEqual([ok('A')]);
  });

  it('cleans up a retry wait cancelled mid-stream: no timer, no reset, no delta', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const s = submitStream(scheduler, ['x'], { adapter });
    await at(0);
    streams[0]?.push('半');
    await at(10);
    streams[0]?.fail(serverError());
    await at(100);
    expect(scheduler.inspect()).toMatchObject({ waiting: 1 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    s.cancel();
    await at(200);
    expect(s.results).toEqual([err('network/aborted')]);
    expect(scheduler.inspect()).toMatchObject({ waiting: 0, queued: 0, segments: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await at(5000);
    expect(streams).toHaveLength(1);
    expect(s.events).toEqual(['k:x reset', 'k:x +半', 'x final']);
  });

  it('sends a reset but no delta for an adapter that does not stream (Google)', async () => {
    const { net, scheduler } = setup();
    const events: string[] = [];
    const controller = new AbortController();
    const [outcome] = scheduler.submit({
      caller: 'S',
      signal: controller.signal,
      engine: 'google',
      adapter: MT,
      context: CONTEXT,
      segments: [{ key: 'k:x', text: 'x' }],
      onDelta: (key, delta) => events.push(`${key} +${delta}`),
      onReset: (key) => events.push(`${key} reset`),
    });
    await at(0);
    expect(events).toEqual(['k:x reset']);
    net.calls[0]?.echo();
    await at(100);
    expect(await outcome).toEqual(ok('T:x'));
    expect(events).toEqual(['k:x reset']);
  });

  it('stops forwarding and aborts the provider on cancel', async () => {
    const { scheduler } = setup();
    const { adapter, streams } = streamingAdapter();
    const s = submitStream(scheduler, ['x'], { adapter });
    await at(0);
    streams[0]?.push('a');
    await at(10);
    streams[0]?.push('b');
    s.cancel();
    await at(200);
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(s.results).toEqual([err('network/aborted')]);
    expect(s.events).toEqual(['k:x reset', 'k:x +a', 'x final']);
    expect(scheduler.inspect()).toMatchObject({ active: { llm: 0 }, segments: 0 });
  });
});
