import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@/lib/errors';
import type { onMessage, PageState } from '@/lib/messaging/protocol';
import { createBootstrap } from './bootstrap';
import {
  IDLE_PAGE_STATE,
  type PageRuntimeDeps,
  type PageRuntimeFactory,
  type PaletteRuntime,
  type PaletteRuntimeDeps,
  type PaletteRuntimeFactory,
  type SelectionRuntime,
  type SelectionRuntimeDeps,
  type SelectionRuntimeFactory,
  type SelectionSnapshot,
} from './runtime-contract';
import type { PageSession } from './session';

type Handler = (message: { data?: unknown }) => Promise<Result<unknown>>;

function fakeSession() {
  let phase: PageState['phase'] = 'idle';
  let halted = false;
  const events: string[] = [];
  const snapshot = (): PageState => ({
    phase,
    mode: 'bilingual',
    translated: 0,
    failed: 0,
    ...(halted ? { halted: true as const } : {}),
  });
  const session: PageSession = {
    start: vi.fn(async () => {
      events.push('start');
      phase = 'running';
      return snapshot();
    }),
    stop: vi.fn(async () => {
      events.push('stop');
      phase = 'idle';
      return snapshot();
    }),
    autoStart: vi.fn(async () => {
      events.push('autoStart');
      return snapshot();
    }),
    toggle: vi.fn(async () => {
      events.push('toggle');
      phase = phase === 'idle' ? 'running' : 'idle';
      return snapshot();
    }),
    setMode: vi.fn(async (mode) => ({ ...snapshot(), mode })),
    retryFailed: vi.fn(snapshot),
    toggleAt: vi.fn(async () => {
      events.push('toggleAt');
    }),
    state: vi.fn(snapshot),
    subscribe: vi.fn(() => () => {}),
  };
  return {
    session,
    events,
    halt: () => {
      halted = true;
    },
  };
}

const runtime: PageRuntimeDeps = {
  getConfig: vi.fn(),
  watchConfig: vi.fn(),
  reportStatus: vi.fn(),
  listEngines: vi.fn(),
};

const selectionDeps: SelectionRuntimeDeps = {
  getConfig: vi.fn(),
  watchConfig: vi.fn(),
  listEngines: vi.fn(),
  detectLanguage: vi.fn(),
};

const snapshot: SelectionSnapshot = {
  source: 'Hello world',
  rect: { left: 0, top: 0, right: 10, bottom: 10 },
  anchor: { x: 10, y: 0 },
};

function fakeSelectionRuntime(): SelectionRuntime {
  return { showDot: vi.fn(), hideDot: vi.fn(), open: vi.fn(), close: vi.fn(), dispose: vi.fn() };
}

function fakePaletteRuntime(): PaletteRuntime {
  return { toggle: vi.fn(), close: vi.fn(), dispose: vi.fn() };
}

const paletteDeps: Omit<PaletteRuntimeDeps, 'page'> = { getConfig: vi.fn(), send: vi.fn() };

interface SetupOptions {
  top?: SelectionSnapshot;
  hasFocus?: boolean;
  loadSelection?: () => Promise<SelectionRuntimeFactory>;
  alive?: () => boolean;
  onContextLost?: () => void;
  loadPalette?: () => Promise<PaletteRuntimeFactory>;
}

