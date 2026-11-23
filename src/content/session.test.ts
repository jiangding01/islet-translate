// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import { type AppError, appError } from '@/lib/errors';
import type { Outcome, PortClient } from '@/lib/messaging/port';
import type {
  PageState,
  PageStatus,
  TranslateChunk,
  TranslateDone,
  TranslateRequest,
} from '@/lib/messaging/protocol';
import type { StyleReader } from './dom-rules';
import { type MutationWatchOptions, watchMutations } from './mutations';
import { IDLE_PAGE_STATE } from './runtime-contract';
import { createPageSession, isEngineLevel, type SessionDeps } from './session';

const readStyle: StyleReader = (el) => {
  const own = (el as HTMLElement).style?.display;
  if (own) return { display: own };
  return { display: el.tagName === 'DIV' || el.tagName === 'BODY' ? 'block' : 'inline' };
};

interface Call {
  payload: TranslateRequest;
  onChunk?: (chunk: TranslateChunk) => void;
  finish(outcome: Outcome<TranslateDone>): void;
  /** Answers every item with "译:" + text, then completes. */
  answer(): void;
}

function fakePort() {
  const calls: Call[] = [];
  const port: PortClient<TranslateRequest, TranslateChunk, TranslateDone> & { calls: Call[] } = {
    calls,
    request(payload, onChunk) {
      let finish!: (outcome: Outcome<TranslateDone>) => void;
      const outcome = new Promise<Outcome<TranslateDone>>((resolve) => {
        finish = resolve;
      });
      const call: Call = {
        payload,
        onChunk,
        finish,
        answer() {
          for (const item of payload.items) {
            onChunk?.({
              id: item.id,
              text: `译:${item.text}`,
              disposition: 'translated',
              cached: false,
            });
          }
          finish({ status: 'done', data: { total: payload.items.length, failed: 0 } });
        },
      };
      calls.push(call);
      return { id: String(calls.length), outcome, cancel: () => finish({ status: 'cancelled' }) };
    },
    cancelAll() {
      for (const call of calls) call.finish({ status: 'cancelled' });
    },
    dispose() {},
  };
  return port;
}

/**
 * Every session a test created. Most tests never stop theirs, and a session keeps watching
 * the document: the next test's page would be scanned by all of them, and the too-long
 * notes (written whether or not a viewport reports the paragraph) would pile up.
 */
const startedSessions: { stop(): Promise<unknown> }[] = [];

afterEach(async () => {
  const sessions = startedSessions.splice(0);
  const results = await Promise.allSettled(sessions.map((session) => session.stop()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
});

function setup(
  markup: string,
  getConfig = async () => createDefaultConfig('zh-CN'),
  extra: Partial<SessionDeps> = {},
) {
  const configListeners: ((config: ReturnType<typeof createDefaultConfig>) => void)[] = [];
  document.body.innerHTML = markup;
  const before = document.body.innerHTML;
  const port = fakePort();
  const statuses: PageStatus[] = [];
  const observed: Element[] = [];
  const unobserved: Element[] = [];
  // A manual frame clock: subscribers are pushed only when a test runs the frame.
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const runFrame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback();
  };
  let notify: ((targets: Element[], visible: boolean[]) => void) | undefined;
  /** Each round of page changes the mutation watcher passed on for rescanning. */
  const dirtyRounds: Element[][] = [];
  const session = createPageSession({
    win: window,
    port,
    getConfig,
    watchConfig: (callback) => {
      configListeners.push(callback);
      return () => {
        const at = configListeners.indexOf(callback);
        if (at >= 0) configListeners.splice(at, 1);
      };
    },
    reportStatus: (status) => statuses.push(status),
    detectLanguage: async () => ({ isReliable: true, languages: [] }),
    createReadStyle: () => readStyle,
    createViewport: (onChange) => {
      notify = onChange;
      return {
        observe: (target) => observed.push(target),
        unobserve: (target) => {
          unobserved.push(target);
        },
        disconnect: () => {
          observed.length = 0;
        },
      };
    },
    createMutationWatch: (options) =>
      watchMutations({
        ...options,
        debounceMs: 5,
        onDirty: (elements) => {
          dirtyRounds.push(elements);
          options.onDirty(elements);
        },
      }),
    ...extra,
    scheduleFrame: (callback) => {
      frameId += 1;
      const id = frameId;
      frames.set(id, callback);
      return () => frames.delete(id);
    },
  });
  startedSessions.push(session);
  /** Reports every observed root (or the given ones) as in range. */
  const show = (targets: Element[] = [...observed]) =>
    notify?.(
      targets,
      targets.map(() => true),
    );
  /** Reports the given roots as out of range. */
  const hide = (targets: Element[]) =>
    notify?.(
      targets,
      targets.map(() => false),
    );
  const sentTexts = () => port.calls.flatMap((call) => call.payload.items.map((item) => item.text));
  return {
    session,
    port,
    statuses,
    observed,
    unobserved,
    show,
    hide,
    before,
    sentTexts,
    configListeners,
    runFrame,
    queuedFrames: () => frames.size,
    dirtyRounds,
  };
}

/** happy-dom's own handle on the window; the page's hostname follows its URL. */
const setURL = (url: string) =>
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const translations = () => [...document.querySelectorAll('et-tr')].map((el) => el.textContent);
const engineError = (code: `${string}/${string}`): AppError =>
  appError('provider', code as AppError['code'], 'engine problem');

beforeEach(() => {
  document.head.innerHTML = '';
});

describe('page session: happy path', () => {
  it('reports IDLE_PAGE_STATE before it has started', () => {
    const { session } = setup('<p>Hello</p>');
    // toEqual: state() carries keys whose value is undefined.
    expect(session.state()).toEqual(IDLE_PAGE_STATE);
  });

  it('translates only what the viewport reports, then restores the page exactly', async () => {
    const { session, port, show, before, statuses, observed } = setup(
      '<p>First paragraph text.</p><p>Second paragraph text.</p>',
    );
    await session.start();
    await wait();
    expect(port.calls).toHaveLength(0);
    show(observed.slice(0, 1));
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    expect(port.calls[0]?.payload.items.map((item) => item.text)).toEqual([
      'First paragraph text.',
    ]);
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:First paragraph text.']));
    expect(session.state()).toMatchObject({ phase: 'done', translated: 1, failed: 0 });
    expect(statuses.at(-1)).toBe('done');
    await session.stop();
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('style[data-et]')).toBeNull();
    expect(statuses.at(-1)).toBe('idle');
  });

  it('drops results that arrive after stop', async () => {
    const { session, port, show, before } = setup('<p>Late result paragraph.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    await session.stop();
    call.onChunk?.({
      id: call.payload.items[0]?.id ?? '',
      text: '迟到的译文',
      disposition: 'translated',
      cached: false,
    });
    await wait();
    expect(document.body.innerHTML).toBe(before);
  });

  it('ignores stream delta, reset and phonetic chunks and renders only the final one', async () => {
    const { session, port, show } = setup('<p>Streamed paragraph text.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    const id = call.payload.items[0]?.id ?? '';
    call.onChunk?.({ id, reset: true });
    call.onChunk?.({ id, delta: '半截' });
    call.onChunk?.({ id, phonetic: { uk: 'ˈstriːmd' } });
    await wait();
    expect(translations()).toEqual([]);
    expect(session.state()).toMatchObject({ translated: 0, failed: 0 });
    call.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Streamed paragraph text.']));
  });

  it('renders a repeated text from memory without asking again', async () => {
    const { session, port, show, observed } = setup('<p>Read more here.</p><p>Read more here.</p>');
    await session.start();
    show(observed.slice(0, 1));
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    show(observed.slice(1));
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    expect(port.calls).toHaveLength(1);
  });

  it('never reuses a translation for a different text that shares its digest', async () => {
    // A real FNV-1a 32-bit collision: a page comment must not plant a "translation" on other text.
    const { session, port, show, observed, sentTexts } = setup(
      '<p>Reader comment number 7123 says hello.</p><p>Reader comment number 260100 says hello.</p>',
    );
    await session.start();
    show(observed.slice(0, 1));
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    show(observed.slice(1));
    await vi.waitFor(() =>
      expect(sentTexts()).toContain('Reader comment number 260100 says hello.'),
    );
    expect(translations()).toEqual(['译:Reader comment number 7123 says hello.']);
  });

  it('switches the mode and keeps the state in sync', async () => {
    const { session, port, show } = setup('<p>Mode switch paragraph.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    expect((await session.setMode('translation')).mode).toBe('translation');
    expect(document.querySelector('p')?.hasAttribute('data-et-only')).toBe(true);
  });
});

describe('page session: lifecycle', () => {
  it('removes only its own stylesheet, never one the page planted', async () => {
    const { session } = setup('<p>Stylesheet ownership text.</p>');
    const planted = document.createElement('style');
    planted.setAttribute('data-et', '');
    document.head.append(planted);
    await session.start();
    expect(document.querySelectorAll('style[data-et]')).toHaveLength(2);
    await session.stop();
    expect([...document.querySelectorAll('style[data-et]')]).toEqual([planted]);
  });

  it('cancels its own requests on stop without touching the shared Port', async () => {
    const { session, port, show } = setup('<p>Own requests only text.</p>');
    const cancelAll = vi.spyOn(port, 'cancelAll');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    await session.stop();
    expect(cancelAll).not.toHaveBeenCalled();
  });

  it('restyles translations when the setting changes, keeping the language fixed', async () => {
    const { session, port, show, configListeners } = setup('<p>Live style paragraph.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const next = createDefaultConfig('zh-CN');
    next.page.style = 'highlight';
    for (const listener of configListeners) listener(next);
    expect(document.querySelector('et-tr')?.getAttribute('data-et-s')).toBe('highlight');
    await session.stop();
    expect(configListeners).toHaveLength(0);
  });

  it('keeps the engine it started with when the default engine changes mid-session', async () => {
    const { session, port, show, observed, configListeners } = setup(
      '<p>First pinned paragraph.</p><p>Second pinned paragraph.</p>',
    );
    await session.start();
    show(observed.slice(0, 1));
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    expect(port.calls[0]?.payload.engine).toBe('google');
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const next = createDefaultConfig('zh-CN');
    next.translation.engine = 'deepseek';
    for (const listener of configListeners) listener(next);
    show(observed.slice(1));
    await vi.waitFor(() => expect(port.calls).toHaveLength(2));
    expect(port.calls[1]?.payload.engine).toBe('google');
    expect(session.state().engine).toBe('google');
  });

  it('keeps an engine picked while the config is still loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, port, show } = setup('<p>Picked during load.</p>', async () => {
      await gate;
      return createDefaultConfig('zh-CN');
    });
    const started = session.start();
    await wait();
    await session.start({ engine: 'deepseek' });
    release();
    await started;
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    expect(port.calls[0]?.payload.engine).toBe('deepseek');
    expect(session.state().engine).toBe('deepseek');
  });

  it('starts with the given engine, and re-pins the then-current default after a stop', async () => {
    const config = createDefaultConfig('zh-CN');
    const { session, port, show } = setup('<p>Pinned after stop.</p>', async () => config);
    await session.start({ engine: 'deepseek' });
    expect(session.state().engine).toBe('deepseek');
    await session.stop();
    expect(session.state().engine).toBeUndefined();
    config.translation.engine = 'gemini';
    await session.start();
    expect(session.state().engine).toBe('gemini');
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    expect(port.calls[0]?.payload.engine).toBe('gemini');
  });

  it('pauses when the pinned engine no longer exists (deleted custom engine)', async () => {
    const { session, port, show } = setup('<p>Deleted engine paragraph.</p>');
    await session.start({ engine: 'custom-gone' as never });
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    expect(port.calls[0]?.payload.engine).toBe('custom-gone');
    port.calls[0]?.finish({
      status: 'error',
      error: appError('config', 'config/provider-missing', 'Custom provider not found'),
    });
    await vi.waitFor(() =>
      expect(session.state().engineError?.code).toBe('config/provider-missing'),
    );
  });

  it('leaves the page untouched when the config cannot be read', async () => {
    const { session, before, statuses } = setup('<p>Unreadable config text.</p>', async () => {
      throw new Error('storage gone');
    });
    await expect(session.start()).rejects.toThrow('storage gone');
    expect(session.state().phase).toBe('idle');
    expect(statuses.at(-1)).toBe('idle');
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('style[data-et]')).toBeNull();
  });

  it('a stale start that fails late leaves the newer session running', async () => {
    let failFirst!: (error: Error) => void;
    let reads = 0;
    const { session, statuses } = setup('<p>Stale start text.</p>', () => {
      reads += 1;
      if (reads > 1) return Promise.resolve(createDefaultConfig('zh-CN'));
      return new Promise((_resolve, reject) => {
        failFirst = reject;
      });
    });
    const first = session.start();
    await vi.waitFor(() => expect(reads).toBe(1));
    await session.stop();
    expect((await session.start()).phase).toBe('running');
    failFirst(new Error('storage gone'));
    await expect(first).rejects.toThrow('storage gone');
    await wait();
    expect(session.state().phase).not.toBe('idle');
    expect(statuses.at(-1)).not.toBe('idle');
    expect(document.querySelector('style[data-et]')).not.toBeNull();
  });
});

