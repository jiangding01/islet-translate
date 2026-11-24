import { type AppError, type Result, toAppError } from '@/lib/errors';
import { chunkByLimits, type ItemOutcome, isSplittableError, splitInHalf } from './codec';
import { isEchoedTranslation } from './echo';
import {
  abortedError,
  badResponseError,
  emptyTranslationError,
  MAX_RETRY_AFTER_MS,
  outputTruncatedError,
  timeoutError,
} from './providers/errors';
import type { ProviderAdapter, ProviderContext, ProviderEvent } from './types';

// Background-only request scheduler. Everything lives in memory: a new instance
// (SW restart) starts empty, and callers resend whatever was unfinished.

type Kind = ProviderAdapter['kind'];

interface KindLimits {
  /** Real requests in flight: a slot is held until the underlying fetch settles. */
  concurrency: number;
  /** Minimum gap between two request starts. */
  intervalMs: number;
  /** Per fetch: time allowed until response headers arrive. */
  headerTimeoutMs: number;
  /** LLM streams: idle gap allowed between chunks, counted from the first chunk. */
  idleTimeoutMs: number | undefined;
  /** Per segment, from submission: covers queueing, retries, splits and fallbacks. */
  deadlineMs: number;
}

export const SCHEDULER_LIMITS: Readonly<Record<Kind, KindLimits>> = {
  mt: {
    concurrency: 6,
    intervalMs: 50,
    headerTimeoutMs: 15_000,
    idleTimeoutMs: undefined,
    deadlineMs: 30_000,
  },
  llm: {
    concurrency: 3,
    intervalMs: 200,
    headerTimeoutMs: 25_000,
    idleTimeoutMs: 60_000,
    deadlineMs: 180_000,
  },
};

/**
 * Stream (interactive) submissions:
 * - `flushMs`: increments are forwarded at most this often;
 * - output beyond max(`minOutput`, source length × `outputFactor`) ends the
 *   attempt with `provider/output-truncated`;
 * - `reserve`: LLM slots on top of the shared limit that only streams may take,
 *   so a running page translation never delays a selection card.
 */
export const SCHEDULER_STREAM = {
  flushMs: 50,
  minOutput: 2000,
  outputFactor: 8,
  reserve: { mt: 0, llm: 1 },
} as const;

export const MAX_RETRIES = 1;
export const RETRY_BASE_MS = 1000;
export const RETRY_JITTER = 0.1;
/** Cooldown after a 429 without `retry-after`. */
export const DEFAULT_COOLDOWN_MS = 2000;
/** Defensive ceiling for any cooldown, whatever the error says. */
export const MAX_COOLDOWN_MS = MAX_RETRY_AFTER_MS;

/** Provider context minus what the scheduler owns per attempt. */
export type TaskContext = Omit<ProviderContext, 'signal' | 'fetch' | 'idleTimeoutMs'>;

export interface CacheEntry {
  key: string;
  text: string;
}

export interface ScheduleRequest {
  /** Fairness group: one per Port (the options page test is its own group). */
  caller: string;
  /** Aborting unsubscribes this caller from every segment it requested. */
  signal: AbortSignal;
  engine: string;
  /**
   * Cooldown and probe scope; defaults to `engine`. The service passes
   * `engine|origin` (Google: `google`), connection tests a key of their own.
   */
  cooldownKey?: string;
  adapter: ProviderAdapter;
  context: TaskContext;
  /** `key` is the cache key: equal keys share one translation. */
  segments: readonly { key: string; text: string }[];
  /**
   * Called once when an attempt succeeds while its job still runs, with every
   * non-empty translation it delivered, including segments nobody waits for
   * anymore, except those that echo source sentences (see isEchoedTranslation).
   * Never after a failed, timed-out or abandoned attempt, even for the items it
   * delivered early: they were not checked against the whole answer. Omit to skip
   * caching.
   */
  persist?: (entries: CacheEntry[]) => unknown;
  /** Shorter segment deadline than the adapter kind's default (connection tests). */
  deadlineMs?: number;
  /**
   * Increments of a segment this submission started, coalesced (SCHEDULER_STREAM).
   * With `onReset`, makes the submission interactive: every segment runs alone,
   * jumps the queue and may use the reserved LLM slot. A caller that joins a
   * segment already in flight gets neither callback, only the outcome.
   */
  onDelta?: (key: string, delta: string) => void;
  /** Called before every attempt (retries included) of a segment this submission started. */
  onReset?: (key: string) => void;
}