function setup(loadFactory?: () => Promise<PageRuntimeFactory>, options: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const fake = fakeSession();
  const create = vi.fn<PageRuntimeFactory>(() => fake.session);
  const load = vi.fn(loadFactory ?? (async () => create));
  const selectionRuntime = fakeSelectionRuntime();
  const createSelection = vi.fn<SelectionRuntimeFactory>(() => selectionRuntime);
  const loadSelection = vi.fn(options.loadSelection ?? (async () => createSelection));
  const paletteRuntime = fakePaletteRuntime();
  const createPalette = vi.fn<PaletteRuntimeFactory>(() => paletteRuntime);
  const loadPalette = vi.fn(options.loadPalette ?? (async () => createPalette));
  const bootstrap = createBootstrap({
    onMessage: ((type: string, handler: Handler) => {
      handlers.set(type, handler);
    }) as unknown as typeof onMessage,
    pageInfo: () => ({ title: 'T', language: 'en' }),
    loadFactory: load,
    runtime,
    selection: {
      loadFactory: loadSelection,
      runtime: selectionDeps,
      read: () => options.top,
      hasFocus: () => options.hasFocus ?? true,
      alive: options.alive,
      onContextLost: options.onContextLost,
    },
    palette: { loadFactory: loadPalette, runtime: paletteDeps },
  });
  const send = (type: string, data?: unknown) => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`no handler for ${type}`);
    return handler({ data });
  };
  return {
    ...fake,
    bootstrap,
    create,
    load,
    send,
    selectionRuntime,
    createSelection,
    loadSelection,
    paletteRuntime,
    createPalette,
    loadPalette,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('bootstrap without a session', () => {
  it('answers page.getInfo itself', async () => {
    const { send, load } = setup();
    expect(await send('page.getInfo')).toEqual({ ok: true, data: { title: 'T', language: 'en' } });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['page.getState', undefined],
    ['page.stop', undefined],
    ['page.setMode', 'original'],
    ['page.retryFailed', undefined],
  ])('%s returns the idle state without loading', async (type, data) => {
    const { send, load } = setup();
    expect(await send(type, data)).toEqual({ ok: true, data: IDLE_PAGE_STATE });
    expect(load).not.toHaveBeenCalled();
  });

  it('page.start loads, starts without waiting, and returns the state', async () => {
    const { send, session, create, load } = setup();
    vi.mocked(session.start).mockReturnValue(new Promise(() => undefined));
    const result = await send('page.start', { engine: 'google' });
    expect(result).toMatchObject({ ok: true, data: { phase: 'idle' } });
    expect(load).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(runtime);
    expect(session.start).toHaveBeenCalledWith({ engine: 'google' });
  });

  it('page.start swallows a failed start', async () => {
    const { send, session } = setup();
    vi.mocked(session.start).mockRejectedValue(new Error('boom'));
    expect(await send('page.start')).toMatchObject({ ok: true });
    expect(session.start).toHaveBeenCalledWith({});
  });

  it('page.toggle loads and awaits the toggle', async () => {
    const { send, session } = setup();
    expect(await send('page.toggle')).toMatchObject({ ok: true, data: { phase: 'running' } });
    expect(session.toggle).toHaveBeenCalledOnce();
  });
});

describe('bootstrap with a ready session', () => {
  it('delegates every message and never loads again', async () => {
    const { send, session, load } = setup();
    await send('page.start');
    expect(await send('page.getState')).toMatchObject({ data: { phase: 'running' } });
    await send('page.setMode', 'original');
    expect(session.setMode).toHaveBeenCalledWith('original');
    await send('page.retryFailed');
    expect(session.retryFailed).toHaveBeenCalledOnce();
    expect(await send('page.stop')).toMatchObject({ data: { phase: 'idle' } });
    expect(await send('page.toggle')).toMatchObject({ data: { phase: 'running' } });
    expect(load).toHaveBeenCalledOnce();
  });
});

describe('bootstrap while loading', () => {
  function slowLoad() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it('getState waits for the session instead of reporting idle', async () => {
    const { gate, release } = slowLoad();
    const fake = fakeSession();
    const t = setup(async () => {
      await gate;
      return () => fake.session;
    });
    const started = t.send('page.toggle');
    const state = t.send('page.getState');
    release();
    await started;
    expect(await state).toMatchObject({ data: { phase: 'running' } });
  });

  it('two quick toggles start and then stop, in order', async () => {
    const { gate, release } = slowLoad();
    const fake = fakeSession();
    const t = setup(async () => {
      await gate;
      return () => fake.session;
    });
    const first = t.send('page.toggle');
    const second = t.send('page.toggle');
    release();
    await Promise.all([first, second]);
    expect(fake.events).toEqual(['toggle', 'toggle']);
    expect(fake.session.state().phase).toBe('idle');
    expect(t.load).toHaveBeenCalledOnce();
  });

  it('a stop sent during loading is not lost', async () => {
    const { gate, release } = slowLoad();
    const fake = fakeSession();
    const t = setup(async () => {
      await gate;
      return () => fake.session;
    });
    const started = t.send('page.start');
    const stopped = t.send('page.stop');
    release();
    await Promise.all([started, stopped]);
    expect(fake.events).toEqual(['start', 'stop']);
  });

  it('auto-start and a user start share one load and one session', async () => {
    const { gate, release } = slowLoad();
    const fake = fakeSession();
    const create = vi.fn<PageRuntimeFactory>(() => fake.session);
    const t = setup(async () => {
      await gate;
      return create;
    });
    const auto = t.bootstrap.autoStart();
    const user = t.send('page.start');
    release();
    await Promise.all([auto, user]);
    expect(t.load).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('autoStart', () => {
  it('loads the runtime and delegates to the session', async () => {
    const { bootstrap, session, load } = setup();
    await bootstrap.autoStart();
    expect(load).toHaveBeenCalledOnce();
    expect(session.autoStart).toHaveBeenCalledOnce();
    expect(session.start).not.toHaveBeenCalled();
  });
});

describe('holdToggle', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const point = { x: 12, y: 34 };

  it('without a session loads the runtime and toggles at the point (held paragraphs only)', async () => {
    const { bootstrap, load, session } = setup();
    bootstrap.holdToggle(point);
    await vi.waitFor(() => expect(session.toggleAt).toHaveBeenCalledWith(point));
    expect(load).toHaveBeenCalledOnce();
  });

  it('two holds while the runtime loads: one load, both reach the session, nothing thrown', async () => {
    let finish!: (create: PageRuntimeFactory) => void;
    const { bootstrap, load, session } = setup(
      () =>
        new Promise<PageRuntimeFactory>((resolve) => {
          finish = resolve;
        }),
    );
    bootstrap.holdToggle(point);
    bootstrap.holdToggle(point);
    await flush();
    expect(load).toHaveBeenCalledOnce();
    finish(() => session);
    await vi.waitFor(() => expect(session.toggleAt).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledOnce();
  });

  it('a failed load throws nothing, and the next hold loads again', async () => {
    let attempt = 0;
    const holder: { session?: PageSession } = {};
    const { bootstrap, load, session } = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('Failed to fetch');
      return () => holder.session as PageSession;
    });
    holder.session = session;
    bootstrap.holdToggle(point);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await flush();
    expect(session.toggleAt).not.toHaveBeenCalled();
    bootstrap.holdToggle(point);
    await vi.waitFor(() => expect(session.toggleAt).toHaveBeenCalledWith(point));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('with an idle session (stopped) toggles at the point too', async () => {
    const { bootstrap, send, session, load } = setup();
    await send('page.start');
    await send('page.stop');
    bootstrap.holdToggle(point);
    await flush();
    expect(session.toggleAt).toHaveBeenCalledWith(point);
    expect(load).toHaveBeenCalledOnce();
  });

  it('with a halted session does nothing', async () => {
    const { bootstrap, send, session, halt } = setup();
    await send('page.start');
    halt();
    bootstrap.holdToggle(point);
    await flush();
    expect(session.toggleAt).not.toHaveBeenCalled();
  });

  it('with a running session toggles at the point', async () => {
    const { bootstrap, send, session, load } = setup();
    await send('page.start');
    bootstrap.holdToggle(point);
    await flush();
    expect(session.toggleAt).toHaveBeenCalledWith(point);
    expect(load).toHaveBeenCalledOnce();
  });

  it('once the extension context is gone, stops the watches and does nothing', async () => {
    const onContextLost = vi.fn();
    let alive = true;
    const { bootstrap, send, session } = setup(undefined, { alive: () => alive, onContextLost });
    await send('page.start');
    alive = false;
    bootstrap.holdToggle(point);
    await flush();
    expect(onContextLost).toHaveBeenCalledOnce();
    expect(session.toggleAt).not.toHaveBeenCalled();
  });
});

describe('bootstrap when loading fails', () => {
  it('maps the failure to page-unreachable for every waiter, including those waiting on the session', async () => {
    let fail!: (error: Error) => void;
    const t = setup(
      () =>
        new Promise<PageRuntimeFactory>((_, reject) => {
          fail = reject;
        }),
    );
    // start and toggle trigger the load; getState, stop, setMode and retryFailed arrive
    // while it is in flight and wait on the same session promise.
    const pending = [
      t.send('page.start'),
      t.send('page.toggle'),
      t.send('page.getState'),
      t.send('page.stop'),
      t.send('page.setMode', 'translation'),
      t.send('page.retryFailed'),
    ];
    await Promise.resolve();
    fail(new Error('Failed to fetch'));
    for (const result of await Promise.all(pending)) {
      expect(result).toMatchObject({ ok: false, error: { code: 'network/page-unreachable' } });
    }
    expect(t.load).toHaveBeenCalledOnce();
  });

  it('clears the cache so the next invocation loads again', async () => {
    // In Chrome a failed module import is cached per URL and the dynamic URL is stable
    // within a browser session, so this second load usually fails the same way until the
    // page is reloaded (the page-unreachable message says so). The bootstrap must still
    // not pin the failure: an invalidated context or a fixed extension gets a fresh try.
    let attempt = 0;
    const fake = fakeSession();
    const t = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('Failed to fetch');
      return () => fake.session;
    });
    expect(await t.send('page.start')).toMatchObject({ ok: false });
    expect(await t.send('page.getState')).toEqual({ ok: true, data: IDLE_PAGE_STATE });
    expect(await t.send('page.start')).toMatchObject({ ok: true });
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it('survives a synchronous loader failure', async () => {
    const t = setup(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(await t.send('page.start')).toMatchObject({
      ok: false,
      error: { code: 'network/page-unreachable' },
    });
    expect(await t.send('page.getState')).toEqual({ ok: true, data: IDLE_PAGE_STATE });
  });

  it('auto-start rejects so the caller can ignore it', async () => {
    const t = setup(async () => {
      throw new Error('x');
    });
    await expect(t.bootstrap.autoStart()).rejects.toMatchObject({
      code: 'network/page-unreachable',
    });
  });
});

describe('selection runtime', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is not loaded by the page messages or at creation', async () => {
    const t = setup();
    await t.send('page.getInfo');
    await t.send('page.start');
    expect(t.loadSelection).not.toHaveBeenCalled();
  });

  it('showDot loads it once, hands over the deps and the snapshot', async () => {
    const t = setup();
    t.bootstrap.showDot(snapshot);
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(t.loadSelection).toHaveBeenCalledOnce();
    expect(t.createSelection).toHaveBeenCalledWith(selectionDeps);
    expect(t.selectionRuntime.showDot).toHaveBeenCalledTimes(2);
    expect(t.selectionRuntime.showDot).toHaveBeenCalledWith(snapshot);
  });

  it('showDot never throws when the load fails, and the next call tries again', async () => {
    let attempt = 0;
    const t = setup(undefined, {
      loadSelection: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('Failed to fetch');
        return () => fakeSelectionRuntime();
      },
    });
    t.bootstrap.showDot(snapshot);
    await flush();
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(t.loadSelection).toHaveBeenCalledTimes(2);
  });

  it('stops the watch once the extension context is gone, without loading or warning', async () => {
    vi.mocked(console.warn).mockClear();
    const onContextLost = vi.fn();
    const t = setup(undefined, { alive: () => false, onContextLost });
    t.bootstrap.showDot(snapshot);
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(t.loadSelection).not.toHaveBeenCalled();
    expect(onContextLost).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a load failing on an invalidated context stops the watch and is never retried', async () => {
    vi.mocked(console.warn).mockClear();
    let alive = true;
    const onContextLost = vi.fn();
    const t = setup(undefined, {
      alive: () => alive,
      onContextLost,
      loadSelection: async () => {
        alive = false;
        throw new Error('Extension context invalidated.');
      },
    });
    t.bootstrap.showDot(snapshot);
    await flush();
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(t.loadSelection).toHaveBeenCalledOnce();
    expect(onContextLost).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('context lost after the runtime loaded: the runtime hides its dot and ends parking', async () => {
    let alive = true;
    const onContextLost = vi.fn();
    const t = setup(undefined, { alive: () => alive, onContextLost });
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(t.selectionRuntime.showDot).toHaveBeenCalledOnce();
    alive = false;
    t.bootstrap.showDot(snapshot);
    await flush();
    expect(onContextLost).toHaveBeenCalledOnce();
    expect(t.selectionRuntime.showDot).toHaveBeenCalledOnce();
    // The watch is stopped, so no later hideDot would ever reach a parked dot.
    expect(t.selectionRuntime.hideDot).toHaveBeenCalledOnce();
  });

  it('hideDot does nothing until the runtime was loaded, then forwards', async () => {
    const t = setup();
    t.bootstrap.hideDot();
    await flush();
    expect(t.loadSelection).not.toHaveBeenCalled();
    t.bootstrap.showDot(snapshot);
    await flush();
    t.bootstrap.hideDot();
    await flush();
    expect(t.selectionRuntime.hideDot).toHaveBeenCalledOnce();
  });

  it('selection.open with the top selection opens the card on it', async () => {
    const t = setup(undefined, { top: snapshot });
    expect(await t.send('selection.open', { selectionText: 'Hello world', frameId: 0 })).toEqual({
      ok: true,
      data: null,
    });
    expect(t.selectionRuntime.open).toHaveBeenCalledWith({
      source: 'Hello world',
      selection: snapshot,
    });
  });

  it('selection.open from an iframe passes only the text', async () => {
    const t = setup(undefined, { top: snapshot });
    await t.send('selection.open', { selectionText: ' Other  text ', frameId: 3 });
    expect(t.selectionRuntime.open).toHaveBeenCalledWith({ source: 'Other text' });
  });

  it('the shortcut without focus does nothing and does not load', async () => {
    const t = setup(undefined, { top: snapshot, hasFocus: false });
    expect(await t.send('selection.open', {})).toEqual({ ok: true, data: null });
    expect(t.loadSelection).not.toHaveBeenCalled();
  });

  it('the shortcut with a selection opens it; with none it closes only a loaded runtime', async () => {
    const withSelection = setup(undefined, { top: snapshot });
    await withSelection.send('selection.open', {});
    expect(withSelection.selectionRuntime.open).toHaveBeenCalledWith({
      source: 'Hello world',
      selection: snapshot,
    });

    const none = setup();
    await none.send('selection.open', {});
    expect(none.loadSelection).not.toHaveBeenCalled();
    none.bootstrap.showDot(snapshot);
    await flush();
    await none.send('selection.open', {});
    expect(none.selectionRuntime.close).toHaveBeenCalledOnce();
    expect(none.selectionRuntime.open).not.toHaveBeenCalled();
  });

  it('selection.open reports page-unreachable when the runtime cannot load', async () => {
    const t = setup(undefined, {
      top: snapshot,
      loadSelection: async () => {
        throw new Error('Failed to fetch');
      },
    });
    expect(await t.send('selection.open', { selectionText: 'Hello world' })).toMatchObject({
      ok: false,
      error: { code: 'network/page-unreachable' },
    });
  });
});

describe('palette runtime', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const paletteDepsOf = (t: ReturnType<typeof setup>) => {
    const deps = t.createPalette.mock.calls[0]?.[0];
    if (!deps) throw new Error('palette not created');
    return deps;
  };

  it('is not loaded until palette.toggle, then loads once and toggles each time', async () => {
    const t = setup();
    await t.send('page.getState');
    expect(t.loadPalette).not.toHaveBeenCalled();
    expect(await t.send('palette.toggle')).toEqual({ ok: true, data: null });
    await t.send('palette.toggle');
    expect(t.loadPalette).toHaveBeenCalledOnce();
    expect(t.paletteRuntime.toggle).toHaveBeenCalledTimes(2);
    // Lent the content script's deps plus the bootstrap's page actions.
    const deps = paletteDepsOf(t);
    expect(deps.getConfig).toBe(paletteDeps.getConfig);
    expect(deps.send).toBe(paletteDeps.send);
    expect(Object.keys(deps.page).sort()).toEqual(
      ['getState', 'retryFailed', 'setMode', 'start', 'stop', 'toggle'].sort(),
    );
  });

  it('page actions lent to the palette give the same results as the page messages', async () => {
    const message = setup();
    const lent = setup();
    await lent.send('palette.toggle');
    const page = paletteDepsOf(lent).page;

    // No session yet: both answer idle without loading.
    expect((await message.send('page.getState')) as Result<PageState>).toEqual({
      ok: true,
      data: await page.getState(),
    });
    expect(message.load).not.toHaveBeenCalled();
    expect(lent.load).not.toHaveBeenCalled();
    expect(await message.send('page.stop')).toEqual({ ok: true, data: await page.stop() });

    // start loads and starts; then each action reaches the same session method.
    expect(await message.send('page.start', { engine: 'google' })).toEqual({
      ok: true,
      data: await page.start({ engine: 'google' }),
    });
    expect(message.session.start).toHaveBeenCalledWith({ engine: 'google' });
    expect(lent.session.start).toHaveBeenCalledWith({ engine: 'google' });
    expect(await message.send('page.setMode', 'translation')).toEqual({
      ok: true,
      data: await page.setMode('translation'),
    });
    expect(await message.send('page.retryFailed')).toEqual({
      ok: true,
      data: await page.retryFailed(),
    });
    expect(await message.send('page.toggle')).toEqual({ ok: true, data: await page.toggle() });
    for (const t of [message, lent]) {
      expect(t.session.setMode).toHaveBeenCalledWith('translation');
      expect(t.session.retryFailed).toHaveBeenCalledOnce();
      expect(t.session.toggle).toHaveBeenCalledOnce();
    }
  });

  it('opening the palette closes the card and the dot', async () => {
    const t = setup();
    t.bootstrap.showDot(snapshot);
    await flush();
    await t.send('palette.toggle');
    await flush();
    expect(t.selectionRuntime.close).toHaveBeenCalledOnce();
    expect(t.selectionRuntime.hideDot).toHaveBeenCalledOnce();
    expect(t.paletteRuntime.toggle).toHaveBeenCalledOnce();
  });

  it('does not load the selection runtime just to close it', async () => {
    const t = setup();
    await t.send('palette.toggle');
    expect(t.loadSelection).not.toHaveBeenCalled();
  });

  it('opening the card closes a loaded palette first, and never loads one', async () => {
    const t = setup(undefined, { top: snapshot });
    await t.send('selection.open', { selectionText: 'Hello world', frameId: 0 });
    expect(t.loadPalette).not.toHaveBeenCalled();

    await t.send('palette.toggle');
    await t.send('selection.open', { selectionText: 'Other', frameId: 2 });
    await flush();
    expect(t.paletteRuntime.close).toHaveBeenCalledOnce();
    expect(t.selectionRuntime.open).toHaveBeenLastCalledWith({ source: 'Other' });
  });

  it('once the extension context is gone: no load, a page-unreachable answer, an open palette closed', async () => {
    let alive = true;
    const t = setup(undefined, { alive: () => alive });
    await t.send('palette.toggle');
    alive = false;
    expect(await t.send('palette.toggle')).toMatchObject({
      ok: false,
      error: { code: 'network/page-unreachable' },
    });
    await flush();
    expect(t.paletteRuntime.toggle).toHaveBeenCalledOnce();
    expect(t.paletteRuntime.close).toHaveBeenCalled();

    const never = setup(undefined, { alive: () => false });
    expect(await never.send('palette.toggle')).toMatchObject({ ok: false });
    expect(never.loadPalette).not.toHaveBeenCalled();
  });

  it('reports page-unreachable when the palette cannot load, and tries again next time', async () => {
    let fail = true;
    const create = vi.fn<PaletteRuntimeFactory>(fakePaletteRuntime);
    const t = setup(undefined, {
      loadPalette: async () => {
        if (fail) throw new Error('Failed to fetch');
        return create;
      },
    });
    expect(await t.send('palette.toggle')).toMatchObject({
      ok: false,
      error: { code: 'network/page-unreachable' },
    });
    fail = false;
    expect(await t.send('palette.toggle')).toEqual({ ok: true, data: null });
    expect(create).toHaveBeenCalledOnce();
  });
});