describe('page session: errors', () => {
  it('retries a dropped connection instead of failing paragraphs', async () => {
    const { session, port, show } = setup('<p>Reconnect paragraph text.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.finish({
      status: 'error',
      error: appError('network', 'network/port-disconnected', 'gone', { retryable: true }),
    });
    await wait();
    expect(session.state().failed).toBe(0);
    expect(document.querySelector('et-tr')).toBeNull();
    await vi.waitFor(() => expect(port.calls).toHaveLength(2), { timeout: 1500 });
    expect(port.calls[1]?.payload.items[0]?.text).toBe('Reconnect paragraph text.');
    port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Reconnect paragraph text.']));
  });

  it('pauses on an engine problem and resumes with a one-off engine', async () => {
    const { session, port, show, statuses } = setup(
      '<p>Engine paragraph one.</p><p>Engine paragraph two.</p>',
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const [first] = port.calls[0]?.payload.items ?? [];
    port.calls[0]?.onChunk?.({ id: first?.id ?? '', error: engineError('provider/unauthorized') });
    port.calls[0]?.finish({
      status: 'error',
      error: engineError('provider/unauthorized'),
    });
    await wait();
    const paused = session.state();
    expect(paused.engineError?.code).toBe('provider/unauthorized');
    expect(paused.failed).toBe(0);
    expect(statuses.at(-1)).toBe('error');
    expect(document.querySelector('et-tr')).toBeNull();
    await wait(100);
    expect(port.calls).toHaveLength(1);

    await session.start({ engine: 'google' });
    await vi.waitFor(() => expect(port.calls).toHaveLength(2));
    expect(port.calls[1]?.payload.engine).toBe('google');
    expect(port.calls[1]?.payload.items).toHaveLength(2);
    expect(session.state().engineError).toBeUndefined();
  });

  /** Pauses on an engine error, retries with the same engine, then switches while in flight. */
  async function switchWhileOldEngineInFlight(markup: string) {
    const t = setup(markup);
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    t.port.calls[0]?.finish({ status: 'error', error: engineError('provider/unauthorized') });
    await vi.waitFor(() => expect(t.session.state().engineError).toBeDefined());
    t.session.retryFailed();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.port.calls[1]?.payload.engine).toBe('google');
    await t.session.start({ engine: 'deepseek' });
    await wait();
    // Every paragraph is still out with the old engine: nothing to send yet.
    expect(t.port.calls).toHaveLength(2);
    return { ...t, old: t.port.calls[1] as Call };
  }

  it("resends with the new engine when the old engine's request fails after a switch", async () => {
    const { session, port, old } = await switchWhileOldEngineInFlight(
      '<p>Late failure one.</p><p>Late failure two.</p>',
    );
    old.finish({ status: 'error', error: engineError('provider/unauthorized') });
    await vi.waitFor(() => expect(port.calls).toHaveLength(3));
    expect(port.calls[2]?.payload.engine).toBe('deepseek');
    expect(port.calls[2]?.payload.items.map((item) => item.text)).toEqual([
      'Late failure one.',
      'Late failure two.',
    ]);
    expect(session.state().engineError).toBeUndefined();
  });

  it("keeps the old engine's translations and resends only its engine-level rejects", async () => {
    const { session, port, old } = await switchWhileOldEngineInFlight(
      '<p>Late chunk one.</p><p>Late chunk two.</p>',
    );
    const [first, second] = old.payload.items;
    old.onChunk?.({
      id: first?.id ?? '',
      text: '旧引擎译文',
      disposition: 'translated',
      cached: false,
    });
    old.onChunk?.({ id: second?.id ?? '', error: engineError('provider/quota-exceeded') });
    old.finish({ status: 'done', data: { total: 2, failed: 1 } });
    await vi.waitFor(() => expect(port.calls).toHaveLength(3));
    expect(port.calls[2]?.payload.engine).toBe('deepseek');
    expect(port.calls[2]?.payload.items.map((item) => item.text)).toEqual(['Late chunk two.']);
    expect(session.state().engineError).toBeUndefined();
    await vi.waitFor(() => expect(translations()).toEqual(['旧引擎译文']));
  });

  it('still pauses on an engine error from the current engine after a switch', async () => {
    const { session, port, old } = await switchWhileOldEngineInFlight(
      '<p>Current engine one.</p><p>Current engine two.</p>',
    );
    old.finish({ status: 'error', error: engineError('provider/unauthorized') });
    await vi.waitFor(() => expect(port.calls).toHaveLength(3));
    port.calls[2]?.finish({ status: 'error', error: engineError('config/missing-key') });
    await vi.waitFor(() => expect(session.state().engineError?.code).toBe('config/missing-key'));
    await wait(100);
    expect(port.calls).toHaveLength(3);
  });

  it('marks a single paragraph failed and retries it on request', async () => {
    const { session, port, show } = setup('<p>Fails once paragraph.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    call.onChunk?.({
      id: call.payload.items[0]?.id ?? '',
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    call.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() => expect(session.state().failed).toBe(1));
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="error"]')).not.toBeNull(),
    );
    session.retryFailed();
    await vi.waitFor(() => expect(port.calls).toHaveLength(2));
    port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Fails once paragraph.']));
    expect(session.state().failed).toBe(0);
  });

  it('shows the userMessage from the background on a failed paragraph, else the generic text', async () => {
    const { session, port, show } = setup('<p>First failing paragraph.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    call.onChunk?.({
      id: call.payload.items[0]?.id ?? '',
      error: { ...appError('provider', 'provider/bad-request', 'bad'), userMessage: '后台文案<b>' },
    });
    call.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="error"]')?.getAttribute('title')).toBe(
        '后台文案<b>',
      ),
    );
    expect(document.querySelector('et-tr b')).toBeNull();
    session.retryFailed();
    await vi.waitFor(() => expect(port.calls).toHaveLength(2));
    const again = port.calls[1] as Call;
    again.onChunk?.({
      id: again.payload.items[0]?.id ?? '',
      error: appError('provider', 'provider/bad-request', 'bad'),
    });
    again.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="error"]')?.getAttribute('title')).toBe(
        '操作失败，请重试。',
      ),
    );
  });

  it('splits a batch the background found too large', async () => {
    const { session, port, show } = setup('<p>Split paragraph one.</p><p>Split paragraph two.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.finish({
      status: 'error',
      error: appError('validation', 'validation/payload-too-large', 'too big'),
    });
    await vi.waitFor(() => expect(port.calls).toHaveLength(3));
    expect(port.calls.slice(1).map((call) => call.payload.items.length)).toEqual([1, 1]);
  });

  it('halts quietly when the extension context is gone, keeping the translations', async () => {
    const { session, port, show, statuses } = setup(
      '<p>Halt paragraph one.</p><div><p>Halt paragraph two.</p></div>',
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    const [first] = call.payload.items;
    call.onChunk?.({
      id: first?.id ?? '',
      text: '第一段',
      disposition: 'translated',
      cached: false,
    });
    await vi.waitFor(() => expect(translations()).toEqual(['第一段']));
    const reported = statuses.length;
    call.finish({
      status: 'error',
      error: appError('internal', 'internal/context-invalidated', 'gone'),
    });
    await wait();
    document.querySelector('div')?.append(document.createElement('p'));
    await wait();
    expect(translations()).toEqual(['第一段']);
    expect(port.calls).toHaveLength(1);
    expect(statuses).toHaveLength(reported);
    expect((await session.start()).phase).not.toBe('idle');
    expect(port.calls).toHaveLength(1);
  });

  it('halts at its next notification once the extension is unreachable, keeping the translations', async () => {
    let alive = true;
    const { session, port, show, runFrame } = setup(
      '<p>Gone paragraph one.</p><div><p>Gone paragraph two.</p></div>',
      undefined,
      {
        alive: () => alive,
        // Its unsubscribe needs the extension, like the real one's `storage.onChanged`.
        watchConfig: () => () => {
          throw new Error('Extension context invalidated.');
        },
      },
    );
    const seen: (true | undefined)[] = [];
    session.subscribe((state) => seen.push(state.halted));
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const call = port.calls[0] as Call;
    const [first] = call.payload.items;
    call.onChunk?.({
      id: first?.id ?? '',
      text: '第一段',
      disposition: 'translated',
      cached: false,
    });
    await vi.waitFor(() => expect(translations()).toEqual(['第一段']));
    runFrame();
    expect(session.state()).not.toHaveProperty('halted');

    // The isle's own actions end up here; no request error has told the session anything.
    alive = false;
    session.retryFailed();
    expect(session.state().halted).toBe(true);
    seen.length = 0;
    runFrame();
    expect(seen).toEqual([true]);
    document.querySelector('div')?.append(document.createElement('p'));
    await wait();
    expect(translations()).toEqual(['第一段']);
    expect(port.calls).toHaveLength(1);
  });

  it('classifies engine-level errors', () => {
    expect(isEngineLevel(engineError('config/missing-key'))).toBe(true);
    expect(isEngineLevel(engineError('provider/quota-exceeded'))).toBe(true);
    expect(isEngineLevel(engineError('provider/local-origin-rejected'))).toBe(true);
    expect(isEngineLevel(engineError('provider/rate-limited'))).toBe(false);
    expect(isEngineLevel(appError('network', 'network/timeout', 't'))).toBe(false);
  });
});