export interface SchedulerSnapshot {
  /** Slots held per kind (includes aborted requests whose fetch has not settled). */
  active: Record<Kind, number>;
  queued: number;
  /** Jobs waiting for a retry backoff. */
  waiting: number;
  /** Segments that are queued or in flight (the dedupe table). */
  segments: number;
  callers: number;
}

export interface Scheduler {
  /** One outcome promise per input segment, in order. Never rejects. */
  submit(request: ScheduleRequest): Promise<ItemOutcome>[];
  inspect(): SchedulerSnapshot;
}

export interface SchedulerDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

interface Subscriber {
  done: boolean;
  resolve(outcome: ItemOutcome): void;
}

interface Segment {
  key: string;
  text: string;
  subscribers: Set<Subscriber>;
  /** The job currently responsible for this segment. */
  job: Job | undefined;
}

/** Shared by every job (batch, retry, split half) derived from one submission. */
interface Task {
  caller: string;
  cooldownKey: string;
  adapter: ProviderAdapter;
  context: TaskContext;
  persist: ScheduleRequest['persist'];
  deadline: number;
  /** Set for interactive (stream) submissions. */
  stream: StreamSink | undefined;
}

interface StreamSink {
  /** The submitter's signal: once aborted, nothing more is forwarded. */
  signal: AbortSignal;
  onDelta: ScheduleRequest['onDelta'];
  onReset: ScheduleRequest['onReset'];
}

interface Job {
  task: Task;
  segments: Segment[];
  retries: number;
  state: 'queued' | 'waiting' | 'running' | 'done';
  probe: boolean;
  epoch: number;
  controller: AbortController | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

/** A segment and its translation from one attempt. */
interface Pair {
  segment: Segment;
  text: string;
}

interface CooldownState {
  cooldownUntil: number;
  /** Set by a 429; cleared only by a successful probe started after the latest 429. */
  recovering: boolean;
  probeInFlight: boolean;
  /** Bumped on every 429, so an older request's late success cannot end recovery. */
  epoch: number;
}

const ZERO_WIDTH = /[​-‍﻿]/g;

function isBlank(text: string): boolean {
  return text.replace(ZERO_WIDTH, '').trim() === '';
}

function failure(error: AppError): ItemOutcome {
  return { ok: false, error };
}

/** An empty translation fails its segment. */
function outcomeOf(text: string): ItemOutcome {
  return isBlank(text) ? failure(emptyTranslationError()) : { ok: true, text };
}

/** Listener errors never reach the attempt. */
function safely(callback: () => void) {
  try {
    callback();
  } catch {
    // The caller's problem, not the provider's.
  }
}

async function collectItems(
  events: AsyncIterable<ProviderEvent>,
  count: number,
  onDelta?: (delta: string) => void,
) {
  const texts: (string | undefined)[] = new Array(count).fill(undefined);
  for await (const event of events) {
    if (event.type === 'delta') {
      onDelta?.(event.delta);
      continue;
    }
    if (event.index < 0 || event.index >= count || texts[event.index] !== undefined) {
      throw badResponseError('Unexpected item index');
    }
    texts[event.index] = event.text;
  }
  if (texts.some((text) => text === undefined)) throw badResponseError('Item count mismatch');
  return texts as string[];
}

/**
 * Wraps fetch for one attempt: aborts when response headers take too long, and
 * rejects as soon as the signal aborts even if the underlying fetch ignores it.
 * The underlying promise is handed to `track`, so the slot stays held until the
 * request has really ended.
 */
function createAttemptFetch(
  base: typeof fetch,
  headerTimeoutMs: number,
  track: (request: Promise<unknown>) => void,
): typeof fetch {
  return (input, init) => {
    const outer = init?.signal ?? undefined;
    const header = new AbortController();
    const signal = outer ? AbortSignal.any([outer, header.signal]) : header.signal;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(header.signal.aborted && !outer?.aborted ? timeoutError() : abortedError());
    });
    const timer = setTimeout(() => header.abort(), headerTimeoutMs);
    let request: Promise<Response>;
    try {
      request = base(input, { ...init, signal });
    } catch (error) {
      request = Promise.reject(error);
    }
    track(
      request.then(
        () => undefined,
        () => undefined,
      ),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return Promise.race([request, aborted]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  };
}

/**
 * Batches, deduplicates and runs translation requests:
 * - per-kind concurrency and start interval; a slot is released only after the
 *   attempt's fetches have settled, never early on abort or timeout;
 * - header timeout per fetch, idle timeout for LLM streams, and a per-segment
 *   deadline shared by retries, splits and Google's per-item fallback;
 * - at most one retry of retryable errors (1s × 2^n + 0–10% jitter, or retryAfterMs);
 * - per-cooldown-key pause after a 429 (at most 60s), then one probe at a time
 *   until a probe succeeds;
 * - round-robin across callers; interactive (stream) jobs go first, alone, skip the
 *   start interval (without moving it for page jobs) and may use the reserved LLM slot;
 * - segment-level dedupe by cache key, subscriptions counted per segment;
 * - page jobs: each item is delivered (and leaves the job) as soon as it arrives;
 *   retries, splits and the deadline apply to what is left; only a successful
 *   attempt is cached;
 * - streams: reset before every attempt, increments coalesced, output capped.
 */
export function createScheduler(deps: SchedulerDeps = {}): Scheduler {
  const baseFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  /** Dedupe table: segments that are queued or in flight. */
  const segments = new Map<string, Segment>();
  const queues = new Map<string, Job[]>();
  /** Round-robin order of callers with queued jobs; `cursor` is the next one to serve. */
  const order: string[] = [];
  let cursor = 0;
  const active: Record<Kind, number> = { mt: 0, llm: 0 };
  const nextStartAt: Record<Kind, number> = { mt: 0, llm: 0 };
  const cooldowns = new Map<string, CooldownState>();
  let waiting = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let pumping = false;
  let pumpAgain = false;

  function cooldownState(key: string): CooldownState {
    let state = cooldowns.get(key);
    if (!state) {
      state = { cooldownUntil: 0, recovering: false, probeInFlight: false, epoch: 0 };
      cooldowns.set(key, state);
    }
    return state;
  }

  // ------------------------------------------------------------ queues

  function enqueue(job: Job, front: boolean) {
    let queue = queues.get(job.task.caller);
    if (!queue) {
      queue = [];
      queues.set(job.task.caller, queue);
      order.push(job.task.caller);
    }
    if (front) queue.unshift(job);
    else queue.push(job);
    job.state = 'queued';
  }

  function dropCaller(caller: string) {
    queues.delete(caller);
    const position = order.indexOf(caller);
    if (position === -1) return;
    order.splice(position, 1);
    if (position < cursor) cursor -= 1;
  }

  function dequeue(job: Job) {
    const queue = queues.get(job.task.caller);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) dropCaller(job.task.caller);
  }

  /** `true` when the job may start now; otherwise the time to look again (Infinity: on release). */
  function gate(job: Job, time: number): true | number {
    const kind = job.task.adapter.kind;
    const cooldown = cooldownState(job.task.cooldownKey);
    if (cooldown.cooldownUntil > time) return cooldown.cooldownUntil;
    if (cooldown.recovering && cooldown.probeInFlight) return Number.POSITIVE_INFINITY;
    const limit =
      SCHEDULER_LIMITS[kind].concurrency + (job.task.stream ? SCHEDULER_STREAM.reserve[kind] : 0);
    if (active[kind] >= limit) return Number.POSITIVE_INFINITY;
    // Interactive jobs skip the start interval: it paces page work, not a waiting reader.
    if (!job.task.stream && nextStartAt[kind] > time) return nextStartAt[kind];
    return true;
  }

  /** Next startable job: interactive ones first, then callers in turn starting at `cursor`. */
  function pick(): { job?: Job; wakeAt: number } {
    const time = now();
    let wakeAt = Number.POSITIVE_INFINITY;
    for (const caller of order) {
      for (const job of queues.get(caller) ?? []) {
        if (!job.task.stream) continue;
        const result = gate(job, time);
        if (result === true) {
          dequeue(job);
          return { job, wakeAt };
        }
        wakeAt = Math.min(wakeAt, result);
      }
    }
    const count = order.length;
    for (let step = 0; step < count; step += 1) {
      const position = (cursor + step) % count;
      const caller = order[position];
      const queue = caller === undefined ? undefined : queues.get(caller);
      if (!caller || !queue) continue;
      for (const job of queue) {
        const result = gate(job, time);
        if (result === true) {
          cursor = position + 1;
          dequeue(job);
          return { job, wakeAt };
        }
        wakeAt = Math.min(wakeAt, result);
      }
    }
    return { wakeAt };
  }