describe('page session: paragraphs waiting to retry', () => {
  const texts = Array.from({ length: 51 }, (_, i) => `Waiting paragraph ${i} text.`);
  const many = texts.map((text) => `<p>${text}</p>`).join('');
  const disconnected = () =>
    appError('network', 'network/port-disconnected', 'gone', { retryable: true });
  const textsOf = (calls: Call[]) => calls.flatMap((call) => call.payload.items.map((i) => i.text));

  /** 51 paragraphs make two requests: A (50) drops its connection and waits to retry. */
  async function twoBatches() {
    const t = setup(many);
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    const [a, b] = t.port.calls as [Call, Call];
    expect(a.payload.items).toHaveLength(50);
    a.finish({ status: 'error', error: disconnected() });
    await wait(10);
    return { ...t, a, b };
  }

  /** B answers each paragraph with an engine-level error: the session pauses. */
  function pauseByChunk(b: Call) {
    for (const item of b.payload.items) {
      b.onChunk?.({ id: item.id, error: engineError('provider/unauthorized') });
    }
    b.finish({ status: 'done', data: { total: b.payload.items.length, failed: 1 } });
  }

  /** B fails as a whole request with an engine-level error: the session pauses. */
  function pauseByRequest(b: Call) {
    b.finish({ status: 'error', error: engineError('provider/unauthorized') });
  }

  /** Pauses the session, then lets A's retry timer (500ms) fire while paused. */
  async function pauseThroughTimer(
    t: Awaited<ReturnType<typeof twoBatches>>,
    pause: typeof pauseByChunk,
  ) {
    pause(t.b);
    await vi.waitFor(() => expect(t.session.state().engineError).toBeDefined());
    await wait(600);
    expect(t.port.calls).toHaveLength(2);
  }

  it('resends the waiting paragraphs after a one-off engine switch (per-paragraph engine error)', async () => {
    const t = await twoBatches();
    await pauseThroughTimer(t, pauseByChunk);
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(textsOf(t.port.calls.slice(2))).toHaveLength(51));
    expect([...textsOf(t.port.calls.slice(2))].sort()).toEqual([...texts].sort());
    expect(t.port.calls.slice(2).every((call) => call.payload.engine === 'google')).toBe(true);
  });

  it('resends the waiting paragraphs after a one-off engine switch (request-level engine error)', async () => {
    const t = await twoBatches();
    await pauseThroughTimer(t, pauseByRequest);
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(textsOf(t.port.calls.slice(2))).toHaveLength(51));
    expect([...textsOf(t.port.calls.slice(2))].sort()).toEqual([...texts].sort());
  });

  it('resends the waiting paragraphs on retryFailed', async () => {
    const t = await twoBatches();
    await pauseThroughTimer(t, pauseByChunk);
    t.session.retryFailed();
    await vi.waitFor(() => expect(textsOf(t.port.calls.slice(2))).toHaveLength(51));
    expect([...textsOf(t.port.calls.slice(2))].sort()).toEqual([...texts].sort());
    expect(t.session.state().engineError).toBeUndefined();
  });

  it('puts back only the waiting paragraphs still in range; the rest queue when seen again', async () => {
    const t = await twoBatches();
    // The first ten of A's paragraphs leave the 1000px range while they wait.
    const away = t.observed.slice(0, 10);
    const awayTexts = texts.slice(0, 10);
    t.hide(away);
    await pauseThroughTimer(t, pauseByChunk);
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(textsOf(t.port.calls.slice(2))).toHaveLength(41));
    await wait(100);
    const resent = textsOf(t.port.calls.slice(2));
    expect(resent).toHaveLength(41);
    expect(resent.filter((text) => awayTexts.includes(text))).toEqual([]);
    const before = t.port.calls.length;
    t.show(away);
    await vi.waitFor(() =>
      expect([...textsOf(t.port.calls.slice(before))].sort()).toEqual([...awayTexts].sort()),
    );
  });

  it('starts the backoff over for paragraphs put back after a pause', async () => {
    const t = await twoBatches();
    await pauseThroughTimer(t, pauseByChunk);
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(textsOf(t.port.calls.slice(2))).toHaveLength(51));
    const resent = t.port.calls.slice(2);
    // Attempt 0 again: the same paragraphs wait 500ms (not 1s) and are not marked failed.
    for (const call of resent) call.finish({ status: 'error', error: disconnected() });
    await wait(100);
    expect(t.port.calls).toHaveLength(2 + resent.length);
    await vi.waitFor(
      () => expect(textsOf(t.port.calls.slice(2 + resent.length))).toHaveLength(51),
      {
        timeout: 750,
      },
    );
    expect(t.session.state().failed).toBe(0);
  });

  it('never resends a paragraph forgotten while it waited, nor gives it a new id', async () => {
    const { session, port, show, unobserved } = setup(
      '<div><p>Kept waiting text.</p><p id="gone">Removed waiting text.</p></div>',
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const original = port.calls[0] as Call;
    original.finish({ status: 'error', error: disconnected() });
    const gone = document.getElementById('gone') as HTMLElement;
    gone.remove();
    await vi.waitFor(() => expect(unobserved).toContain(gone));
    await vi.waitFor(() => expect(port.calls).toHaveLength(2), { timeout: 1500 });
    await wait(100);
    expect(port.calls).toHaveLength(2);
    const kept = original.payload.items.find((item) => item.text === 'Kept waiting text.');
    expect(port.calls[1]?.payload.items).toEqual([kept]);
  });

  it('does not send a waiting paragraph twice when the viewport reports it again', async () => {
    const { session, port, show, sentTexts } = setup('<p>Seen twice waiting text.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.finish({ status: 'error', error: disconnected() });
    await wait(10);
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(2), { timeout: 1500 });
    // Past the 500ms retry timer: one resend in all, whichever path sent it.
    await wait(600);
    expect(sentTexts()).toEqual(['Seen twice waiting text.', 'Seen twice waiting text.']);
  });

  it('sends nothing after stop when the retry timer fires', async () => {
    const { session, port, show } = setup('<p>Stopped waiting text.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.finish({ status: 'error', error: disconnected() });
    await wait(10);
    await session.stop();
    await wait(600);
    expect(port.calls).toHaveLength(1);
  });

  it('reports running, not done, while paragraphs wait to retry', async () => {
    const { session, port, show, statuses } = setup('<p>Still running waiting text.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.finish({ status: 'error', error: disconnected() });
    await wait(10);
    expect(session.state().phase).toBe('running');
    expect(statuses.at(-1)).toBe('running');
    await vi.waitFor(() => expect(port.calls).toHaveLength(2), { timeout: 1500 });
    port.calls[1]?.answer();
    await vi.waitFor(() => expect(session.state().phase).toBe('done'));
    expect(statuses.at(-1)).toBe('done');
  });
});

describe('page session: loading dots', () => {
  /** Short delay and scan interval; `near` is what counts as inside the real viewport. */
  function loadingSetup(markup: string, loadingDelayMs = 80) {
    const near = new Set<Element>();
    const t = setup(markup, undefined, {
      loadingDelayMs,
      loadingScanMs: 20,
      inViewport: (el) => near.has(el),
    });
    return { ...t, near };
  }
  const dots = () => document.querySelectorAll('et-tr[data-et-state="loading"]').length;
  const para = (id: string) => document.getElementById(id) as HTMLElement;
  const idOf = (call: Call, index: number) => call.payload.items[index]?.id ?? '';
  const answerItem = (call: Call, index: number, text: string) =>
    call.onChunk?.({ id: idOf(call, index), text, disposition: 'translated', cached: false });
  /** Records every loading dot the page gets added or loses, for "never appeared" checks. */
  function watchDots() {
    const added: Node[] = [];
    const removed: Node[] = [];
    const isDot = (node: Node) => (node as Element).getAttribute?.('data-et-state') === 'loading';
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isDot(node)) added.push(node);
        for (const node of record.removedNodes) if (isDot(node)) removed.push(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { added, removed, stop: () => observer.disconnect() };
  }

  it('shows a dot for a waiting paragraph in the viewport, then swaps it for the translation; one only in the prefetch margin gets none', async () => {
    const t = loadingSetup('<p id="a">Inside the viewport.</p><p id="b">Only in the margin.</p>');
    await t.session.start();
    t.near.add(para('a'));
    t.show();
    const seen = watchDots();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await vi.waitFor(() => expect(dots()).toBe(1));
    expect(para('a').querySelector('et-tr[data-et-state="loading"]')).not.toBeNull();
    await wait(150);
    seen.stop();
    // Never added, not merely absent at the end.
    expect(seen.added.some((node) => para('b').contains(node))).toBe(false);
    expect(para('b').querySelector('et-tr')).toBeNull();
    t.port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    expect(dots()).toBe(0);
    expect(para('a').querySelectorAll('et-tr')).toHaveLength(1);
  });

  it('never shows a dot when the reply comes before the delay', async () => {
    const t = loadingSetup('<p id="a">Fast reply paragraph.</p>');
    await t.session.start();
    t.near.add(para('a'));
    const seen = watchDots();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    t.port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    await wait(200);
    seen.stop();
    expect(seen.added).toEqual([]);
    expect(dots()).toBe(0);
  });

  it('takes the dot away when a paragraph is given up on, fails, or is forgotten', async () => {
    const t = loadingSetup(
      '<p id="a">Skipped paragraph one.</p><p id="b">Failing paragraph two.</p><p id="c">Edited paragraph three.</p>',
    );
    await t.session.start();
    for (const id of ['a', 'b', 'c']) t.near.add(para(id));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await vi.waitFor(() => expect(dots()).toBe(3));
    const call = t.port.calls[0] as Call;
    const seen = watchDots();
    // Not translated (the text is already in the target language): the dot just goes.
    call.onChunk?.({ id: idOf(call, 0), text: 'x', disposition: 'same-language', cached: false });
    await vi.waitFor(() => expect(dots()).toBe(2));
    expect(para('a').querySelector('et-tr')).toBeNull();
    // Failed: the retry note takes its place.
    call.onChunk?.({
      id: idOf(call, 1),
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    await vi.waitFor(() =>
      expect(para('b').querySelector('et-tr[data-et-state="error"]')).not.toBeNull(),
    );
    expect(para('b').querySelector('et-tr[data-et-state="loading"]')).toBeNull();
    // Forgotten: the page changed the text, the old unit and its dot go.
    const dotOfC = para('c').querySelector('et-tr[data-et-state="loading"]');
    (para('c').firstChild as Text).nodeValue = 'Edited paragraph three, again.';
    await vi.waitFor(() => expect(seen.removed).toContain(dotOfC));
    seen.stop();
  });

  it('takes the dot away when the paragraph leaves the viewport or the session stops', async () => {
    const t = loadingSetup('<p id="a">Scrolled away paragraph.</p>');
    await t.session.start();
    t.near.add(para('a'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await vi.waitFor(() => expect(dots()).toBe(1));
    t.near.delete(para('a'));
    await vi.waitFor(() => expect(dots()).toBe(0));
    t.near.add(para('a'));
    await vi.waitFor(() => expect(dots()).toBe(1));
    const seen = watchDots();
    await t.session.stop();
    await wait(120);
    seen.stop();
    expect(seen.added).toEqual([]);
    expect(dots()).toBe(0);
    expect(document.body.innerHTML).toBe(t.before);
  });

  it('takes the dot away when a waiting paragraph is moved out of the queue by the viewport', async () => {
    const t = loadingSetup('<p id="a">Queued then scrolled past.</p>', 40);
    await t.session.start();
    t.near.add(para('a'));
    // A scroll in progress keeps paragraphs queued instead of sending them.
    window.dispatchEvent(new Event('scroll'));
    t.show();
    await vi.waitFor(() => expect(dots()).toBe(1));
    expect(t.port.calls).toHaveLength(0);
    t.hide([para('a')]);
    await vi.waitFor(() => expect(dots()).toBe(0));
  });

  it('hides every dot on an engine error, shows none while paused, and brings them back on resume', async () => {
    const t = loadingSetup(
      '<p id="a">Paused paragraph one.</p><p id="b">Paused paragraph two.</p>',
    );
    await t.session.start();
    t.near.add(para('a'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await vi.waitFor(() => expect(dots()).toBe(1));
    const call = t.port.calls[0] as Call;
    call.onChunk?.({ id: idOf(call, 0), error: engineError('provider/unauthorized') });
    await vi.waitFor(() => expect(t.session.state().engineError).toBeDefined());
    expect(dots()).toBe(0);
    const seen = watchDots();
    await wait(200);
    seen.stop();
    expect(seen.added).toEqual([]);
    // Resume: the paragraphs have waited long already, so the dot is back at once.
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(dots()).toBe(1));
    expect(t.port.calls).toHaveLength(2);
    t.port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Paused paragraph one.']));
    expect(dots()).toBe(0);
  });

  it('swapping a dot for the translation is not a page change; a page removal still is', async () => {
    const t = loadingSetup('<p id="a">Swapped paragraph text.</p>', 40);
    await t.session.start();
    t.near.add(para('a'));
    t.show();
    await vi.waitFor(() => expect(dots()).toBe(1));
    answerItem(t.port.calls[0] as Call, 0, '译:换');
    await vi.waitFor(() => expect(translations()).toEqual(['译:换']));
    await wait(100);
    expect(dots()).toBe(0);
    expect(t.dirtyRounds).toEqual([]);
    para('a').append(document.createElement('span'));
    para('a').lastElementChild?.remove();
    await vi.waitFor(() => expect(t.dirtyRounds.length).toBeGreaterThan(0));
  });

  /** Two paragraphs in one request; the request then ends because the extension went away. */
  async function haltSetup() {
    const t = loadingSetup(
      '<p id="a">Halted paragraph one.</p><p id="b">Halted paragraph two.</p>',
    );
    await t.session.start();
    t.near.add(para('a'));
    t.near.add(para('b'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await vi.waitFor(() => expect(dots()).toBe(2));
    const call = t.port.calls[0] as Call;
    const invalidated = () =>
      call.finish({
        status: 'error',
        error: appError('internal', 'internal/context-invalidated', 'gone'),
      });
    return { t, call, invalidated };
  }

  it('takes every dot away when the session halts, and none comes back', async () => {
    const { t, invalidated } = await haltSetup();
    invalidated();
    await vi.waitFor(() => expect(t.session.state().halted).toBe(true));
    expect(dots()).toBe(0);
    const seen = watchDots();
    await wait(200);
    seen.stop();
    expect(seen.added).toEqual([]);
    expect(dots()).toBe(0);
  });

  it('halting after a reply but before its render leaves no dot behind', async () => {
    const { t, call, invalidated } = await haltSetup();
    answerItem(call, 0, '译:未渲染');
    invalidated();
    await vi.waitFor(() => expect(t.session.state().halted).toBe(true));
    await wait(100);
    expect(dots()).toBe(0);
    expect(translations()).toEqual([]);
  });

  it('retry after a halt leaves the failure note alone, shows no dot and sends nothing', async () => {
    const t = loadingSetup(
      '<p id="a">Failed then halted.</p><p id="b">Never answered one.</p>',
      60_000,
    );
    await t.session.start();
    t.near.add(para('a'));
    t.near.add(para('b'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    const call = t.port.calls[0] as Call;
    call.onChunk?.({
      id: idOf(call, 0),
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    await vi.waitFor(() =>
      expect(para('a').querySelector('et-tr[data-et-state="error"] button')).not.toBeNull(),
    );
    call.finish({
      status: 'error',
      error: appError('internal', 'internal/context-invalidated', 'gone'),
    });
    await vi.waitFor(() => expect(t.session.state().halted).toBe(true));
    const seen = watchDots();
    (para('a').querySelector('et-tr[data-et-state="error"] button') as HTMLElement).click();
    await wait(150);
    seen.stop();
    expect(seen.added).toEqual([]);
    expect(dots()).toBe(0);
    expect(para('a').querySelector('et-tr[data-et-state="error"]')).not.toBeNull();
    expect(t.port.calls).toHaveLength(1);
  });

  it('shows no dot for a retry pressed while the engine is paused, and one once it resumes', async () => {
    const t = loadingSetup(
      '<p id="a">Failed paragraph one.</p><p id="b">Paused paragraph two.</p>',
      100,
    );
    await t.session.start();
    t.near.add(para('a'));
    t.near.add(para('b'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    const call = t.port.calls[0] as Call;
    call.onChunk?.({
      id: idOf(call, 0),
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    await vi.waitFor(() =>
      expect(para('a').querySelector('et-tr[data-et-state="error"] button')).not.toBeNull(),
    );
    call.onChunk?.({ id: idOf(call, 1), error: engineError('provider/unauthorized') });
    await vi.waitFor(() => expect(t.session.state().engineError).toBeDefined());
    const seen = watchDots();
    (para('a').querySelector('et-tr[data-et-state="error"] button') as HTMLElement).click();
    await wait(150);
    expect(seen.added).toEqual([]);
    expect(dots()).toBe(0);
    // Resume: the paragraph has waited longer than the delay, so its dot is back at once.
    await t.session.start({ engine: 'google' });
    await vi.waitFor(() => expect(dots()).toBe(2));
    seen.stop();
  });

  it('stops scanning once a finished request left nothing unfinished', async () => {
    const t = loadingSetup(
      '<p id="a">Answered paragraph.</p><p id="b">Left unanswered.</p>',
      60_000,
    );
    await t.session.start();
    t.near.add(para('a'));
    t.near.add(para('b'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    const call = t.port.calls[0] as Call;
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const scans = () => spy.mock.calls.filter((args) => args[1] === 20).length;
    try {
      answerItem(call, 0, '译:已答');
      call.finish({ status: 'done', data: { total: 2, failed: 0 } });
      await vi.waitFor(() => expect(translations()).toEqual(['译:已答']));
      await wait(80);
      const settled = scans();
      await wait(150);
      expect(scans()).toBe(settled);
    } finally {
      spy.mockRestore();
    }
  });

  it('shows the dot at once on retry, replaces it with the translation, and keeps the paragraph through a page change', async () => {
    // A delay far beyond the test: the dot can only come from the retry itself.
    const t = loadingSetup('<p id="a">Retried paragraph text.</p>', 60_000);
    await t.session.start();
    t.near.add(para('a'));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    const first = t.port.calls[0] as Call;
    first.onChunk?.({
      id: idOf(first, 0),
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    first.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="error"]')).not.toBeNull(),
    );
    t.session.retryFailed();
    await vi.waitFor(() => expect(dots()).toBe(1));
    expect(document.querySelector('et-tr[data-et-state="error"]')).toBeNull();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    // A page change meanwhile: the paragraph is neither lost nor given up on.
    document.body.append(document.createElement('div'));
    await vi.waitFor(() => expect(t.dirtyRounds.length).toBeGreaterThan(0));
    await wait(100);
    expect(dots()).toBe(1);
    expect(t.port.calls).toHaveLength(2);
    answerItem(t.port.calls[1] as Call, 0, '译:重试');
    await vi.waitFor(() => expect(translations()).toEqual(['译:重试']));
    expect(dots()).toBe(0);
    expect(t.session.state()).toMatchObject({ translated: 1, failed: 0 });
  });
});

describe('page session: dynamic content', () => {
  it('translates paragraphs the page adds later', async () => {
    const { session, port, show, sentTexts } = setup(
      '<div id="feed"><p>Existing post text.</p></div>',
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    const added = document.createElement('p');
    added.textContent = 'A newly loaded post.';
    document.getElementById('feed')?.append(added);
    await wait();
    show([added]);
    await vi.waitFor(() => expect(sentTexts()).toContain('A newly loaded post.'));
  });

  it('replaces a translation when the page edits the paragraph', async () => {
    const { session, port, show, sentTexts } = setup('<p id="live">Score is one to nil.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const live = document.getElementById('live') as HTMLElement;
    (live.firstChild as Text).nodeValue = 'Score is two to nil.';
    await vi.waitFor(() => expect(translations()).toHaveLength(0));
    show([live]);
    await vi.waitFor(() => expect(sentTexts()).toContain('Score is two to nil.'));
    port.calls.at(-1)?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Score is two to nil.']));
  });

  it('keeps translations while a dialog marks the page aria-hidden', async () => {
    const { session, port, show } = setup('<main><p>Behind the dialog text.</p></main>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const shown = document.querySelector('et-tr');
    const main = document.querySelector('main') as HTMLElement;
    main.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    await wait(100);
    // The same node: never dropped and re-inserted (a flash, and a strike toward the loop guard).
    expect(document.querySelector('et-tr')).toBe(shown);
    dialog.remove();
    main.removeAttribute('aria-hidden');
    await wait(100);
    expect(translations()).toEqual(['译:Behind the dialog text.']);
    expect(port.calls).toHaveLength(1);
  });

  describe('protected areas', () => {
    const FEED = '<div id="feed"><p>Existing post text.</p></div>';

    async function started(markup: string) {
      const ctx = setup(`${FEED}${markup}`);
      await ctx.session.start();
      ctx.show();
      await vi.waitFor(() => expect(ctx.port.calls).toHaveLength(1));
      ctx.port.calls[0]?.answer();
      await vi.waitFor(() => expect(translations().length).toBeGreaterThan(0));
      await wait();
      return ctx;
    }

    /** Adds a control paragraph outside the protected area, in the same round as the change. */
    function addControl(text: string) {
      const control = document.createElement('p');
      control.textContent = text;
      document.getElementById('feed')?.append(control);
    }

    /** The control got translated (so the rescan ran) while the draft was never sent. */
    async function expectDraftBlocked(
      ctx: Awaited<ReturnType<typeof started>>,
      control: string,
      draft: string,
      draftEl: Element,
    ) {
      await wait();
      ctx.show();
      await vi.waitFor(() => expect(ctx.sentTexts()).toContain(control));
      await wait();
      expect(ctx.sentTexts().filter((text) => text.includes(draft))).toEqual([]);
      expect(ctx.observed.filter((el) => draftEl.contains(el))).toEqual([]);
    }

    it('(a) ignores a change to the protected element itself', async () => {
      const ctx = await started('<div id="ed" contenteditable="true">Original draft words.</div>');
      const editor = document.getElementById('ed') as HTMLElement;
      (editor.firstChild as Text).data = 'Alpha draft typed words.';
      addControl('Control paragraph alpha.');
      await expectDraftBlocked(ctx, 'Control paragraph alpha.', 'Alpha draft', editor);
      expect(ctx.dirtyRounds.flat()).toContain(editor);
    });

    it('(b) ignores a paragraph added inside an editor', async () => {
      const ctx = await started('<div id="ed" contenteditable="true"><p>Original line.</p></div>');
      const editor = document.getElementById('ed') as HTMLElement;
      const typed = document.createElement('p');
      typed.textContent = 'Bravo typed paragraph.';
      editor.append(typed);
      addControl('Control paragraph bravo.');
      await expectDraftBlocked(ctx, 'Control paragraph bravo.', 'Bravo typed', editor);
      expect(ctx.dirtyRounds.flat()).toContain(editor);
    });

    it('(c) ignores typing in editable spans inside a paragraph', async () => {
      // The inline span is climbed to its paragraph, which drops it from the unit; the
      // block-styled one stays its own root, so only the ancestor check keeps it out.
      const ctx = await started(
        '<p id="line">Lead text here <span id="inl" contenteditable="true">old</span> and <span id="blk" contenteditable="true" style="display:block">old</span></p>',
      );
      const inline = document.getElementById('inl') as HTMLElement;
      const block = document.getElementById('blk') as HTMLElement;
      (inline.firstChild as Text).data = 'Charlie inline draft';
      (block.firstChild as Text).data = 'Charlie block draft';
      addControl('Control paragraph charlie.');
      await expectDraftBlocked(ctx, 'Control paragraph charlie.', 'Charlie', inline);
      expect(ctx.observed.filter((el) => block.contains(el))).toEqual([]);
      expect(ctx.dirtyRounds.flat()).toEqual(expect.arrayContaining([inline, block]));
    });

    it('(d) does not send a draft when the area became editable after its unit was sent', async () => {
      const ctx = setup(`${FEED}<div id="box"><p id="mine">Original sentence text.</p></div>`);
      await ctx.session.start();
      ctx.show();
      await vi.waitFor(() => expect(ctx.port.calls).toHaveLength(1));
      const mine = document.getElementById('mine') as HTMLElement;
      const observedBefore = ctx.observed.filter((el) => el === mine).length;
      document.getElementById('box')?.setAttribute('contenteditable', 'true');
      (mine.firstChild as Text).data = 'Delta typed draft.';
      addControl('Control paragraph delta.');
      await wait();
      ctx.show();
      await vi.waitFor(() => expect(ctx.sentTexts()).toContain('Control paragraph delta.'));
      // The stale reply comes back and triggers its own rescan.
      ctx.port.calls[0]?.answer();
      await wait(100);
      ctx.show();
      expect(ctx.sentTexts().filter((text) => text.includes('Delta typed'))).toEqual([]);
      expect(ctx.observed.filter((el) => el === mine)).toHaveLength(observedBefore);
      expect(ctx.dirtyRounds.flat()).toContain(mine);
    });

    it('(e) ignores a paragraph added inside translate="no"', async () => {
      const ctx = await started('<div id="nt" translate="no"><p>Kept as is.</p></div>');
      const holder = document.getElementById('nt') as HTMLElement;
      const added = document.createElement('p');
      added.textContent = 'Echo untranslated paragraph.';
      holder.append(added);
      addControl('Control paragraph echo.');
      await expectDraftBlocked(ctx, 'Control paragraph echo.', 'Echo untranslated', holder);
      expect(ctx.dirtyRounds.flat()).toContain(holder);
    });

    it('(f) still translates a paragraph added inside an aria-hidden area', async () => {
      const { session, show, sentTexts } = setup('<div id="hid" aria-hidden="true"></div>');
      await session.start();
      const added = document.createElement('p');
      added.textContent = 'Foxtrot hidden area paragraph.';
      document.getElementById('hid')?.append(added);
      await wait();
      show();
      await vi.waitFor(() => expect(sentTexts()).toContain('Foxtrot hidden area paragraph.'));
    });

    it('(g) still translates a paragraph added in an ordinary area', async () => {
      const { session, show, sentTexts } = setup('<div id="plain"></div>');
      await session.start();
      const added = document.createElement('p');
      added.textContent = 'Golf ordinary area paragraph.';
      document.getElementById('plain')?.append(added);
      await wait();
      show();
      await vi.waitFor(() => expect(sentTexts()).toContain('Golf ordinary area paragraph.'));
    });
  });

  describe('site skips', () => {
    const MARKUP =
      '<div id="feed"><p>Existing post text.</p><figure class="efx-fig"><div class="efx-slot" role="group"></div></figure></div>';

    let originalHref = '';
    beforeEach(() => {
      originalHref = location.href;
    });
    afterEach(() => {
      setURL(originalHref);
    });

    async function lazyFill(url: string) {
      setURL(url);
      const ctx = setup(MARKUP);
      await ctx.session.start();
      ctx.show();
      await vi.waitFor(() => expect(ctx.port.calls).toHaveLength(1));
      ctx.port.calls[0]?.answer();
      await vi.waitFor(() => expect(translations().length).toBeGreaterThan(0));
      await wait();
      const slot = document.querySelector('.efx-slot') as HTMLElement;
      const lazy = document.createElement('div');
      lazy.textContent = 'Lazy mock-up label.';
      slot.append(lazy);
      // Let the slot be reported (and rescanned) on its own before #feed changes too.
      await wait();
      const control = document.createElement('p');
      control.textContent = 'Control paragraph hotel.';
      document.getElementById('feed')?.append(control);
      await wait();
      ctx.show();
      await vi.waitFor(() => expect(ctx.sentTexts()).toContain('Control paragraph hotel.'));
      await wait();
      return ctx;
    }

    it('does not translate lazily filled content inside a claude.dev mock-up', async () => {
      const ctx = await lazyFill('https://claude.dev/blog');
      expect(ctx.sentTexts().filter((text) => text.includes('Lazy mock-up'))).toEqual([]);
    });

    it('translates the same content on other sites', async () => {
      const ctx = await lazyFill('https://example.com/blog');
      expect(ctx.sentTexts()).toContain('Lazy mock-up label.');
    });
  });

  it('keeps one translation when a mixed parent loses its block child', async () => {
    const { session, port, show } = setup(
      '<div id="host">Inline lead text here. <div id="inner"><p>Block child text.</p></div></div>',
    );
    await session.start();
    show([document.getElementById('host') as HTMLElement]);
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    document.getElementById('inner')?.remove();
    await wait(150);
    expect(translations()).toEqual(['译:Inline lead text here.']);
  });

  it('forgets units whose whole area left before they were translated', async () => {
    const { session, show, observed, unobserved } = setup(
      '<section id="feed"><p>Never shown post text.</p></section><div><p>Other text here.</p></div>',
    );
    await session.start();
    show(observed.slice(1));
    const feed = document.getElementById('feed') as HTMLElement;
    const paragraph = feed.querySelector('p') as HTMLElement;
    feed.remove();
    document.body.append(document.createElement('div'));
    await vi.waitFor(() => expect(unobserved).toContain(paragraph));
  });

  it('lets go of paragraphs the page removed', async () => {
    const { session, port, show, unobserved } = setup(
      '<div><p id="gone">Soon removed text.</p></div>',
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const gone = document.getElementById('gone') as HTMLElement;
    gone.remove();
    await vi.waitFor(() => expect(unobserved).toContain(gone));
    expect(session.state().translated).toBe(0);
  });

  it('puts back a translation a framework removed, but gives up after three times', async () => {
    const { session, port, show } = setup('<p id="x">Framework fights here.</p>');
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let round = 0; round < 3; round += 1) {
      document.querySelector('et-tr')?.remove();
      await vi.waitFor(() => expect(translations()).toHaveLength(1));
    }
    document.querySelector('et-tr')?.remove();
    await wait(100);
    expect(translations()).toHaveLength(0);
    expect(port.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('processes a huge first viewport callback in slices', async () => {
    const markup = Array.from({ length: 1200 }, (_, i) => `<p>Paragraph number ${i} text.</p>`);
    const { session, port, show, sentTexts } = setup(markup.join(''));
    await session.start();
    show();
    await vi.waitFor(() => expect(sentTexts()).toHaveLength(300), { timeout: 3000 });
    expect(port.calls).toHaveLength(6);
    for (const call of port.calls) call.answer();
    await vi.waitFor(() => expect(sentTexts()).toHaveLength(600), { timeout: 3000 });
  });
});

describe('page session: subscribe', () => {
  it('pushes the current state once per frame and coalesces a burst', async () => {
    const { session, runFrame, queuedFrames } = setup('<p>Subscribe burst text.</p>');
    const seen: string[] = [];
    session.subscribe((state) => seen.push(state.phase));
    await session.start();
    expect(queuedFrames()).toBe(1);
    expect(seen).toEqual([]);
    runFrame();
    expect(seen).toEqual(['running']);
    runFrame();
    expect(seen).toEqual(['running']);
  });

  it('pushes the configured mode as soon as the session has it', async () => {
    const config = createDefaultConfig('zh-CN');
    config.page.mode = 'translation';
    const { session, runFrame, queuedFrames } = setup('<p>Mode push text.</p>', async () => config);
    const seen: string[] = [];
    session.subscribe((state) => seen.push(state.mode));
    const started = session.start();
    runFrame();
    // Before the config is read the mode can only be the default.
    expect(seen).toEqual(['bilingual']);
    await started;
    // No report has run yet (nothing was shown): this push comes from start itself.
    expect(queuedFrames()).toBe(1);
    runFrame();
    expect(seen).toEqual(['bilingual', 'translation']);
  });

  it('does not queue a frame without subscribers', async () => {
    const { session, queuedFrames } = setup('<p>No subscriber text.</p>');
    await session.start();
    expect(queuedFrames()).toBe(0);
  });

  it('pushes after begin, report (translations arriving), setMode, retryFailed and stop', async () => {
    const { session, port, show, runFrame } = setup('<p>Call site paragraph.</p>');
    const seen: { phase: string; translated: number; mode: string; failed: number }[] = [];
    session.subscribe(({ phase, translated, mode, failed }) =>
      seen.push({ phase, translated, mode, failed }),
    );
    await session.start();
    runFrame();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    await vi.waitFor(() => expect(session.state().phase).toBe('done'));
    seen.length = 0;
    runFrame();
    expect(seen.at(-1)).toMatchObject({ phase: 'done', translated: 1 });

    seen.length = 0;
    await session.setMode('translation');
    runFrame();
    expect(seen).toEqual([{ phase: 'done', translated: 1, mode: 'translation', failed: 0 }]);

    seen.length = 0;
    session.retryFailed();
    runFrame();
    expect(seen).toHaveLength(1);

    seen.length = 0;
    await session.stop();
    runFrame();
    expect(seen.at(-1)).toMatchObject({ phase: 'idle', translated: 0 });
  });

  it('pushes when failures are recorded and when an engine error pauses the session', async () => {
    const { session, port, show, runFrame } = setup('<p>Failure push text.</p>');
    const seen: { failed: number; error: boolean }[] = [];
    session.subscribe(({ failed, engineError: error }) =>
      seen.push({ failed, error: error !== undefined }),
    );
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const [item] = port.calls[0]?.payload.items ?? [];
    port.calls[0]?.onChunk?.({ id: item?.id ?? '', error: engineError('config/missing-key') });
    await vi.waitFor(() => expect(session.state().engineError).toBeDefined());
    runFrame();
    expect(seen.at(-1)).toEqual({ failed: 0, error: true });
    seen.length = 0;
    session.retryFailed();
    runFrame();
    expect(seen.at(-1)).toEqual({ failed: 0, error: false });
  });

  it('pushes the pinned engine at start and the new one when it is switched', async () => {
    const { session, runFrame } = setup('<p>Switch engine text.</p>');
    const seen: (string | undefined)[] = [];
    session.subscribe((state) => seen.push(state.engine));
    await session.start();
    runFrame();
    // The engine is fixed as soon as the config is read: pushed right away.
    expect(seen).toEqual(['google']);
    await session.start({ engine: 'deepseek' });
    runFrame();
    expect(seen).toEqual(['google', 'deepseek']);
  });

  it('stops pushing after unsubscribe and cancels the queued frame', async () => {
    const { session, runFrame, queuedFrames } = setup('<p>Unsubscribe text.</p>');
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await session.start();
    expect(queuedFrames()).toBe(1);
    unsubscribe();
    expect(queuedFrames()).toBe(0);
    runFrame();
    expect(listener).not.toHaveBeenCalled();
    await session.stop();
    runFrame();
    expect(listener).not.toHaveBeenCalled();
  });

  it('pushes on halt with halted set, and not before', async () => {
    const { session, port, show, runFrame, queuedFrames } = setup('<p>Halt push text.</p>');
    const seen: (true | undefined)[] = [];
    session.subscribe((state) => seen.push(state.halted));
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    await wait();
    runFrame();
    expect(queuedFrames()).toBe(0);
    expect(session.state()).not.toHaveProperty('halted');
    seen.length = 0;
    port.calls[0]?.finish({
      status: 'error',
      error: appError('internal', 'internal/context-invalidated', 'gone'),
    });
    await vi.waitFor(() => expect(session.state().halted).toBe(true));
    await wait();
    // The halted session reports nothing more: this push is halt's own.
    runFrame();
    expect(seen).toEqual([true]);
  });

  it('keeps an isle host out of translation and of rescans, even when a page moves it into the body', async () => {
    const { session, show, port, dirtyRounds } = setup('<p>Host skip paragraph.</p>');
    const before = document.createElement('et-isle');
    before.textContent = 'Isle light text';
    document.body.append(before);
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const sent = port.calls.flatMap((call) => call.payload.items.map((item) => item.text));
    expect(sent.join(' ')).not.toContain('Isle');
    await wait(30);
    dirtyRounds.length = 0;
    // The isle mounts under <html>; a page that moves it into the watched body, or
    // touches its light DOM there, must not cost a rescan.
    const host = document.createElement('et-isle');
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>Isle inner text</p>';
    document.body.append(host);
    await wait(30);
    host.append(document.createElement('p'));
    await wait();
    expect(dirtyRounds).toEqual([]);
    expect(port.calls).toHaveLength(1);
  });

  it('keeps a palette host out of translation and of rescans, even inside a dialog in the body', async () => {
    const { session, show, port, dirtyRounds } = setup('<p>Palette skip paragraph.</p>');
    const dialog = document.createElement('dialog');
    dialog.open = true;
    const palette = document.createElement('et-palette');
    palette.textContent = 'Palette light text';
    dialog.append(palette);
    document.body.append(dialog);
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const sent = port.calls.flatMap((call) => call.payload.items.map((item) => item.text));
    expect(sent.join(' ')).not.toContain('Palette light');
    await wait(30);
    dirtyRounds.length = 0;
    // The palette mounts into an open modal dialog: its comings and goings cost no rescan.
    const next = document.createElement('et-palette');
    next.attachShadow({ mode: 'open' }).innerHTML = '<p>Palette inner text</p>';
    dialog.append(next);
    await wait(30);
    next.append(document.createElement('p'));
    await wait();
    expect(dirtyRounds).toEqual([]);
    expect(port.calls).toHaveLength(1);
  });

  it('keeps a selection card host out of translation, even inside the body', async () => {
    const { session, show, port } = setup('<p>Card skip paragraph.</p>');
    const card = document.createElement('et-selection');
    card.textContent = 'Selection card text';
    document.body.append(card);
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const sent = port.calls.flatMap((call) => call.payload.items.map((item) => item.text));
    expect(sent.join(' ')).not.toContain('Selection card');
    await wait(30);
    // A node inside the host is ours too: no rescan.
    card.append(document.createElement('p'));
    await wait();
    expect(port.calls).toHaveLength(1);
  });
});

/**
 * The mutation watch is a fake that keeps its options. The first element of `tag` the
 * scan asks about runs `hook` synchronously (once, and only after the watch exists,
 * so a start that watches too late changes the DOM without telling anyone).
 */
function midScan(
  markup: string,
  tag: string,
  hook: (options: MutationWatchOptions, ctx: ReturnType<typeof setup>) => void,
  getConfig?: () => Promise<ReturnType<typeof createDefaultConfig>>,
  extra: Partial<SessionDeps> = {},
) {
  let options: MutationWatchOptions | undefined;
  let unwatched = 0;
  let fired = false;
  let ctx!: ReturnType<typeof setup>;
  ctx = setup(markup, getConfig, {
    createReadStyle: () => (el) => {
      if (!fired && options && el.tagName === tag) {
        fired = true;
        hook(options, ctx);
      }
      return readStyle(el);
    },
    createMutationWatch: (given) => {
      options = given;
      return () => {
        unwatched += 1;
      };
    },
    ...extra,
  });
  return {
    ...ctx,
    unwatched: () => unwatched,
    onDirty: (els: Element[]) => options?.onDirty(els),
  };
}

describe('page session: removing our own translations', () => {
  it('does not count the translations it removes itself as a page change', async () => {
    let clock = 100_000;
    const rounds: Element[][] = [];
    const { session, port, show } = setup(
      Array.from({ length: 40 }, (_, i) => `<p>Card ${i} about the old route.</p>`).join(''),
      undefined,
      {
        createMutationWatch: (options) =>
          watchMutations({
            ...options,
            debounceMs: 5,
            now: () => clock,
            onDirty: (elements) => {
              rounds.push(elements);
              options.onDirty(elements);
            },
          }),
      },
    );
    const wholePage = () => rounds.filter((round) => round.includes(document.body));
    await session.start();
    show();
    await vi.waitFor(() => expect(port.calls.length).toBeGreaterThan(0));
    for (const call of port.calls) call.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(40));
    rounds.length = 0;

    // The route changes: every paragraph gets new text, more than one round takes.
    document.querySelectorAll('p').forEach((p, i) => {
      (p.firstChild as Text).nodeValue = `Card ${i} about the new route.`;
    });
    await vi.waitFor(() => expect(wholePage()).toHaveLength(1));
    // The rescan forgets the 40 old units and removes their translations.
    await vi.waitFor(() => expect(translations()).toHaveLength(0));
    // Past the raised cooldown, with time to spare for a second round that should not come.
    clock += 2500;
    await wait(80);
    expect(wholePage()).toHaveLength(1);
  });
});

describe('page session: watching before the initial scan', () => {
  const NEW_BLOCKS = '<div id="n"><div>New heading text.</div><div>New body text.</div></div>';

  const answerAll = async (t: ReturnType<typeof setup>) => {
    for (const call of t.port.calls) call.answer();
    await wait(10);
  };

  it('translates a paragraph added to a container the scan had already passed', async () => {
    const t = midScan(
      '<div id="a"><p>Early text here.</p></div><div><p>Later <span>text</span> here.</p></div>',
      'SPAN',
      (options) => {
        const box = document.getElementById('a') as HTMLElement;
        box.insertAdjacentHTML('beforeend', '<p>Inserted late text.</p>');
        options.onDirty([box]);
      },
    );
    await t.session.start();
    await vi.waitFor(() => expect(t.observed.length).toBeGreaterThanOrEqual(3));
    t.show();
    await vi.waitFor(() => expect(t.sentTexts()).toContain('Inserted late text.'));
    await answerAll(t);
    await vi.waitFor(() => expect(translations()).toContain('译:Inserted late text.'));
    await t.session.stop();
  });

  it('sends blocks added to an unfinished container as separate blocks, each text once', async () => {
    const t = midScan(
      '<div id="feed"><div><span>Old one</span> text here.</div><div>Old two text here.</div></div>',
      'SPAN',
      (options) => {
        const feed = document.getElementById('feed') as HTMLElement;
        feed.insertAdjacentHTML('beforeend', NEW_BLOCKS);
        options.onDirty([feed]);
      },
    );
    await t.session.start();
    await vi.waitFor(() => expect(t.observed.length).toBeGreaterThanOrEqual(4));
    t.show();
    await vi.waitFor(() => expect(t.sentTexts().length).toBeGreaterThanOrEqual(4));
    await wait(30);
    expect([...t.sentTexts()].sort()).toEqual(
      [
        'New body text.',
        'New heading text.',
        '<t0>Old one</t0> text here.',
        'Old two text here.',
      ].sort(),
    );
    await t.session.stop();
  });

  it('sends link text once when something is added to the link during the scan', async () => {
    const t = midScan(
      '<p id="p">Read <a id="a" href="/x"><b>the</b> guide</a> now.</p>',
      'B',
      (options) => {
        const link = document.getElementById('a') as HTMLElement;
        link.insertAdjacentHTML('beforeend', '<svg></svg>');
        options.onDirty([link]);
      },
    );
    await t.session.start();
    await vi.waitFor(() => expect(t.observed.length).toBeGreaterThanOrEqual(1));
    t.show();
    await vi.waitFor(() => expect(t.sentTexts().length).toBeGreaterThanOrEqual(1));
    await wait(30);
    expect(t.sentTexts().filter((text) => text.includes('guide'))).toHaveLength(1);
    expect(t.sentTexts()).toHaveLength(1);
    // The hook really fired during the scan.
    expect(document.querySelector('#a svg')).not.toBeNull();
    await t.session.stop();
  });

  it('stops watching when stopped during the scan', async () => {
    const t = midScan('<div><p>One <span>two</span> three.</p></div>', 'SPAN', () => {
      void t.session.stop();
    });
    await t.session.start();
    expect(t.session.state().phase).toBe('idle');
    expect(t.unwatched()).toBe(1);
  });

  it('applies a style set while the config was loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = setup('<p>Style during load text.</p>', async () => {
      await gate;
      return createDefaultConfig('zh-CN');
    });
    const started = t.session.start();
    await vi.waitFor(() => expect(t.configListeners).toHaveLength(1));
    const next = createDefaultConfig('zh-CN');
    next.page.style = 'highlight';
    for (const listener of t.configListeners) listener(next);
    release();
    await started;
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await answerAll(t);
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr')?.getAttribute('data-et-s')).toBe('highlight'),
    );
    await t.session.stop();
  });

  it('applies a style set while the page is being scanned', async () => {
    const next = createDefaultConfig('zh-CN');
    next.page.style = 'underline';
    const t = midScan('<p>Style <span>during</span> scan text.</p>', 'SPAN', (_options, ctx) => {
      for (const listener of ctx.configListeners) listener(next);
    });
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    await answerAll(t);
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr')?.getAttribute('data-et-s')).toBe('underline'),
    );
    await t.session.stop();
  });

  it('still finishes stopping when the config cannot be read and the unsubscribe throws', async () => {
    const t = setup(
      '<p>Unreadable and gone text.</p>',
      async () => {
        throw new Error('storage gone');
      },
      {
        watchConfig: () => () => {
          throw new Error('extension gone');
        },
      },
    );
    await expect(t.session.start()).rejects.toThrow('storage gone');
    expect(t.session.state().phase).toBe('idle');
    expect(t.statuses.at(-1)).toBe('idle');
  });
});

describe('page session: too-long paragraphs', () => {
  const LONG = 'word '.repeat(1100);
  const SHORT = 'Short ordinary paragraph text.';
  const BOX = `<div id="c"><p id="long">${LONG}</p><p id="short">${SHORT}</p></div>`;
  const notes = () => document.querySelectorAll('et-tr[data-et-state="skipped"]');
  const hasSkipped = (t: ReturnType<typeof setup>) => 'skipped' in t.session.state();
  const sentLong = (t: ReturnType<typeof setup>) =>
    t.sentTexts().some((text) => text.includes('word word'));
  /** Starts, brings every root into range and waits for the ordinary paragraph's request. */
  async function begin(t: ReturnType<typeof setup>) {
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(notes()).toHaveLength(1));
  }

  it('counts the paragraph, leaves a note and never sends its text', async () => {
    const t = setup(BOX);
    await begin(t);
    expect(t.session.state()).toMatchObject({ skipped: 1, failed: 0 });
    expect(t.sentTexts()).toContain(SHORT);
    expect(sentLong(t)).toBe(false);
    await t.session.stop();
  });

  it('reaches done with only an oversized paragraph, and does not count it as translated', async () => {
    const t = setup(`<div id="c"><p id="long">${LONG}</p></div>`);
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(notes()).toHaveLength(1));
    expect(t.port.calls).toHaveLength(0);
    expect(t.session.state()).toMatchObject({
      phase: 'done',
      translated: 0,
      failed: 0,
      skipped: 1,
    });
    expect(t.statuses.at(-1)).toBe('done');
    await t.session.stop();
  });

  it('does not hold up progress: done once the ordinary paragraphs are translated', async () => {
    const t = setup(BOX);
    await begin(t);
    expect(t.session.state().phase).toBe('running');
    t.port.calls[0]?.answer();
    await vi.waitFor(() =>
      expect(t.session.state()).toMatchObject({ phase: 'done', translated: 1 }),
    );
    expect(t.statuses.at(-1)).toBe('done');
    await t.session.stop();
  });

  it('stays at 1 with one note when a paragraph is appended and rescanned', async () => {
    const t = setup(BOX);
    await begin(t);
    const added = document.createElement('p');
    added.textContent = 'A newly appended paragraph.';
    document.getElementById('c')?.append(added);
    await vi.waitFor(() => expect(t.observed).toContain(added));
    t.show([added]);
    await vi.waitFor(() => expect(t.sentTexts()).toContain('A newly appended paragraph.'));
    expect(t.session.state().skipped).toBe(1);
    expect(notes()).toHaveLength(1);
    await t.session.stop();
  });

  it('stays at 1 when content is inserted during the first scan and rescanned', async () => {
    const t = midScan(
      `<div id="c"><p id="long">${LONG}</p><p>Plain <span>marked</span> paragraph.</p></div>`,
      'SPAN',
      (options) => {
        const box = document.getElementById('c') as HTMLElement;
        box.insertAdjacentHTML('beforeend', '<p>Inserted during the scan.</p>');
        options.onDirty([box]);
      },
    );
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.sentTexts()).toContain('Inserted during the scan.'));
    await wait(30);
    expect(t.session.state().skipped).toBe(1);
    expect(notes()).toHaveLength(1);
    await t.session.stop();
  });

  it('stays at 1 when two rescans over the same area run at once', async () => {
    const t = midScan(BOX, 'NONE', () => undefined);
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(notes()).toHaveLength(1));
    const box = document.getElementById('c') as HTMLElement;
    box.insertAdjacentHTML('beforeend', '<p>Added before the double rescan.</p>');
    t.onDirty([box]);
    t.onDirty([box]);
    await vi.waitFor(() => {
      t.show();
      expect(t.sentTexts()).toContain('Added before the double rescan.');
    });
    // The paragraph going out proves one rescan finished; give the other one time to
    // commit too before checking that nothing was counted twice.
    await wait(80);
    expect(t.session.state().skipped).toBe(1);
    expect(notes()).toHaveLength(1);
    await t.session.stop();
  });

  it('leaves nothing behind when stopped in the middle of the scan', async () => {
    const t = midScan(
      `<div><p>${LONG}</p><p>Plain <span>marked</span> paragraph.</p></div>`,
      'SPAN',
      () => {
        void t.session.stop();
      },
    );
    await t.session.start();
    await wait(60);
    expect(hasSkipped(t)).toBe(false);
    expect(notes()).toHaveLength(0);
  });

  it('drops the note and translates in place once the paragraph is shortened', async () => {
    const t = setup(BOX);
    await begin(t);
    const long = document.getElementById('long') as HTMLElement;
    long.textContent = 'Now a short paragraph.';
    await vi.waitFor(() => expect(hasSkipped(t)).toBe(false));
    expect(notes()).toHaveLength(0);
    t.show();
    await vi.waitFor(() => expect(t.sentTexts()).toContain('Now a short paragraph.'));
    t.port.calls.at(-1)?.answer();
    await vi.waitFor(() =>
      expect(long.querySelector('et-tr')?.textContent).toBe('译:Now a short paragraph.'),
    );
    await t.session.stop();
  });

  it('swaps a translation for the note when an ordinary paragraph grows too long', async () => {
    const t = setup(BOX);
    await begin(t);
    t.port.calls[0]?.answer();
    const short = document.getElementById('short') as HTMLElement;
    await vi.waitFor(() => expect(t.session.state().translated).toBe(1));
    short.textContent = LONG;
    await vi.waitFor(() => expect(t.session.state().skipped).toBe(2));
    await vi.waitFor(() => expect(notes()).toHaveLength(2));
    expect(t.session.state().translated).toBe(0);
    expect(short.querySelector('et-tr')?.getAttribute('data-et-state')).toBe('skipped');
    expect(translations().filter((text) => text?.startsWith('译:'))).toEqual([]);
    expect(sentLong(t)).toBe(false);
    await t.session.stop();
  });

  it('stops counting a paragraph the page removed', async () => {
    const t = setup(BOX);
    await begin(t);
    document.getElementById('long')?.remove();
    await vi.waitFor(() => expect(hasSkipped(t)).toBe(false));
    expect(notes()).toHaveLength(0);
    await t.session.stop();
  });

  it('keeps count and note across a mode switch there and back, and retryFailed', async () => {
    const t = setup(BOX);
    await begin(t);
    await t.session.setMode('translation');
    await t.session.setMode('bilingual');
    t.session.retryFailed();
    await wait(30);
    expect(t.session.state().skipped).toBe(1);
    expect(notes()).toHaveLength(1);
    expect(document.getElementById('long')?.hasAttribute('data-et-only')).toBe(false);
    await t.session.stop();
  });

  it('counts only real failures as failed and never resends the long text on retry', async () => {
    const t = setup(BOX);
    await begin(t);
    const call = t.port.calls[0] as Call;
    call.onChunk?.({
      id: call.payload.items[0]?.id ?? '',
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    call.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() => expect(t.session.state().failed).toBe(1));
    expect(t.session.state().skipped).toBe(1);
    t.session.retryFailed();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([SHORT]);
    expect(sentLong(t)).toBe(false);
    await t.session.stop();
  });

  it('sends nothing and shows no dot when the viewport reports it again', async () => {
    const near = new Set<Element>();
    const t = setup(`<div id="c"><p id="long">${LONG}</p></div>`, undefined, {
      loadingDelayMs: 40,
      loadingScanMs: 20,
      inViewport: (el) => near.has(el),
    });
    await t.session.start();
    await vi.waitFor(() => expect(t.observed.length).toBeGreaterThan(0));
    const long = document.getElementById('long') as HTMLElement;
    near.add(long);
    t.hide([long]);
    t.show([long]);
    await wait(150);
    expect(t.port.calls).toHaveLength(0);
    expect(document.querySelectorAll('et-tr[data-et-state="loading"]')).toHaveLength(0);
    expect(notes()).toHaveLength(1);
    await t.session.stop();
  });

  it('leaves out the count when there is no such paragraph', async () => {
    const t = setup('<p>Only an ordinary paragraph.</p>');
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    t.port.calls[0]?.answer();
    await vi.waitFor(() => expect(t.session.state().translated).toBe(1));
    expect(hasSkipped(t)).toBe(false);
    await t.session.stop();
  });
});

describe('page session: single-line layouts', () => {
  const style = (el: Element) => (el as HTMLElement).style;
  const fakeStyles: StyleReader = (el) => {
    const own = style(el);
    const display =
      own.display || (el.tagName === 'DIV' || el.tagName === 'BODY' ? 'block' : 'inline');
    return {
      display,
      whiteSpace: own.whiteSpace || 'normal',
      textOverflow: own.textOverflow || 'clip',
    };
  };
  const MARKUP =
    '<div id="c">' +
    '<div id="nav" style="white-space:nowrap">Pricing Plans Overview <a>Docs</a><div>Nested block</div></div>' +
    '<div id="row" style="display:flex;white-space:nowrap">Locked flex row text</div>' +
    '<div class="card" style="overflow:hidden">' +
    '<div id="title" style="white-space:nowrap;text-overflow:ellipsis;overflow:hidden">Truncated card title</div>' +
    '<div id="feature" style="display:flex;gap:8px"><svg></svg>Unlimited projects</div>' +
    '</div>' +
    '<p id="ellipsis" style="text-overflow:ellipsis">Only ellipsis here, free to wrap.</p>' +
    '<p id="plain" style="white-space:nowrap">Plain nowrap block paragraph.</p>' +
    '</div>';

  it('sends nothing for locked units and translates the ordinary ones', async () => {
    const t = setup(MARKUP, undefined, { createReadStyle: () => fakeStyles });
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls.length).toBeGreaterThan(0));
    await wait(80);
    const sent = t.sentTexts().join('\n');
    expect(sent).not.toContain('Pricing Plans');
    expect(sent).not.toContain('Locked flex row');
    expect(sent).not.toContain('Truncated card title');
    expect(sent).toContain('Nested block');
    expect(sent).toContain('Unlimited projects');
    expect(sent).toContain('Only ellipsis here');
    expect(sent).toContain('Plain nowrap block');
    expect(t.session.state()).toMatchObject({ failed: 0 });
    expect(t.session.state().skipped ?? 0).toBe(0);
    for (const id of ['nav', 'row', 'title']) {
      expect(document.querySelector(`#${id} et-tr`)).toBeNull();
    }
  });
});

describe('page session: autoStart', () => {
  const english = '<p>Hello there, this is a paragraph.</p>';

  it('does nothing when the page already declares the target language', async () => {
    const { session, statuses, port } = setup(english);
    document.documentElement.lang = 'zh-CN';
    try {
      expect(await session.autoStart()).toEqual(IDLE_PAGE_STATE);
      expect(statuses).toEqual([]);
      expect(port.calls).toHaveLength(0);
      expect(session.state().phase).toBe('idle');
    } finally {
      document.documentElement.lang = '';
    }
  });

  it('starts on a page in another language', async () => {
    const { session, statuses } = setup(english);
    document.documentElement.lang = 'en';
    try {
      const state = await session.autoStart();
      expect(state.phase).not.toBe('idle');
      expect(statuses[0]).toBe('running');
    } finally {
      document.documentElement.lang = '';
    }
  });

  it('does not start twice when the user starts during language detection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detectLanguage = vi.fn(async () => {
      await gate;
      return { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
    });
    const { session, statuses } = setup(english, undefined, { detectLanguage });
    const auto = session.autoStart();
    await wait(5);
    expect(detectLanguage).toHaveBeenCalledOnce();
    await session.start();
    release();
    await auto;
    expect(statuses.filter((status) => status === 'running')).toHaveLength(1);
  });

  it('has no effect on a session that is already running', async () => {
    const detectLanguage = vi.fn();
    const { session, statuses } = setup(english, undefined, { detectLanguage });
    await session.start();
    const before = statuses.length;
    const state = await session.autoStart();
    expect(state.phase).not.toBe('idle');
    expect(statuses).toHaveLength(before);
    expect(detectLanguage).not.toHaveBeenCalled();
  });
});

describe('page session: toggleAt (hold Ctrl over a paragraph)', () => {
  const POINT = { x: 10, y: 10 };
  const doc = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => unknown };
  /** happy-dom has no layout: the "point" resolves to the given node. */
  const pointAt = (node: Node | null | undefined, startOffset = 0) => {
    doc.caretRangeFromPoint = () => (node ? { startContainer: node, startOffset } : null);
  };
  /** A framework re-render: the element's first text node swapped for a new one. */
  const replaceFirstText = (selector: string, data?: string) => {
    const el = document.querySelector(selector) as Element;
    const old = el.firstChild as Text;
    const fresh = document.createTextNode(data ?? old.data);
    el.replaceChild(fresh, old);
    return fresh;
  };
  /** Answers every request as it comes until `count` translations are in the page. */
  async function answerAll(t: ReturnType<typeof setup>, count: number) {
    const answered = new Set<Call>();
    await vi.waitFor(() => {
      for (const call of t.port.calls) {
        if (answered.has(call)) continue;
        answered.add(call);
        call.answer();
      }
      expect(translations()).toHaveLength(count);
    });
  }
  const MIXED =
    '<div id="d">Run text before the box. <div id="inner">Inner block text here.</div></div>';
  const textOf = (selector: string) => document.querySelector(selector)?.firstChild;
  const loadingDots = () => document.querySelectorAll('et-tr[data-et-state="loading"]').length;

  afterEach(() => {
    delete doc.caretRangeFromPoint;
    vi.restoreAllMocks();
  });

  async function translated(markup: string, extra: Partial<SessionDeps> = {}) {
    const t = setup(markup, undefined, extra);
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    t.port.calls[0]?.answer();
    await vi.waitFor(() => expect(translations().length).toBeGreaterThan(0));
    return t;
  }

  it('removes a translation, and neither the viewport nor a rescan brings it back', async () => {
    const t = await translated('<p id="a">First paragraph text.</p><p>Second paragraph text.</p>');
    pointAt(textOf('#a'));
    await t.session.toggleAt(POINT);
    expect(translations()).toEqual(['译:Second paragraph text.']);
    expect(t.session.state().translated).toBe(1);
    // In range again, and the page changes around it: rescanned, still left alone.
    t.show();
    document.body.insertAdjacentHTML('beforeend', '<p>Third paragraph text.</p>');
    await vi.waitFor(() => expect(t.observed.length).toBeGreaterThan(2));
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
      'Third paragraph text.',
    ]);
    t.port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    await wait();
    expect(translations()).toEqual(['译:Second paragraph text.', '译:Third paragraph text.']);
    expect(document.querySelector('#a et-tr')).toBeNull();
  });

  it('brings a removed paragraph back on the next hold, from memory', async () => {
    const t = await translated('<p id="a">First paragraph text.</p>');
    pointAt(textOf('#a'));
    await t.session.toggleAt(POINT);
    expect(translations()).toEqual([]);
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(translations()).toEqual(['译:First paragraph text.']));
    expect(t.port.calls).toHaveLength(1);
    expect(t.session.state().translated).toBe(1);
  });

  it('treats a hold on the translation like a hold on its source', async () => {
    const t = await translated('<p id="a">First paragraph text.</p>');
    pointAt(document.querySelector('#a et-tr')?.firstChild ?? document.querySelector('#a et-tr'));
    await t.session.toggleAt(POINT);
    expect(translations()).toEqual([]);
    expect(t.session.state().translated).toBe(0);
  });

  it('retries a failed paragraph at once', async () => {
    const t = setup('<p id="a">Fails once paragraph.</p>');
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    const call = t.port.calls[0] as Call;
    call.onChunk?.({
      id: call.payload.items[0]?.id ?? '',
      error: appError('provider', 'provider/bad-response', 'bad'),
    });
    call.finish({ status: 'done', data: { total: 1, failed: 1 } });
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="error"]')).not.toBeNull(),
    );
    pointAt(textOf('#a'));
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.session.state().failed).toBe(0);
    t.port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:Fails once paragraph.']));
  });

  it('translates a paragraph the viewport has not reached yet, with its dot at once', async () => {
    const t = setup('<p>First paragraph text.</p><p id="b">Far below paragraph.</p>');
    await t.session.start();
    t.show(t.observed.slice(0, 1));
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    pointAt(textOf('#b'));
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
      'Far below paragraph.',
    ]);
    // Not after the 600 ms delay, and not only for paragraphs the observer reported.
    await vi.waitFor(
      () => expect(document.querySelector('#b et-tr[data-et-state]')).not.toBeNull(),
      {
        timeout: 300,
      },
    );
    expect(loadingDots()).toBe(1);
  });

  it('translates a paragraph the single-line rule skipped', async () => {
    const styles: StyleReader = (el) => ({
      display: (el as HTMLElement).style.display || (el.tagName === 'DIV' ? 'block' : 'inline'),
      whiteSpace: (el as HTMLElement).style.whiteSpace || 'normal',
      textOverflow: (el as HTMLElement).style.textOverflow || 'clip',
    });
    const t = setup(
      '<p>Ordinary paragraph text.</p>' +
        '<div id="row" style="display:flex;white-space:nowrap">Locked flex row text</div>',
      undefined,
      { createReadStyle: () => styles },
    );
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    expect(t.sentTexts()).toEqual(['Ordinary paragraph text.']);
    pointAt(textOf('#row'));
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
      'Locked flex row text',
    ]);
  });

  it('leaves a too-long paragraph alone', async () => {
    const t = setup(`<p id="long">${'word '.repeat(1100)}</p>`);
    await t.session.start();
    t.show();
    await vi.waitFor(() =>
      expect(document.querySelector('et-tr[data-et-state="skipped"]')).not.toBeNull(),
    );
    pointAt(textOf('#long'));
    await t.session.toggleAt(POINT);
    await wait();
    expect(t.port.calls).toHaveLength(0);
    expect(loadingDots()).toBe(0);
    expect(document.querySelector('et-tr[data-et-state="skipped"]')).not.toBeNull();
  });

  it('does nothing in a protected area', async () => {
    const t = setup(
      '<p>Ordinary paragraph text.</p>' +
        '<div class="notranslate"><p id="kept">Protected paragraph text.</p></div>' +
        '<div translate="no"><div><p id="no">Another protected text.</p></div></div>',
    );
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    for (const selector of ['#kept', '#no']) {
      pointAt(textOf(selector));
      await t.session.toggleAt(POINT);
    }
    await wait();
    expect(t.port.calls).toHaveLength(1);
    expect(loadingDots()).toBe(0);
  });

  it('ignores holds while the first scan is still registering units', async () => {
    // A first scan that stalls at its first yield until the test lets it go on.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 100;
      return clock;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('scheduler', { yield: () => gate });
    try {
      const filler = '<span>x</span>'.repeat(200);
      const t = setup(`<p id="a">Held during the scan.</p><div>${filler}</div>`);
      const started = t.session.start();
      await vi.waitFor(() => expect(document.querySelector('style[data-et]')).not.toBeNull());
      await wait(20);
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      release();
      await started;
      await wait();
      // Nothing sent before the viewport reports: the hold registered nothing of its own.
      expect(t.port.calls).toHaveLength(0);
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      expect(t.sentTexts().filter((text) => text === 'Held during the scan.')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does nothing once the session has halted', async () => {
    let alive = true;
    const t = setup('<p id="a">First paragraph text.</p>', undefined, { alive: () => alive });
    await t.session.start();
    alive = false;
    t.session.retryFailed();
    expect(t.session.state().halted).toBe(true);
    pointAt(textOf('#a'));
    await t.session.toggleAt(POINT);
    await wait();
    expect(t.port.calls).toHaveLength(0);
    expect(document.querySelector('et-tr')).toBeNull();
  });

  it('forgets removed paragraphs on stop: a new start translates them again', async () => {
    const t = await translated('<p id="a">First paragraph text.</p>');
    pointAt(textOf('#a'));
    await t.session.toggleAt(POINT);
    expect(translations()).toEqual([]);
    await t.session.stop();
    await t.session.start();
    t.show();
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    t.port.calls[1]?.answer();
    await vi.waitFor(() => expect(translations()).toEqual(['译:First paragraph text.']));
  });

  it('a span that became a block since the scan: no second translation', async () => {
    const displays = new Map<Element, string>();
    const styles: StyleReader = (el) => ({
      display:
        displays.get(el) ?? (el.tagName === 'DIV' || el.tagName === 'BODY' ? 'block' : 'inline'),
    });
    const t = await translated(
      '<div id="d">Text before <span id="s">the inner span text</span> and after.</div>',
      { createReadStyle: () => styles },
    );
    // A stylesheet change: no mutation, only the computed display differs now.
    displays.set(document.getElementById('s') as Element, 'block');
    pointAt(textOf('#s'));
    for (let round = 0; round < 2; round += 1) {
      await t.session.toggleAt(POINT);
      await wait();
      expect(document.querySelectorAll('et-tr:not([data-et-state])').length).toBeLessThanOrEqual(1);
    }
    expect(t.port.calls).toHaveLength(1);
  });

  it('cancels a paragraph whose request is out: its reply is not shown', async () => {
    const t = setup('<p>First paragraph text.</p><p id="b">Far below paragraph.</p>');
    await t.session.start();
    t.show(t.observed.slice(0, 1));
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
    pointAt(textOf('#b'));
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    await vi.waitFor(() => expect(loadingDots()).toBe(1));
    await t.session.toggleAt(POINT);
    expect(loadingDots()).toBe(0);
    t.port.calls[1]?.answer();
    await wait();
    expect(document.querySelector('#b et-tr')).toBeNull();
    expect(t.session.state()).toMatchObject({ translated: 0, failed: 0 });
  });

  it('cancels a re-rendered run that is about to come back from memory', async () => {
    const t = await translated(MIXED);
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    // The framework swaps the run's text node; the hold comes before the page's own rescan.
    pointAt(replaceFirstText('#d'));
    await t.session.toggleAt(POINT);
    await wait(100);
    expect(document.querySelector('#d > et-tr')).toBeNull();
    expect(translations()).toEqual(['译:Inner block text here.']);
  });

  it('keeps a restored run untranslated after the framework swaps its text node', async () => {
    const t = await translated(MIXED);
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    pointAt(textOf('#d'));
    await t.session.toggleAt(POINT);
    expect(document.querySelector('#d > et-tr')).toBeNull();
    const rounds = t.dirtyRounds.length;
    replaceFirstText('#d');
    await vi.waitFor(() => expect(t.dirtyRounds.length).toBeGreaterThan(rounds));
    await wait(100);
    // Keyed by root and text, not by Unit: the rescan's new unit is left alone too.
    expect(document.querySelector('#d > et-tr')).toBeNull();
    expect(t.port.calls).toHaveLength(1);
  });

  it('takes the child at the caret when the caret is between children of a mixed block', async () => {
    const t = setup(
      '<div id="d">First run text here. <div>Inner block text here.</div> Second run text here.</div>',
    );
    await t.session.start();
    t.show();
    await answerAll(t, 3);
    const second = () => translations().some((text) => text?.includes('Second run'));
    const d = document.getElementById('d') as Element;
    // The caret sits before the second run's text node (translations count as children too).
    pointAt(d, [...d.childNodes].indexOf(d.lastChild?.previousSibling as ChildNode));
    await t.session.toggleAt(POINT);
    expect(second()).toBe(false);
    expect(translations().some((text) => text?.includes('First run'))).toBe(true);
    // Past the last child: the last one.
    pointAt(d, 99);
    await t.session.toggleAt(POINT);
    await vi.waitFor(() => expect(second()).toBe(true));
  });

  it('shows the dot at once for new text the catch-up rescan already queued', async () => {
    const t = await translated(MIXED);
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    // New text in a root already in range: the catch-up rescan makes it pending itself.
    const added = document.createTextNode(' A second run text now.');
    document.getElementById('d')?.append(added);
    pointAt(added);
    await t.session.toggleAt(POINT);
    await vi.waitFor(
      () => expect(document.querySelector('#d > et-tr[data-et-state="loading"]')).not.toBeNull(),
      { timeout: 300 },
    );
    await vi.waitFor(() => expect(t.sentTexts()).toContain('A second run text now.'));
  });

  it('counts only the source text toward the block limit, not its translations', async () => {
    const big = (word: string) => `<p>${`${word} `.repeat(600)}</p>`;
    const t = setup(
      `<div id="d">Run text before the box. ${big('alpha')}${big('beta')}${big('gamma')}</div>`,
    );
    await t.session.start();
    t.show();
    await answerAll(t, 4);
    // Source about 15 000 characters, with translations over 30 000.
    expect(document.getElementById('d')?.textContent?.length).toBeGreaterThan(20_000);
    pointAt(replaceFirstText('#d'));
    await t.session.toggleAt(POINT);
    await wait(100);
    expect(document.querySelector('#d > et-tr')).toBeNull();
  });

  describe('with no page session: held paragraphs only (scope units)', () => {
    const PAGE = '<p id="a">First paragraph text.</p><p id="b">Second paragraph text.</p>';
    const ownCopies = (selector: string) =>
      document.querySelectorAll(`${selector} et-tr:not([data-et-state])`).length;

    /** Holds over #a with no session and lets its translation in. */
    async function held(
      markup = PAGE,
      getConfig?: Parameters<typeof setup>[1],
      extra: Partial<SessionDeps> = {},
    ) {
      const t = setup(markup, getConfig, extra);
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      t.port.calls[0]?.answer();
      await vi.waitFor(() => expect(translations()).toEqual(['译:First paragraph text.']));
      return t;
    }

    it('translates only the held paragraph: no page scan, no viewport, no status dot', async () => {
      const t = await held();
      expect(t.sentTexts()).toEqual(['First paragraph text.']);
      expect(t.observed).toEqual([]);
      const state = t.session.state();
      expect(state).toMatchObject({ phase: 'done', scope: 'units', translated: 1 });
      expect(t.statuses.filter((status) => status !== 'idle')).toEqual([]);
      await wait();
      expect(t.port.calls).toHaveLength(1);
    });

    it('grows into the page on start: the held paragraph keeps its one translation', async () => {
      const t = await held();
      await t.session.start();
      expect(t.session.state().scope).toBeUndefined();
      expect(t.statuses).toContain('running');
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
        'Second paragraph text.',
      ]);
      t.port.calls[1]?.answer();
      await vi.waitFor(() => expect(translations()).toHaveLength(2));
      await wait();
      expect(ownCopies('#a')).toBe(1);
      expect(t.session.state()).toMatchObject({ phase: 'done', translated: 2 });
    });

    it('grows while the held paragraph is still out: no second request, no second copy', async () => {
      const t = setup(PAGE);
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      await t.session.start();
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
        'Second paragraph text.',
      ]);
      t.port.calls[0]?.answer();
      t.port.calls[1]?.answer();
      await vi.waitFor(() => expect(translations()).toHaveLength(2));
      await wait();
      expect(ownCopies('#a')).toBe(1);
    });

    it('treats toggle as growing into the page, not as stopping', async () => {
      const t = await held();
      const state = await t.session.toggle();
      expect(state.phase).not.toBe('idle');
      expect(t.session.state().scope).toBeUndefined();
      expect(translations()).toEqual(['译:First paragraph text.']);
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    });

    it('a start with an engine switches the engine, then grows into the page', async () => {
      const t = await held();
      await t.session.start({ engine: 'deepseek' });
      expect(t.session.state()).toMatchObject({ engine: 'deepseek' });
      expect(t.session.state().scope).toBeUndefined();
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.engine).toBe('deepseek');
      expect(ownCopies('#a')).toBe(1);
    });

    it('starts over when the target language changed since the paragraph was translated', async () => {
      let target = 'zh-CN';
      const t = await held(PAGE, async () => {
        const config = createDefaultConfig('zh-CN');
        config.language.target = target as typeof config.language.target;
        return config;
      });
      target = 'ja';
      await t.session.start();
      await vi.waitFor(() => expect(translations()).toEqual([]));
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.target).toBe('ja');
      expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
        'First paragraph text.',
        'Second paragraph text.',
      ]);
    });

    it('stop removes every held translation and forgets the paragraphs left alone', async () => {
      const t = setup(PAGE);
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      t.port.calls[0]?.answer();
      pointAt(textOf('#b'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      t.port.calls[1]?.answer();
      await vi.waitFor(() => expect(translations()).toHaveLength(2));
      // #b held again: restored and left alone, until the user stops.
      await t.session.toggleAt(POINT);
      expect(translations()).toEqual(['译:First paragraph text.']);
      await t.session.stop();
      expect(translations()).toEqual([]);
      expect(t.session.state()).toEqual(IDLE_PAGE_STATE);
      await t.session.start();
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(3));
      expect(t.port.calls[2]?.payload.items.map((item) => item.text)).toEqual([
        'First paragraph text.',
        'Second paragraph text.',
      ]);
    });

    it('follows the display mode', async () => {
      const t = await held();
      const state = await t.session.setMode('translation');
      expect(state.mode).toBe('translation');
      expect(state.scope).toBe('units');
    });

    it('drops a translation whose source text changed, and registers nothing new', async () => {
      const t = await held();
      const rounds = t.dirtyRounds.length;
      (document.querySelector('#a') as Element).firstChild?.replaceWith('Edited paragraph text.');
      document.body.insertAdjacentHTML('beforeend', '<p>Brand new paragraph text.</p>');
      await vi.waitFor(() => expect(t.dirtyRounds.length).toBeGreaterThan(rounds));
      await vi.waitFor(() => expect(translations()).toEqual([]));
      await wait();
      expect(t.port.calls).toHaveLength(1);
      expect(t.session.state()).toMatchObject({ translated: 0, scope: 'units' });
      // Growing into the page later finds them all as new.
      await t.session.start();
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.items.map((item) => item.text)).toEqual([
        'Edited paragraph text.',
        'Second paragraph text.',
        'Brand new paragraph text.',
      ]);
    });

    it('shows an engine-level error on the paragraph itself, in the words from the background', async () => {
      const t = setup(PAGE);
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      const error = { ...engineError('provider/unauthorized'), userMessage: '密钥无效' };
      t.port.calls[0]?.finish({ status: 'error', error });
      const note = await vi.waitFor(() => {
        const el = document.querySelector('#a et-tr[data-et-state="error"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      expect(note.title).toBe('密钥无效');
      expect(loadingDots()).toBe(0);
      expect(t.session.state()).toMatchObject({ failed: 1, scope: 'units' });
      expect(t.session.state().engineError).toBeUndefined();
      // Its retry asks again.
      (note.querySelector('button') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
    });

    it('halts once the extension is gone, keeping what is on the page', async () => {
      let alive = true;
      const t = await held(PAGE, undefined, { alive: () => alive });
      alive = false;
      t.session.retryFailed();
      expect(t.session.state()).toMatchObject({ halted: true, scope: 'units' });
      pointAt(textOf('#b'));
      await t.session.toggleAt(POINT);
      await wait();
      expect(t.port.calls).toHaveLength(1);
      expect(translations()).toEqual(['译:First paragraph text.']);
    });

    it('leaves no trace for a hold on blank space, a protected area or a too-long paragraph', async () => {
      let watching = 0;
      const t = setup(
        '<p id="a">First paragraph text.</p>' +
          '<div class="notranslate"><p id="kept">Protected paragraph text.</p></div>' +
          `<p id="long">${'word '.repeat(1100)}</p>`,
        undefined,
        {
          createMutationWatch: (options) => {
            watching += 1;
            const unwatch = watchMutations({ ...options, debounceMs: 5 });
            return () => {
              watching -= 1;
              unwatch();
            };
          },
        },
      );
      for (const target of [null, textOf('#kept'), textOf('#long')]) {
        pointAt(target);
        await t.session.toggleAt(POINT);
        await wait();
        expect(t.session.state()).toEqual(IDLE_PAGE_STATE);
        expect(document.querySelector('style[data-et]')).toBeNull();
        expect(document.querySelector('et-tr')).toBeNull();
        expect(watching).toBe(0);
      }
      expect(t.port.calls).toHaveLength(0);
      expect(t.statuses).toEqual([]);
    });

    it('turns to running the moment it grows, before any await', async () => {
      const t = await held();
      expect(t.session.state().phase).toBe('done');
      const seen: PageState[] = [];
      t.session.subscribe((state) => seen.push(state));
      const growing = t.session.start();
      expect(t.statuses.at(-1)).toBe('running');
      t.runFrame();
      expect(seen[0]?.phase).toBe('running');
      expect(seen[0]?.scope).toBeUndefined();
      await growing;
    });

    it('stops when the target or source language changes in the settings', async () => {
      for (const change of [
        (config: ConfigV1) => {
          config.language.target = 'ja';
        },
        (config: ConfigV1) => {
          config.language.source = 'en';
        },
      ]) {
        const t = await held();
        const next = createDefaultConfig('zh-CN');
        change(next);
        for (const listener of t.configListeners) listener(next);
        await vi.waitFor(() => expect(t.session.state()).toEqual(IDLE_PAGE_STATE));
        await vi.waitFor(() => expect(translations()).toEqual([]));
        await t.session.stop();
      }
    });

    it('follows a change of the default engine', async () => {
      const t = await held();
      const next = createDefaultConfig('zh-CN');
      next.translation.engine = 'deepseek';
      for (const listener of t.configListeners) listener(next);
      expect(t.session.state()).toMatchObject({ engine: 'deepseek', scope: 'units' });
      pointAt(textOf('#b'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.engine).toBe('deepseek');
    });

    it('starts over when the source language changed since the paragraph was translated', async () => {
      let source: ConfigV1['language']['source'] = 'auto';
      const t = await held(PAGE, async () => {
        const config = createDefaultConfig('zh-CN');
        config.language.source = source;
        return config;
      });
      source = 'en';
      await t.session.start();
      await vi.waitFor(() => expect(translations()).toEqual([]));
      t.show();
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(2));
      expect(t.port.calls[1]?.payload.source).toBe('en');
    });

    it('autoStart grows a session the reader began by holding during language detection', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const detectLanguage = vi.fn(async () => {
        await gate;
        return { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
      });
      const t = setup(PAGE, undefined, { detectLanguage });
      const auto = t.session.autoStart();
      await vi.waitFor(() => expect(detectLanguage).toHaveBeenCalledOnce());
      pointAt(textOf('#a'));
      await t.session.toggleAt(POINT);
      expect(t.session.state().scope).toBe('units');
      release();
      const state = await auto;
      expect(state.phase).not.toBe('idle');
      expect(state.scope).toBeUndefined();
      expect(t.observed.length).toBeGreaterThan(0);
    });

    it('keeps a held translation while the page is hidden behind a dialog when it grows', async () => {
      const t = await held(
        '<main id="m"><p id="a">First paragraph text.</p><p>Second paragraph text.</p></main>',
      );
      document.getElementById('m')?.setAttribute('aria-hidden', 'true');
      await t.session.start();
      await wait();
      expect(translations()).toEqual(['译:First paragraph text.']);
      expect(t.session.state().translated).toBe(1);
    });

    it('reads fresh styles before the page scan when it grows', async () => {
      const createReadStyle = vi.fn(() => readStyle);
      const t = await held(PAGE, undefined, { createReadStyle });
      const before = createReadStyle.mock.calls.length;
      await t.session.start();
      expect(createReadStyle.mock.calls.length).toBeGreaterThan(before);
    });

    it('renders nothing for a unit forgotten while its translation waited to go in', async () => {
      const displays = new Map<Element, string>();
      const styles: StyleReader = (el) => ({
        display:
          displays.get(el) ?? (el.tagName === 'DIV' || el.tagName === 'BODY' ? 'block' : 'inline'),
      });
      const t = setup(
        '<div id="d">Text before <span id="s">the inner span text</span> and after.</div>',
        undefined,
        { createReadStyle: () => styles },
      );
      pointAt(textOf('#d'));
      await t.session.toggleAt(POINT);
      await vi.waitFor(() => expect(t.port.calls).toHaveLength(1));
      t.port.calls[0]?.answer();
      await vi.waitFor(() => expect(translations()).toHaveLength(1));
      // Restored, then held again: it comes back from memory on the next render round.
      await t.session.toggleAt(POINT);
      expect(translations()).toEqual([]);
      await t.session.toggleAt(POINT);
      // Before that round, the span became a block: growing forgets the old run.
      displays.set(document.getElementById('s') as Element, 'block');
      await t.session.start();
      await wait(100);
      expect(translations()).toEqual([]);
    });
  });
});