  function arm(at: number) {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    if (!Number.isFinite(at)) return;
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined;
        pump();
      },
      Math.max(0, at - now()),
    );
  }

  function pump() {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        for (;;) {
          const { job, wakeAt } = pick();
          if (!job) {
            arm(wakeAt);
            break;
          }
          start(job);
        }
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  }

  // ------------------------------------------------------------ jobs

  function createJob(task: Task, members: Segment[]): Job {
    const job: Job = {
      task,
      segments: members,
      retries: 0,
      state: 'queued',
      probe: false,
      epoch: 0,
      controller: undefined,
      deadlineTimer: undefined,
      retryTimer: undefined,
    };
    for (const segment of members) segment.job = job;
    job.deadlineTimer = setTimeout(() => expire(job), Math.max(0, task.deadline - now()));
    return job;
  }

  /** Takes the job out of the queue or retry wait and clears its timers. Does not abort. */
  function retire(job: Job) {
    if (job.state === 'queued') dequeue(job);
    if (job.state === 'waiting') {
      clearTimeout(job.retryTimer);
      waiting -= 1;
    }
    clearTimeout(job.deadlineTimer);
    job.retryTimer = undefined;
    job.deadlineTimer = undefined;
    job.state = 'done';
  }

  function release(segment: Segment) {
    if (segments.get(segment.key) === segment) segments.delete(segment.key);
    segment.job = undefined;
  }

  function deliver(subscriber: Subscriber, outcome: ItemOutcome) {
    if (subscriber.done) return;
    subscriber.done = true;
    subscriber.resolve(outcome);
  }

  /** Releases the segment and hands the outcome to everyone waiting for it. */
  function resolveSegment(segment: Segment, outcome: ItemOutcome) {
    release(segment);
    for (const subscriber of [...segment.subscribers]) deliver(subscriber, outcome);
    segment.subscribers.clear();
  }

  function settle(job: Job, outcomeFor: (segment: Segment) => ItemOutcome) {
    retire(job);
    for (const segment of job.segments) resolveSegment(segment, outcomeFor(segment));
  }

  /** Segment deadline reached: abort whatever is running and fail every segment. */
  function expire(job: Job) {
    if (job.state === 'done') return;
    if (job.state === 'running') job.controller?.abort();
    const error = timeoutError();
    settle(job, () => failure(error));
    pump();
  }

  /** Called when a segment loses its last subscriber. */
  function abandonIfOrphaned(job: Job | undefined) {
    if (!job || job.state === 'done') return;
    if (job.segments.some((segment) => segment.subscribers.size > 0)) return;
    if (job.state === 'running') job.controller?.abort();
    for (const segment of job.segments) release(segment);
    retire(job);
  }

  function start(job: Job) {
    const kind = job.task.adapter.kind;
    active[kind] += 1;
    // Only page jobs set the pace, so an interactive start never delays the next page one.
    if (!job.task.stream) nextStartAt[kind] = now() + SCHEDULER_LIMITS[kind].intervalMs;
    const cooldown = cooldownState(job.task.cooldownKey);
    job.probe = cooldown.recovering;
    if (job.probe) cooldown.probeInFlight = true;
    job.epoch = cooldown.epoch;
    job.state = 'running';
    void execute(job);
  }

  /**
   * Per-attempt stream state: resets the caller, coalesces increments and caps the
   * output. Nothing is forwarded once the submitter left or the job is no longer running.
   */
  function openStream(job: Job, sink: StreamSink) {
    const segment = job.segments[0];
    const live = () => !sink.signal.aborted && job.state === 'running';
    const key = segment?.key ?? '';
    const cap = Math.max(
      SCHEDULER_STREAM.minOutput,
      (segment?.text.length ?? 0) * SCHEDULER_STREAM.outputFactor,
    );
    let total = 0;
    let pending = '';
    let lastFlush = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (pending === '') return;
      const delta = pending;
      pending = '';
      lastFlush = now();
      if (live()) safely(() => sink.onDelta?.(key, delta));
    };

    if (live()) safely(() => sink.onReset?.(key));
    return {
      push(delta: string) {
        total += delta.length;
        if (total > cap) throw outputTruncatedError();
        pending += delta;
        const wait = lastFlush + SCHEDULER_STREAM.flushMs - now();
        if (wait <= 0) flush();
        else if (timer === undefined) timer = setTimeout(flush, wait);
      },
      /** Delivers what is pending after a success; drops it otherwise (a reset or an error follows). */
      close(succeeded: boolean) {
        if (succeeded) {
          flush();
          return;
        }
        clearTimeout(timer);
        timer = undefined;
        pending = '';
      },
    };
  }

  async function execute(job: Job): Promise<void> {
    const { adapter, context } = job.task;
    const stream = job.task.stream ? openStream(job, job.task.stream) : undefined;
    const limits = SCHEDULER_LIMITS[adapter.kind];
    const controller = new AbortController();
    job.controller = controller;
    const requests: Promise<unknown>[] = [];
    const attemptFetch = createAttemptFetch(baseFetch, limits.headerTimeoutMs, (request) => {
      requests.push(request);
    });
    // Indices refer to the members at the start of the attempt: job.segments shrinks
    // as items are delivered.
    const members = [...job.segments];
    const texts = members.map((segment) => segment.text);
    /** Translations this attempt delivered, cached together when it ends. */
    const pairs: Pair[] = [];

    let result: Result<undefined>;
    try {
      const events = adapter.translate(texts, {
        ...context,
        signal: controller.signal,
        fetch: attemptFetch,
        idleTimeoutMs: limits.idleTimeoutMs,
      });
      if (stream) {
        // Streams deliver only after their last increment, never early.
        const data = await collectItems(events, texts.length, stream.push);
        for (const [index, segment] of members.entries()) {
          pairs.push({ segment, text: data[index] ?? '' });
        }
      } else {
        const seen = new Set<number>();
        for await (const event of events) {
          if (event.type !== 'item') continue;
          const segment = members[event.index];
          if (!segment || seen.has(event.index)) throw badResponseError('Unexpected item index');
          seen.add(event.index);
          // A job that already ended (deadline, every subscriber gone) takes nothing more.
          if (job.state !== 'running') continue;
          pairs.push({ segment, text: event.text });
          job.segments = job.segments.filter((member) => member !== segment);
          resolveSegment(segment, outcomeOf(event.text));
        }
        if (seen.size < members.length) throw badResponseError('Item count mismatch');
      }
      result = { ok: true, data: undefined };
    } catch (error) {
      result = { ok: false, error: toAppError(error) };
    }
    stream?.close(result.ok);

    // Only an attempt checked as a whole is cached: a prefix cut short by an error, a
    // deadline or a cancel may be misplaced (ids in order, texts one segment off).
    if (result.ok && job.state === 'running') persist(job.task, pairs);
    observeCooldown(job, result);
    if (job.state === 'running') handleResult(job, result, pairs);
    // Aborting does not end a fetch at once: keep the slot until it really has.
    await Promise.all(requests);
    active[adapter.kind] -= 1;
    pump();
  }

  function observeCooldown(job: Job, result: Result<unknown>) {
    const cooldown = cooldownState(job.task.cooldownKey);
    if (!result.ok && result.error.kind === 'rate-limit') {
      cooldown.epoch += 1;
      cooldown.recovering = true;
      const pause = Math.min(result.error.retryAfterMs ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
      cooldown.cooldownUntil = Math.max(cooldown.cooldownUntil, now() + pause);
    }
    if (job.probe) {
      cooldown.probeInFlight = false;
      // Only a success proves recovery; any other failure lets the next probe through.
      if (result.ok && job.epoch === cooldown.epoch) cooldown.recovering = false;
    }
  }

  function handleResult(job: Job, result: Result<unknown>, pairs: readonly Pair[]) {
    // Errors apply only to the segments still left; none left is a success.
    if (result.ok || job.segments.length === 0) {
      complete(job, pairs);
      return;
    }
    const { error } = result;
    if (error.retryable && job.retries < MAX_RETRIES) {
      const delay =
        error.retryAfterMs ?? RETRY_BASE_MS * 2 ** job.retries * (1 + random() * RETRY_JITTER);
      if (now() + delay >= job.task.deadline) {
        // Not enough time left for another attempt.
        const timeout = timeoutError();
        settle(job, () => failure(timeout));
        return;
      }
      job.retries += 1;
      job.state = 'waiting';
      waiting += 1;
      job.retryTimer = setTimeout(() => {
        job.retryTimer = undefined;
        waiting -= 1;
        enqueue(job, true);
        pump();
      }, delay);
      return;
    }
    const halves = isSplittableError(error) ? splitInHalf(job.segments) : undefined;
    if (halves) {
      split(job, halves);
      return;
    }
    settle(job, () => failure(error));
  }

  /** Delivers the pairs' translations; a segment without one fails as a bad response. */
  function complete(job: Job, pairs: readonly Pair[]) {
    const texts = new Map(pairs.map(({ segment, text }) => [segment, text]));
    settle(job, (segment) => {
      const text = texts.get(segment);
      return text === undefined ? failure(badResponseError()) : outcomeOf(text);
    });
  }

  /**
   * Caches the non-empty translations, except those that echo source sentences (so
   * the next request tries again). Cached even for segments whose subscribers have
   * all left: the cost is already paid.
   */
  function persist(task: Task, pairs: readonly Pair[]) {
    const entries: CacheEntry[] = [];
    for (const { segment, text } of pairs) {
      if (!isBlank(text) && !isEchoedTranslation(segment.text, text, task.context)) {
        entries.push({ key: segment.key, text });
      }
    }
    if (entries.length === 0 || !task.persist) return;
    try {
      Promise.resolve(task.persist(entries)).catch(() => undefined);
    } catch {
      // Caching is best effort.
    }
  }

  /** Halves stay internal: they only carry the parent's segments and never take new ones. */
  function split(job: Job, halves: [Segment[], Segment[]]) {
    retire(job);
    for (const half of [...halves].reverse()) {
      if (half.every((segment) => segment.subscribers.size === 0)) {
        for (const segment of half) release(segment);
        continue;
      }
      enqueue(createJob(job.task, half), true);
    }
  }

  /**
   * A stream joining a page job that is still queued makes it interactive: front of
   * its queue and eligible for the reserved slot. The joiner gets no increments (the
   * job's sink has no callbacks). A job that already started is left alone.
   */
  function promote(job: Job | undefined, signal: AbortSignal) {
    if (job?.state !== 'queued' || job.task.stream) return;
    job.task = {
      ...job.task,
      stream: { signal, onDelta: undefined, onReset: undefined },
    };
    dequeue(job);
    enqueue(job, true);
  }

  // ------------------------------------------------------------ public

  function submit(request: ScheduleRequest): Promise<ItemOutcome>[] {
    const { signal, adapter } = request;
    const interactive = request.onDelta !== undefined || request.onReset !== undefined;
    if (signal.aborted) {
      return request.segments.map(() => Promise.resolve(failure(abortedError())));
    }
    const task: Task = {
      caller: request.caller,
      cooldownKey: request.cooldownKey ?? request.engine,
      adapter,
      context: request.context,
      persist: request.persist,
      deadline:
        now() +
        Math.min(
          request.deadlineMs ?? Number.POSITIVE_INFINITY,
          SCHEDULER_LIMITS[adapter.kind].deadlineMs,
        ),
      stream: interactive
        ? { signal, onDelta: request.onDelta, onReset: request.onReset }
        : undefined,
    };

    const fresh: Segment[] = [];
    const subscriptions: {
      segment: Segment;
      subscriber: Subscriber;
      outcome: Promise<ItemOutcome>;
    }[] = [];
    for (const input of request.segments) {
      let segment = segments.get(input.key);
      if (!segment) {
        segment = { key: input.key, text: input.text, subscribers: new Set(), job: undefined };
        segments.set(input.key, segment);
        fresh.push(segment);
      }
      let resolve: (outcome: ItemOutcome) => void = () => undefined;
      const outcome = new Promise<ItemOutcome>((r) => {
        resolve = r;
      });
      const subscriber: Subscriber = { done: false, resolve };
      segment.subscribers.add(subscriber);
      if (interactive) promote(segment.job, signal);
      subscriptions.push({ segment, subscriber, outcome });
    }

    // Interactive segments run alone and go to the front, keeping their order.
    const groups = interactive
      ? fresh.map((_, index) => [index]).reverse()
      : chunkByLimits(
          fresh.map((segment) => segment.text),
          adapter.limits,
        );
    for (const group of groups) {
      const members = group.flatMap((index) => {
        const segment = fresh[index];
        return segment ? [segment] : [];
      });
      enqueue(createJob(task, members), interactive);
    }

    const onAbort = () => {
      const error = abortedError();
      for (const { segment, subscriber } of subscriptions) {
        if (subscriber.done) continue;
        deliver(subscriber, failure(error));
        segment.subscribers.delete(subscriber);
        if (segment.subscribers.size === 0) abandonIfOrphaned(segment.job);
      }
      pump();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.all(subscriptions.map((entry) => entry.outcome)).then(() =>
      signal.removeEventListener('abort', onAbort),
    );

    pump();
    return subscriptions.map((entry) => entry.outcome);
  }

  function inspect(): SchedulerSnapshot {
    let queued = 0;
    for (const queue of queues.values()) queued += queue.length;
    return {
      active: { ...active },
      queued,
      waiting,
      segments: segments.size,
      callers: queues.size,
    };
  }

  return { submit, inspect };
}
