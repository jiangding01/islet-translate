// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import type { EngineOptions, PageState } from '@/lib/messaging/protocol';
import { createGetMessage, loadLocales } from '../../../scripts/i18n-messages.mjs';
import type { PageSession } from '../session';
import { createIsle, type IsleEnv } from './isle';

const ENGINES: EngineOptions = {
  configured: 'google',
  options: [
    { id: 'google', name: 'Google 翻译', short: 'G', ready: true },
    { id: 'openai', name: 'OpenAI', short: 'AI', ready: false, note: '未配置密钥' },
    { id: 'deepseek', name: 'DeepSeek', short: 'DS', ready: true },
  ],
};

/** DeepSeek with a one-path icon in the text color; the others without one. */
const WITH_ICONS: EngineOptions = {
  ...ENGINES,
  options: ENGINES.options.map((option) =>
    option.id === 'deepseek'
      ? { ...option, icon: { viewBox: '0 0 24 24', paths: [{ d: 'M0 0h9z', evenOdd: true }] } }
      : option,
  ),
};

function fakeSession() {
  let state: PageState = { phase: 'idle', mode: 'bilingual', translated: 0, failed: 0 };
  const listeners = new Set<(state: PageState) => void>();
  const session = {
    start: vi.fn(async () => state),
    autoStart: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    toggle: vi.fn(async () => state),
    setMode: vi.fn(async () => state),
    retryFailed: vi.fn(() => state),
    toggleAt: vi.fn(async () => {}),
    state: () => state,
    subscribe(listener: (state: PageState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies PageSession;
  /** Pushes the current state to the subscribers (the session's frame firing). */
  const push = () => {
    for (const listener of listeners) listener(state);
  };
  /** Changes the state without pushing yet: the push waits for the session's next frame. */
  const change = (patch: Partial<PageState>) => {
    state = { ...state, ...patch };
  };
  const emit = (patch: Partial<PageState>) => {
    change(patch);
    push();
  };
  return { session, emit, change, push, subscribers: () => listeners.size };
}

/** The window events the isle listens to; counted to catch leaks and duplicates. */
const WINDOW_EVENTS = ['pointermove', 'pointerout', 'scroll', 'pointerdown', 'keydown', 'resize'];

type ListenerOptions = boolean | EventListenerOptions | undefined;

/** Counts live window listeners per event type (same listener + capture = one, as in the DOM). */
function trackWindowListeners() {
  const live = new Map<string, Set<unknown>>();
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  const key = (type: string, options: ListenerOptions) =>
    `${type}:${typeof options === 'boolean' ? options : !!options?.capture}`;
  window.addEventListener = ((type: string, listener: unknown, options?: ListenerOptions) => {
    const k = key(type, options);
    live.set(k, (live.get(k) ?? new Set()).add(listener));
    add.call(window, type, listener as EventListener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: unknown, options?: ListenerOptions) => {
    live.get(key(type, options))?.delete(listener);
    remove.call(window, type, listener as EventListener, options);
  }) as typeof window.removeEventListener;
  const count = (type: string) =>
    [...live].reduce((sum, [k, set]) => sum + (k.startsWith(`${type}:`) ? set.size : 0), 0);
  return {
    count,
    total: () => WINDOW_EVENTS.reduce((sum, type) => sum + count(type), 0),
    restore() {
      window.addEventListener = add;
      window.removeEventListener = remove;
    },
  };
}

/** Run after every test: destroys each isle and checks nothing it set up is left behind. */
const cleanups: (() => void)[] = [];

/** A shorter (or taller) viewport for this test only. */
function viewportHeight(h: number) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(window, 'innerHeight', descriptor);
    else delete (window as { innerHeight?: number }).innerHeight;
  });
}

interface SetupOptions {
  reduce?: boolean;
  background?: string;
  dock?: ConfigV1['page']['isleDock'];
  /** Use the production `isTrusted` check (happy-dom events are all untrusted). */
  realTrust?: boolean;
  listEngines?: () => Promise<EngineOptions>;
  /** Holds the config read until `releaseConfig()`. */
  holdConfig?: boolean;
  /** Subscribing throws (the extension was reloaded: its context is invalidated). */
  watchThrows?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const { session, emit, change, push, subscribers } = fakeSession();
  const listeners = trackWindowListeners();
  let frames = new Map<number, () => void>();
  let nextHandle = 0;
  const motionListeners = new Set<unknown>();
  let background = options.background ?? 'rgb(255, 255, 255)';
  /** The page's fixed or sticky widgets, top-most first, hit-tested by their rectangles. */
  const pinned: { element: Element; position: string }[] = [];
  const positions = new Map<Element, string>();
  const bottoms = new Map<Element, string>();
  const elementsFromPoint = vi.fn((x: number, y: number): Element[] =>
    pinned
      .map(({ element }) => element)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }),
  );
  const env: IsleEnv = {
    win: window,
    raf: (callback) => {
      nextHandle += 1;
      frames.set(nextHandle, callback);
      return nextHandle;
    },
    cancelRaf: (handle) => {
      frames.delete(handle);
    },
    now: () => Date.now(),
    matchMedia: (query) => ({
      matches: !!options.reduce && query.includes('reduced-motion'),
      addEventListener: (_type: string, listener: unknown) => motionListeners.add(listener),
      removeEventListener: (_type: string, listener: unknown) => motionListeners.delete(listener),
    }),
    elementsFromPoint,
    getComputedStyle: (element) => ({
      position: positions.get(element) ?? 'static',
      bottom: bottoms.get(element) ?? 'auto',
      backgroundColor: background,
      colorScheme: 'normal',
    }),
    shadowMode: 'open',
    ...(options.realTrust ? {} : { isTrusted: () => true }),
  };
  const config = createDefaultConfig('zh-CN');
  config.page.isleDock = options.dock ?? 'right';
  let configListener: ((config: ConfigV1) => void) | undefined;
  let subscriptions = 0;
  let releaseConfig = () => {};
  const held = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  const deps = {
    getConfig: vi.fn(async () => {
      if (options.holdConfig) await held;
      return config;
    }),
    watchConfig: vi.fn((callback: (config: ConfigV1) => void) => {
      if (options.watchThrows) {
        throw new Error(
          "Failed to read the 'onChanged' property from 'Object': Extension context invalidated.",
        );
      }
      configListener = callback;
      subscriptions += 1;
      return () => {
        subscriptions -= 1;
        if (configListener === callback) configListener = undefined;
      };
    }),
    listEngines: vi.fn(options.listEngines ?? (async () => ENGINES)),
  };
  const isle = createIsle({ session, deps, env });
  await vi.advanceTimersByTimeAsync(0);

  /** Everything the isle could leave behind; all zero once destroyed. */
  const leftovers = () => ({
    windowListeners: listeners.total(),
    motionListeners: motionListeners.size,
    frames: frames.size,
    timers: vi.getTimerCount(),
    configSubscriptions: subscriptions,
    sessionSubscribers: subscribers(),
  });
  cleanups.push(() => {
    isle.destroy();
    try {
      expect(leftovers()).toEqual({
        windowListeners: 0,
        motionListeners: 0,
        frames: 0,
        timers: 0,
        configSubscriptions: 0,
        sessionSubscribers: 0,
      });
    } finally {
      listeners.restore();
    }
  });

  /** One animation frame, 16ms later. */
  const frame = () => {
    vi.advanceTimersByTime(16);
    const batch = frames;
    frames = new Map();
    for (const callback of batch.values()) callback();
  };
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 400 && frames.size > 0; i += 1) frame();
  };
  /** Adds a fixed (or sticky) page widget with this viewport rectangle and computed `bottom`. */
  const pin = (
    rect: { left: number; top: number; right: number; bottom: number },
    position = 'fixed',
    bottom = 'auto',
  ) => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () =>
      ({
        ...rect,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }) as DOMRect;
    positions.set(element, position);
    bottoms.set(element, bottom);
    pinned.push({ element, position });
    return () => {
      pinned.splice(
        pinned.findIndex((item) => item.element === element),
        1,
      );
    };
  };
  const host = () => document.documentElement.querySelector('et-isle') as HTMLElement | null;
  const shadow = () => host()?.shadowRoot as ShadowRoot;
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    shadow().querySelector(selector) as T;
  const root = () => $('.r');
  const clip = (selector = '.sl') => $(selector).style.getPropertyValue('clip-path');
  /** The rectangle a clip-path inset leaves visible. */
  const clipRect = (selector = '.sl') => {
    const match = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px round ([\d.]+)px\)/.exec(
      clip(selector),
    );
    const [top = 0, right = 0, bottom = 0, left = 0, radius = 0] = (match ?? [])
      .slice(1)
      .map(Number);
    const { innerWidth: w, innerHeight: h } = window;
    return { x: left, y: top, w: w - left - right, h: h - top - bottom, right, bottom, radius };
  };
  /** A styled box's left/top/width/height. */
  const box = (selector: string) => {
    const style = $(selector).style;
    const n = (value: string) => Number.parseFloat(value);
    return { x: n(style.left), y: n(style.top), w: n(style.width), h: n(style.height) };
  };
  const pointer = (type: string, x: number, y: number, buttons = 0, target: EventTarget = window) =>
    target.dispatchEvent(
      new window.PointerEvent(type, {
        clientX: x,
        clientY: y,
        buttons,
        bubbles: true,
        composed: true,
      }),
    );
  /** Lingers on the dot until the isle opens. */
  const hoverDot = async () => {
    const { x, y } = dotPoint();
    pointer('pointermove', x, y);
    vi.advanceTimersByTime(60);
    pointer('pointermove', x, y + 1);
    vi.advanceTimersByTime(200);
    await settle();
  };
  const dotPoint = () => {
    const tint = $('.tn');
    return { x: Number.parseFloat(tint.style.left) + 5, y: Number.parseFloat(tint.style.top) + 5 };
  };
  /** The amber dot's scale (NaN when it is not scaled at all). */
  const tintScale = () => {
    const match = /scale\(([-\d.]+)\)/.exec($('.tn').style.transform);
    return match ? Number(match[1]) : Number.NaN;
  };
  /** The scale the dot should have for the shell as drawn: min(L, D) / 8, at most 1. */
  const shellScale = () => {
    if (clip() === 'inset(50%)') return 0;
    const { w, h } = clipRect();
    return Math.min(1, Math.min(w, h) / 8);
  };
  const start = async (patch: Partial<PageState> = {}) => {
    emit({ phase: 'running', ...patch });
    await settle();
  };
  return {
    session,
    emit,
    change,
    push,
    deps,
    isle,
    listeners,
    leftovers,
    elementsFromPoint,
    releaseConfig,
    setBackground: (value: string) => {
      background = value;
    },
    frame,
    settle,
    host,
    $,
    root,
    clip,
    clipRect,
    box,
    pin,
    pointer,
    hoverDot,
    dotPoint,
    tintScale,
    shellScale,
    start,
    setConfig: (patch: Partial<ConfigV1['page']>) => {
      config.page = { ...config.page, ...patch };
      configListener?.(structuredClone(config));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0)) cleanup();
  } finally {
    vi.useRealTimers();
    for (const element of document.documentElement.querySelectorAll('et-isle')) element.remove();
  }
});

describe('mounting', () => {
  it('mounts under documentElement once the session leaves idle, with forced host styles', async () => {
    const t = await setup();
    expect(t.host()).toBeNull();
    await t.start();
    const host = t.host() as HTMLElement;
    expect(host.parentElement).toBe(document.documentElement);
    expect(document.body.contains(host)).toBe(false);
    for (const [prop, value] of [
      ['position', 'fixed'],
      ['pointer-events', 'none'],
      ['z-index', '2147483647'],
      ['contain', 'layout paint style'],
    ]) {
      expect(host.style.getPropertyValue(prop as string)).toBe(value);
      expect(host.style.getPropertyPriority(prop as string)).toBe('important');
    }
    expect(host.getAttribute('data-et-theme')).toBe('light');
    expect(t.root().getAttribute('data-view')).toBe('dot');
    // The dot's dark shell is 8px (radius 4) under the 10px amber dot: see 'no dark ring'.
    expect(t.clip()).toContain('round 4px');
  });

  it('writes data-et-theme="dark" on a dark page, whatever the system theme', async () => {
    const t = await setup({ background: 'rgb(15, 17, 21)' });
    await t.start();
    expect(t.host()?.getAttribute('data-et-theme')).toBe('dark');
  });

  it('shrinks away and removes the host only once the exit has settled', async () => {
    const t = await setup();
    await t.start();
    t.emit({ phase: 'idle' });
    t.frame();
    expect(t.host()).not.toBeNull();
    await t.settle();
    expect(t.host()).toBeNull();
  });

  it('grows back from mid-exit without recreating the host', async () => {
    const t = await setup();
    await t.start();
    const host = t.host();
    t.emit({ phase: 'idle' });
    t.frame();
    t.frame();
    t.emit({ phase: 'running' });
    await t.settle();
    expect(t.host()).toBe(host);
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(t.clip()).toContain('round 4px');
  });

  it('stays away while only held paragraphs are translated, and comes once the page is', async () => {
    const t = await setup();
    await t.start({ scope: 'units' });
    expect(t.host()).toBeNull();
    t.emit({ phase: 'done' });
    await t.settle();
    expect(t.host()).toBeNull();
    t.emit({ phase: 'running', scope: undefined });
    await t.settle();
    expect(t.host()).not.toBeNull();
  });

  it('leaves when the session halts', async () => {
    const t = await setup();
    await t.start();
    t.emit({ halted: true });
    await t.settle();
    expect(t.host()).toBeNull();
  });

  it('keeps one listener per window event over many sessions, and none after destroy', async () => {
    const t = await setup();
    for (let round = 0; round < 3; round += 1) {
      await t.start();
      t.emit({ phase: 'idle' });
      t.frame();
      // Back mid-exit once per round: the same host keeps its listeners.
      t.emit({ phase: 'running' });
      await t.settle();
      t.emit({ phase: 'idle' });
      await t.settle();
      expect(t.host()).toBeNull();
      expect(t.listeners.total()).toBe(0);
    }
    await t.start();
    for (const type of WINDOW_EVENTS) expect(t.listeners.count(type)).toBe(1);
    // A start announcement still queued on the next frame is cancelled too.
    t.emit({ phase: 'idle' });
    await t.settle();
    t.emit({ phase: 'running' });
    t.isle.destroy();
    expect(t.host()).toBeNull();
    expect(t.leftovers()).toMatchObject({ windowListeners: 0, frames: 0, timers: 0 });
  });

  it('never mounts or subscribes when destroyed before the config arrives', async () => {
    const t = await setup({ holdConfig: true });
    t.emit({ phase: 'running' });
    t.isle.destroy();
    t.releaseConfig();
    await t.settle();
    expect(t.host()).toBeNull();
    expect(t.deps.watchConfig).not.toHaveBeenCalled();
    expect(t.deps.listEngines).not.toHaveBeenCalled();
  });

  it('leaves no unhandled rejection when subscribing throws (context invalidated)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const t = await setup({ watchThrows: true });
      await t.settle();
      await new Promise((resolve) => process.nextTick(resolve));
      expect(t.deps.watchConfig).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
      t.isle.destroy();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('only exists in the top frame', async () => {
    const { session } = fakeSession();
    const subscribe = vi.spyOn(session, 'subscribe');
    const isle = createIsle({
      session,
      deps: { getConfig: vi.fn(), watchConfig: vi.fn(), listEngines: vi.fn() },
      env: { win: { top: {} } as unknown as Window },
    });
    expect(subscribe).not.toHaveBeenCalled();
    isle.destroy();
  });
});

describe('dot and toolbar state', () => {
  it('shows retry with the failure count, and without a number for an engine error', async () => {
    const t = await setup();
    await t.start();
    const retry = t.$<HTMLButtonElement>('.rt');
    expect(retry.hidden).toBe(true);
    t.emit({ failed: 2 });
    expect(retry.hidden).toBe(false);
    expect(t.$('.rt b').textContent).toBe('2');
    expect(t.root().hasAttribute('data-fail')).toBe(true);
    t.emit({
      failed: 0,
      engineError: {
        kind: 'provider',
        code: 'provider/unauthorized',
        message: '',
        retryable: false,
      },
    });
    expect(retry.hidden).toBe(false);
    expect(t.$('.rt b').textContent).toBe('');
    expect(t.$('.eg').hasAttribute('data-err')).toBe(true);
    t.emit({ engineError: undefined });
    expect(retry.hidden).toBe(true);
    expect(t.root().hasAttribute('data-fail')).toBe(false);
  });

  it("names the engine error with the background's userMessage, else the generic text", async () => {
    const t = await setup();
    await t.start();
    const error = {
      kind: 'provider',
      code: 'provider/unauthorized',
      message: '',
      retryable: false,
    } as const;
    t.emit({ engineError: { ...error, userMessage: '密钥无效（后台）' } });
    expect(t.$('.eg').getAttribute('aria-label')).toBe('本页引擎：Google 翻译（密钥无效（后台））');
    t.emit({ engineError: { ...error } });
    expect(t.$('.eg').getAttribute('aria-label')).toBe(
      '本页引擎：Google 翻译（操作失败，请重试。）',
    );
  });

  it('names an engine that is no longer in the list by its id', async () => {
    const t = await setup();
    await t.start();
    t.emit({ engine: 'custom-gone' as never });
    expect(t.$('.eg').getAttribute('aria-label')).toBe('本页引擎：custom-gone（点击切换）');
  });

  it('marks translating with the spinning arc and shows the current engine', async () => {
    const t = await setup();
    await t.start();
    expect(t.root().hasAttribute('data-run')).toBe(true);
    expect(t.$('.eg').textContent).toBe('G');
    t.emit({ phase: 'done' });
    expect(t.root().hasAttribute('data-run')).toBe(false);
    t.emit({ engine: 'deepseek' });
    expect(t.$('.eg').textContent).toBe('DS');
  });

  it('shows the engine as its vendor icon, or its short label without one', async () => {
    const t = await setup({ listEngines: async () => WITH_ICONS });
    await t.start();
    expect(t.$('.eg .pf').textContent).toBe('G');
    expect(t.$('.eg').querySelector('svg')).toBeNull();
    const label = t.$('.eg').getAttribute('aria-label');
    expect(label).toBe('本页引擎：Google 翻译（点击切换）');

    t.emit({ engine: 'deepseek' });
    const icon = t.$('.eg').querySelector('svg.pi');
    expect(icon?.querySelectorAll('path')).toHaveLength(1);
    expect(icon?.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    expect(icon?.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    expect(t.$('.eg').textContent).toBe('');
    expect(t.$('.eg').getAttribute('aria-label')).toBe('本页引擎：DeepSeek（点击切换）');

    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    const row = (id: string) => t.$(`.o[data-id="${id}"]`);
    expect(row('deepseek').firstElementChild?.matches('svg.pi')).toBe(true);
    expect(row('google').firstElementChild?.matches('.pf')).toBe(true);
    expect(row('google').querySelector('.nm')?.textContent).toBe('Google 翻译');
    expect(row('openai').querySelector('.pf')?.textContent).toBe('AI');
  });

  it('keeps every button out of the tab order and the page focus where it is', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    const buttons = [...(t.host()?.shadowRoot?.querySelectorAll('button') ?? [])];
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) expect(button.getAttribute('tabindex')).toBe('-1');
    for (const type of ['pointerdown', 'mousedown']) {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      t.$('.md').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });
});

describe('hover intent', () => {
  it('opens after a slow pause on the dot, not on a fast sweep', async () => {
    const t = await setup();
    await t.start();
    const { x, y } = t.dotPoint();
    // 200ms inside the catch zone (longer than the 120ms dwell), but at 0.625px/ms:
    // only the speed keeps it shut.
    for (let i = 0; i <= 12; i += 1) {
      t.pointer('pointermove', x, y + (i % 2) * 10);
      expect(t.root().getAttribute('data-view')).toBe('dot');
      vi.advanceTimersByTime(16);
    }
    t.pointer('pointermove', x - 200, y + 300);
    vi.advanceTimersByTime(500);
    expect(t.root().getAttribute('data-view')).toBe('dot');
    await t.hoverDot();
    expect(t.root().getAttribute('data-view')).toBe('isle');
  });

  it('ignores untrusted (page-dispatched) pointer and key events', async () => {
    const t = await setup({ realTrust: true });
    await t.start();
    await t.hoverDot();
    vi.advanceTimersByTime(500);
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('dot');
    // A real tap still works; a forged Escape or outside press does not close it.
    t.$('.hit').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('isle');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    t.pointer('pointerdown', 10, 10, 1, document.body);
    t.pointer('pointerout', 10, 10);
    vi.advanceTimersByTime(500);
    expect(t.root().getAttribute('data-view')).toBe('isle');
  });

  it('does not open while a button is held', async () => {
    const t = await setup();
    await t.start();
    const { x, y } = t.dotPoint();
    t.pointer('pointermove', x, y, 1);
    vi.advanceTimersByTime(500);
    expect(t.root().getAttribute('data-view')).toBe('dot');
  });

  it('opens on a tap on the dot', async () => {
    const t = await setup();
    await t.start();
    t.$('.hit').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('isle');
  });

  it('closes when the pointer leaves, on Escape and on a click elsewhere', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    t.pointer('pointermove', 100, 100);
    vi.advanceTimersByTime(400);
    expect(t.root().getAttribute('data-view')).toBe('dot');

    await t.hoverDot();
    const esc = new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(esc);
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(esc.defaultPrevented).toBe(false);

    vi.advanceTimersByTime(400);
    await t.hoverDot();
    t.pointer('pointerdown', 10, 10, 1, document.body);
    expect(t.root().getAttribute('data-view')).toBe('dot');
  });
});

describe('selection card layering', () => {
  it('leaves Escape to an open selection card and closes once the card is gone', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    const card = document.createElement('et-selection');
    card.setAttribute('data-open', '');
    document.documentElement.append(card);
    try {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.root().getAttribute('data-view')).toBe('isle');
      // A host that is not open (no data-open) does not hold Escape back.
      card.removeAttribute('data-open');
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.root().getAttribute('data-view')).toBe('dot');
    } finally {
      card.remove();
    }
  });
  it('leaves Escape to an open palette as well', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    const palette = document.createElement('et-palette');
    palette.setAttribute('data-open', '');
    document.documentElement.append(palette);
    try {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.root().getAttribute('data-view')).toBe('isle');
      palette.removeAttribute('data-open');
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.root().getAttribute('data-view')).toBe('dot');
    } finally {
      palette.remove();
    }
  });
  it('finds an open palette inside a modal dialog too', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    const dialog = document.createElement('dialog');
    const palette = document.createElement('et-palette');
    palette.setAttribute('data-open', '');
    dialog.append(palette);
    document.body.append(dialog);
    try {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.root().getAttribute('data-view')).toBe('isle');
    } finally {
      dialog.remove();
    }
  });
  it('publishes the toolbar’s rectangle on the host once still, for the card to keep clear of', async () => {
    const rectAttr = (t: Awaited<ReturnType<typeof setup>>) =>
      t.host()?.getAttribute('data-et-rect')?.split(',').map(Number);
    for (const dock of ['right', 'left', 'bottom'] as const) {
      const t = await setup({ dock });
      t.emit({ phase: 'running' });
      t.frame();
      // Mid-animation: nothing written yet.
      expect(t.host()?.hasAttribute('data-et-rect')).toBe(false);
      await t.settle();
      // At rest as a dot it already reserves the toolbar it grows into.
      const atRest = rectAttr(t);
      await t.hoverDot();
      const { x, y, w, h } = t.clipRect();
      expect(atRest).toEqual([x, y, w, h].map(Math.round));
      expect(rectAttr(t)).toEqual(atRest);
      t.isle.destroy();
    }
  });
});

describe('actions', () => {
  it('calls the session: modes, original (stop) and retry', async () => {
    const t = await setup();
    await t.start({ failed: 1 });
    await t.hoverDot();
    const modes = t.host()?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.md') ?? [];
    modes[1]?.click();
    expect(t.session.setMode).toHaveBeenCalledWith('translation');
    expect(modes[1]?.getAttribute('aria-checked')).toBe('true');
    modes[0]?.click();
    expect(t.session.setMode).toHaveBeenLastCalledWith('bilingual');
    t.$('.rt').click();
    expect(t.session.retryFailed).toHaveBeenCalledTimes(1);
    modes[2]?.click();
    expect(t.session.stop).toHaveBeenCalledTimes(1);
  });

  it('switches the engine for later paragraphs; the current one is a no-op', async () => {
    const t = await setup();
    await t.start();
    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('list');
    expect(t.$('.eg').getAttribute('aria-expanded')).toBe('true');
    const rows = [...(t.host()?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.o') ?? [])];
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual([
      'google',
      'openai',
      'deepseek',
    ]);
    expect(rows[1]?.disabled).toBe(true);
    expect(rows[1]?.textContent).toContain('未配置密钥');
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');

    rows[0]?.click();
    expect(t.session.start).not.toHaveBeenCalled();
    expect(t.root().getAttribute('data-view')).toBe('isle');

    t.$('.eg').click();
    t.$<HTMLButtonElement>('.o[data-id="deepseek"]').click();
    expect(t.session.start).toHaveBeenCalledWith({ engine: 'deepseek' });
  });
});

describe('motion and announcements', () => {
  it('announces the start on the next frame and completion once per session', async () => {
    const t = await setup();
    t.emit({ phase: 'running' });
    const live = t.$('[aria-live="polite"]');
    expect(live.textContent).toBe('');
    t.frame();
    expect(live.textContent).toBe('开始翻译');
    t.emit({ phase: 'done' });
    expect(live.textContent).toBe('翻译完成');
    live.textContent = '';
    t.emit({ phase: 'running' });
    t.emit({ phase: 'done' });
    expect(live.textContent).toBe('');
  });

  it('adds the too-long count to the completion announcement, and nothing else changes', async () => {
    const t = await setup();
    t.emit({ phase: 'running' });
    t.frame();
    const label = t.$('.eg').getAttribute('aria-label');
    t.emit({ skipped: 2, phase: 'done' });
    expect(t.$('[aria-live="polite"]').textContent).toBe('翻译完成；2 段过长，未翻译');
    t.frame();
    expect(t.$('[aria-live="polite"]').textContent).toBe('翻译完成；2 段过长，未翻译');
    expect(t.$('.eg').getAttribute('aria-label')).toBe(label);
    expect(t.$<HTMLButtonElement>('.rt').hidden).toBe(true);
  });

  it('keeps the completion announcement when done follows running within one frame', async () => {
    const t = await setup();
    t.emit({ phase: 'running' });
    t.emit({ phase: 'done' });
    t.frame();
    expect(t.$('[aria-live="polite"]').textContent).toBe('翻译完成');
  });

  it('keeps the completion announcement when the first state seen is done', async () => {
    const t = await setup();
    t.emit({ phase: 'done' });
    t.frame();
    expect(t.$('[aria-live="polite"]').textContent).toBe('翻译完成');
  });

  it('sets will-change and hides the shadow only while moving', async () => {
    const t = await setup();
    t.emit({ phase: 'running' });
    t.frame();
    expect(t.$('.sl').style.willChange).toBe('clip-path');
    await t.settle();
    expect(t.$('.sl').style.willChange).toBe('');
    expect(t.$('.sh').style.opacity).toBe('0');
    await t.hoverDot();
    expect(t.$('.sh').style.opacity).toBe('1');
    expect(t.$('.sh').style.width).toBe('40px');
  });

  it('jumps straight to the shape with reduced motion', async () => {
    const t = await setup({ reduce: true });
    t.emit({ phase: 'running' });
    t.frame();
    expect(t.clip()).toContain('round 4px');
    expect(t.root().hasAttribute('data-rm')).toBe(true);
  });

  it('folds and regrows on the new edge when the dock setting changes', async () => {
    const t = await setup();
    await t.start();
    t.setConfig({ isleDock: 'bottom' });
    t.frame();
    expect(t.root().getAttribute('data-dock')).toBe('right');
    await t.settle();
    expect(t.root().getAttribute('data-dock')).toBe('bottom');
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(t.$('.bar').getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('grows back on its edge when the dock is changed and changed back mid-fold', async () => {
    const t = await setup();
    await t.start();
    t.setConfig({ isleDock: 'left' });
    t.frame();
    t.frame();
    t.setConfig({ isleDock: 'right' });
    await t.settle();
    expect(t.root().getAttribute('data-dock')).toBe('right');
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(t.clip()).toContain('round 4px');
  });

  it('regrows on the new edge when the dock changes during the exit and the session comes back', async () => {
    const t = await setup();
    await t.start();
    t.emit({ phase: 'idle' });
    t.frame();
    t.setConfig({ isleDock: 'left' });
    t.frame();
    t.emit({ phase: 'running' });
    await t.settle();
    expect(t.root().getAttribute('data-dock')).toBe('left');
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(t.clip()).toContain('round 4px');
  });

  it('shows up when the session restarts in the frame the exit settles, after a dock change', async () => {
    const t = await setup();
    await t.start();
    t.emit({ phase: 'idle' });
    t.frame();
    t.setConfig({ isleDock: 'left' });
    // The session is running again, but its push only comes after the exit settled.
    t.change({ phase: 'running' });
    await t.settle();
    t.push();
    await t.settle();
    expect(t.host()).not.toBeNull();
    expect(t.root().getAttribute('data-dock')).toBe('left');
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(t.clip()).toContain('round 4px');
  });

  it('stays on the edge while the window is still being resized', async () => {
    // Dragging the window wider drew a dark bar from the old dot to the new edge, and
    // narrower clipped the dot away, until the resize had been still for 100ms.
    const t = await setup();
    await t.start();
    const before = t.dotPoint();
    const shell = t.clipRect();
    const probes = t.elementsFromPoint.mock.calls.length;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const width = window.innerWidth;
    try {
      for (const delta of [300, -300]) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width + delta });
        window.dispatchEvent(new window.Event('resize'));
        t.frame();
        expect(t.dotPoint().x).toBe(before.x + delta);
        const now = t.clipRect();
        expect([now.x, now.y, now.w, now.h]).toEqual([shell.x + delta, shell.y, shell.w, shell.h]);
      }
      // Stepping around page widgets still waits for the window to settle.
      expect(t.elementsFromPoint.mock.calls.length).toBe(probes);
    } finally {
      if (descriptor) Object.defineProperty(window, 'innerWidth', descriptor);
      else delete (window as { innerWidth?: number }).innerWidth;
    }
  });

  it('measures the page again after a resize', async () => {
    const t = await setup();
    await t.start();
    const before = t.dotPoint();
    const probes = t.elementsFromPoint.mock.calls.length;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width - 200 });
    try {
      t.setBackground('rgb(15, 17, 21)');
      window.dispatchEvent(new window.Event('resize'));
      vi.advanceTimersByTime(99);
      expect(t.elementsFromPoint.mock.calls.length).toBe(probes);
      vi.advanceTimersByTime(1);
      await t.settle();
      expect(t.elementsFromPoint.mock.calls.length).toBeGreaterThan(probes);
      expect(t.dotPoint().x).toBe(before.x - 200);
      expect(t.host()?.getAttribute('data-et-theme')).toBe('dark');
    } finally {
      if (descriptor) Object.defineProperty(window, 'innerWidth', descriptor);
      else delete (window as { innerWidth?: number }).innerWidth;
    }
  });
});

describe('engine list', () => {
  it('says so when the engine list cannot be fetched', async () => {
    const t = await setup({ listEngines: async () => Promise.reject(new Error('gone')) });
    await t.start();
    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('list');
    expect(t.$('.op').textContent).toBe('暂时取不到引擎列表');
    expect(t.$('.eg').textContent).toBe('…');
  });

  it('keeps a list that arrives after the isle left, for the next session', async () => {
    let answer: (options: EngineOptions) => void = () => {};
    const t = await setup({
      listEngines: () =>
        new Promise<EngineOptions>((resolve) => {
          answer = resolve;
        }),
    });
    await t.start();
    t.emit({ phase: 'idle' });
    await t.settle();
    expect(t.host()).toBeNull();
    answer(ENGINES);
    await t.settle();
    expect(t.host()).toBeNull();
    await t.start();
    expect(t.$('.eg').textContent).toBe('G');
    expect(t.$('.op').querySelectorAll('.o')).toHaveLength(3);
  });
});

describe('rendering cost', () => {
  it('rewrites toolbar text and labels only when they change', async () => {
    const t = await setup();
    await t.start({ failed: 2 });
    const observer = new window.MutationObserver(() => {});
    observer.observe(t.host()?.shadowRoot as ShadowRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    t.emit({ translated: 7 });
    t.emit({ translated: 8 });
    expect(observer.takeRecords()).toEqual([]);
    t.emit({ failed: 3 });
    expect(t.$('.rt b').textContent).toBe('3');
    expect(t.$('.rt').getAttribute('aria-label')).toBe('重试 3 段未译出的段落');
    observer.disconnect();
  });
});

describe('dot shell', () => {
  it('hides the dark shell and its outline inside the amber dot (no dark ring)', async () => {
    for (const dock of ['right', 'left', 'bottom'] as const) {
      const t = await setup({ dock, background: 'rgb(15, 17, 21)' });
      await t.start();
      const shell = t.clipRect();
      const dot = { ...t.box('.tn'), w: 10, h: 10 };
      // Smaller than the dot, concentric, and inside it on every side.
      expect(shell.w).toBe(8);
      expect(shell.h).toBe(8);
      expect(shell.w).toBeLessThan(dot.w);
      expect(shell.x).toBeGreaterThan(dot.x);
      expect(shell.y).toBeGreaterThan(dot.y);
      expect(shell.x + shell.w).toBeLessThan(dot.x + dot.w);
      expect(shell.y + shell.h).toBeLessThan(dot.y + dot.h);
      expect(shell.x + 4).toBe(dot.x + 5);
      expect(shell.y + 4).toBe(dot.y + 5);
      // The outline (dark hosts) has not grown out yet.
      expect(t.clip('.ln')).toBe(t.clip());
      // The dot is drawn over the shell, not clipped by it.
      expect(t.$('.tn').parentElement).toBe(t.root());
      // At rest it is full size: 10px over the 8px shell.
      expect(t.tintScale()).toBe(1);
      t.isle.destroy();
    }
  });

  it('grows the amber dot in with the shell on mount', async () => {
    const t = await setup();
    t.emit({ phase: 'running' });
    t.frame();
    expect(t.tintScale()).toBeGreaterThan(0);
    expect(t.tintScale()).toBeLessThan(1);
    expect(t.tintScale()).toBeCloseTo(t.shellScale(), 1);
    await t.settle();
    expect(t.tintScale()).toBe(1);
  });

  it('shrinks the amber dot away with the shell when the session ends', async () => {
    for (const dock of ['right', 'bottom'] as const) {
      const t = await setup({ dock });
      await t.start();
      t.emit({ phase: 'idle' });
      let frames = 0;
      let smallest = 1;
      for (; frames < 200; frames += 1) {
        t.frame();
        if (!t.host()) break;
        // Concentric with the shell, scaling with it, every frame of the exit.
        expect(t.tintScale()).toBeCloseTo(t.shellScale(), 1);
        smallest = Math.min(smallest, t.tintScale());
      }
      expect(t.host()).toBeNull();
      expect(frames).toBeGreaterThan(3);
      expect(smallest).toBeLessThan(0.1);
      t.isle.destroy();
    }
  });

  it('folds the dot away before it moves to the new edge, and grows it there', async () => {
    const t = await setup();
    await t.start();
    t.setConfig({ isleDock: 'bottom' });
    let at = t.dotPoint();
    let moves = 0;
    for (let i = 0; i < 400 && t.leftovers().frames > 0; i += 1) {
      t.frame();
      const now = t.dotPoint();
      if (now.x !== at.x || now.y !== at.y) {
        // It changes edges only while folded to nothing: no jump across the page.
        moves += 1;
        expect(t.tintScale()).toBe(0);
      } else {
        expect(t.tintScale()).toBeCloseTo(t.shellScale(), 1);
      }
      at = now;
    }
    expect(moves).toBe(1);
    expect(t.root().getAttribute('data-dock')).toBe('bottom');
    expect(t.tintScale()).toBe(1);
  });
});

describe('bottom dock', () => {
  const W = 1024;
  const H = 768;

  it('sits in the bottom-right corner and grows leftward, the list right-aligned', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 16 - 5, y: H - 16 - 5 });
    await t.hoverDot();
    expect(t.root().getAttribute('data-view')).toBe('isle');
    expect(t.clipRect()).toMatchObject({ x: W - 16 - 148, w: 148, h: 40, right: 16, bottom: 16 });
    expect(t.box('.bar')).toEqual({ x: W - 16 - 148, y: H - 16 - 40, w: 148, h: 40 });
    t.emit({ failed: 1 });
    await t.settle();
    // Longer with the retry button: still anchored at the right end.
    expect(t.clipRect()).toMatchObject({ w: 186, right: 16 });
    t.$('.eg').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('list');
    const list = t.box('.ls');
    expect(list.w).toBe(240);
    expect(list.x + list.w).toBe(W - 16);
    expect(list.y + list.h).toBe(H - 16 - 40);
    expect(t.clipRect()).toMatchObject({ x: W - 16 - 240, w: 240, right: 16, bottom: 16 });
  });

  it('caps a long list at 60% of the viewport height, scrolling inside', async () => {
    const many: EngineOptions = {
      configured: 'google',
      options: Array.from({ length: 30 }, (_, i) => ({
        id: i === 0 ? 'google' : (`custom-${i}` as 'google'),
        name: `Engine ${i}`,
        short: `E${i}`,
        ready: true,
      })),
    };
    const t = await setup({ dock: 'bottom', listEngines: async () => many });
    await t.start();
    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    const list = t.box('.ls');
    expect(list.h).toBe(Math.floor(H * 0.6));
    expect(list.y).toBeGreaterThanOrEqual(16);
    expect(list.x + list.w).toBe(W - 16);
  });

  it('rises 8px above a bottom banner, and springs back down once it is gone', async () => {
    const t = await setup({ dock: 'bottom' });
    const unpin = t.pin({ left: 0, right: W, top: H - 56, bottom: H });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 21, y: H - 56 - 8 - 5 });
    unpin();
    // The next probe (about to open) finds no banner: down to the 16px floor, by spring.
    const { x, y } = t.dotPoint();
    t.pointer('pointermove', x, y);
    vi.advanceTimersByTime(60);
    t.pointer('pointermove', x, y + 1);
    vi.advanceTimersByTime(200);
    expect(t.box('.bar').y).toBe(H - 16 - 40);
    t.frame();
    const moving = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t.$('.bar').style.transform);
    expect(Number(moving?.[2])).toBeLessThan(0);
    expect(Number(moving?.[2])).toBeGreaterThan(-48);
    await t.settle();
    expect(t.$('.bar').style.transform).toBe('translate(0px,0px)');
    expect(t.clipRect()).toMatchObject({ bottom: 16, h: 40 });
    // It fell away from under the pointer that opened it: that spot still keeps it open…
    t.pointer('pointermove', x, y);
    vi.advanceTimersByTime(400);
    expect(t.root().getAttribute('data-view')).toBe('isle');
    // …until the pointer leaves for good.
    t.pointer('pointermove', 400, 300);
    vi.advanceTimersByTime(400);
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('dot');
  });

  it('ignores a bottom panel taller than 30% of the viewport', async () => {
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: 0, right: W, top: H - 240, bottom: H });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 21, y: H - 21 });
  });

  it('leaves the side docks where they are over a bottom banner', async () => {
    const t = await setup({ dock: 'right' });
    t.pin({ left: 0, right: W, top: H - 56, bottom: H });
    await t.start();
    // Home: 16px off the right edge, 60% down.
    expect(t.dotPoint()).toEqual({ x: W - 21, y: Math.round(H * 0.6) });
  });

  it('centers on a widget it steps around, the toolbar too', async () => {
    const t = await setup({ dock: 'bottom' });
    // A 52px chat bubble 20px off the right and bottom edges: middle 46px up.
    t.pin({ left: W - 72, right: W - 20, top: H - 72, bottom: H - 20 });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 72 - 8 - 5, y: H - 46 });
    await t.hoverDot();
    const bar = t.box('.bar');
    expect(bar.x + bar.w).toBe(W - 72 - 8);
    expect(bar.y + bar.h / 2).toBe(H - 46);
    expect(t.clipRect()).toMatchObject({ bottom: 46 - 20, right: 72 + 8 });
  });

  it('never centers below the 16px floor', async () => {
    const low = await setup({ dock: 'bottom' });
    // Middle 14px up: the dot stays on the 16px floor.
    low.pin({ left: W - 60, right: W - 30, top: H - 26, bottom: H - 2 });
    await low.start();
    expect(low.dotPoint()).toEqual({ x: W - 60 - 8 - 5, y: H - 21 });
  });

  it('never centers below 8px above a banner', async () => {
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: 0, right: W, top: H - 56, bottom: H });
    // Straddling the banner's top edge: middle 60px up, below the 64px floor + 5.
    t.pin({ left: W - 60, right: W - 30, top: H - 70, bottom: H - 50 });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 60 - 8 - 5, y: H - 64 - 5 });
  });

  it('does not rise over a tall sticky block, a top-sticky header or a centered bar', async () => {
    const cases: [{ left: number; top: number; right: number; bottom: number }, string, string][] =
      [
        // 200px of a bottom-sticky block 800px tall.
        [{ left: 0, right: W, top: H - 200, bottom: H + 600 }, 'sticky', '0px'],
        // `top: 0` table header, just scrolled in from below.
        [{ left: 0, right: W, top: H - 30, bottom: H }, 'sticky', 'auto'],
        // Centered, leaving the bottom-right corner free.
        [{ left: 200, right: W - 200, top: H - 56, bottom: H }, 'fixed', 'auto'],
      ];
    for (const [rect, position, bottom] of cases) {
      const t = await setup({ dock: 'bottom' });
      t.pin(rect, position, bottom);
      await t.start();
      expect(t.dotPoint()).toEqual({ x: W - 21, y: H - 21 });
      t.isle.destroy();
    }
    // A bottom-sticky bar along the bottom is still risen over.
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: 0, right: W, top: H - 48, bottom: H }, 'sticky', '0px');
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 21, y: H - 48 - 8 - 5 });
    // Each setup's listener tracker wraps the last one's: none may outlive the test body.
    t.isle.destroy();
  });

  it('only steps aside from a full-height sidebar, staying on the floor', async () => {
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: W - 60, right: W, top: 0, bottom: H });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 60 - 8 - 5, y: H - 21 });
    await t.hoverDot();
    const bar = t.box('.bar');
    expect(bar.x + bar.w).toBe(W - 68);
    expect(bar.y + bar.h).toBe(H - 16);
  });

  it('stays on the floor rather than centering high up a short viewport', async () => {
    viewportHeight(300);
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: 0, right: W, top: 300 - 56, bottom: 300 });
    // A narrow widget standing on the banner: its middle 102px up, the dot's lower
    // edge would sit 97px up, past 30% of 300.
    t.pin({ left: W - 72, right: W - 20, top: 172, bottom: 224 });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 80 - 5, y: 300 - 64 - 5 });
    await t.hoverDot();
    const bar = t.box('.bar');
    expect(bar.y + bar.h).toBe(300 - 64);
  });

  it('drops the toolbar to the floor for an engine list with no room above it', async () => {
    viewportHeight(280);
    const t = await setup({ dock: 'bottom' });
    // A 30px banner: floor 38. A widget on it, middle 80px up (dot lift 75 <= 84).
    t.pin({ left: 0, right: W, top: 250, bottom: 280 });
    t.pin({ left: W - 72, right: W - 20, top: 170, bottom: 230 });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 80 - 5, y: 200 });
    await t.hoverDot();
    expect(t.box('.bar').y).toBe(180);
    // Lined up, the toolbar would leave 164px above it: less than 3 rows need.
    t.$('.eg').click();
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('list');
    const bar = t.box('.bar');
    expect(bar.y + bar.h).toBe(280 - 38);
    const list = t.box('.ls');
    expect(list.y + list.h).toBe(bar.y);
    expect(list.y).toBeGreaterThanOrEqual(16);
    expect(t.clipRect()).toMatchObject({ bottom: 38 });
    // Back to the toolbar: lined up again.
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await t.settle();
    expect(t.root().getAttribute('data-view')).toBe('isle');
    expect(t.box('.bar').y).toBe(180);
  });

  it('keeps the toolbar centered on a chat bubble with the engine list open', async () => {
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: W - 72, right: W - 20, top: H - 72, bottom: H - 20 });
    await t.start();
    await t.hoverDot();
    t.$('.eg').click();
    await t.settle();
    const bar = t.box('.bar');
    expect(bar.y + bar.h / 2).toBe(H - 46);
    expect(t.box('.ls').y + t.box('.ls').h).toBe(bar.y);
  });

  it('keeps the catch zone around a lifted dot, not down to the bottom edge', async () => {
    const t = await setup({ dock: 'bottom' });
    // A widget 120px tall, middle 190px up: lined up, the dot rests 190px up.
    t.pin({ left: W - 72, right: W - 20, top: H - 250, bottom: H - 130 });
    await t.start();
    const dot = t.dotPoint();
    expect(dot.y).toBe(H - 190);
    // Lingering near the bottom edge, below the lifted dot: not "at the dot".
    t.pointer('pointermove', dot.x, H - 20);
    vi.advanceTimersByTime(60);
    t.pointer('pointermove', dot.x, H - 19);
    vi.advanceTimersByTime(400);
    expect(t.root().getAttribute('data-view')).toBe('dot');
    await t.hoverDot();
    expect(t.root().getAttribute('data-view')).toBe('isle');
  });

  it('centers on a widget standing on a banner', async () => {
    const t = await setup({ dock: 'bottom' });
    t.pin({ left: 0, right: W, top: H - 56, bottom: H });
    // A bubble standing on the banner.
    t.pin({ left: W - 72, right: W - 20, top: H - 56 - 20 - 52, bottom: H - 56 - 20 });
    await t.start();
    expect(t.dotPoint()).toEqual({ x: W - 80 - 5, y: H - 56 - 20 - 26 });
    await t.hoverDot();
    const bar = t.box('.bar');
    expect(bar.y + bar.h / 2).toBe(H - 56 - 20 - 26);
  });
});

describe('hover tip', () => {
  const W = 1024;
  const enter = (element: Element) =>
    element.dispatchEvent(new window.PointerEvent('pointerenter'));
  const leave = (element: Element) =>
    element.dispatchEvent(new window.PointerEvent('pointerleave'));
  const modes = (t: Awaited<ReturnType<typeof setup>>) => [
    ...(t.host()?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.md') ?? []),
  ];
  const ENGINE_LABEL = '本页引擎：Google 翻译（点击切换）';

  it('keeps the native title on the side docks and draws a tip on the bottom one', async () => {
    const t = await setup({ dock: 'right' });
    await t.start();
    await t.hoverDot();
    const [both] = modes(t);
    expect(both?.getAttribute('title')).toBe('双语对照');
    expect(t.$('.eg').getAttribute('title')).toBe(ENGINE_LABEL);
    enter(both as Element);
    vi.advanceTimersByTime(1000);
    expect(t.$('.tp').textContent).toBe('');
    t.setConfig({ isleDock: 'bottom' });
    await t.settle();
    expect(t.root().getAttribute('data-dock')).toBe('bottom');
    for (const button of [...modes(t), t.$('.eg'), t.$('.rt')]) {
      expect(button.hasAttribute('title')).toBe(false);
      expect(button.getAttribute('aria-label')).not.toBe('');
    }
  });

  it('shows after a pause, lingers, then fades out with its words before clearing', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    await t.hoverDot();
    const both = modes(t)[0] as HTMLElement;
    const tip = t.$('.tp');
    enter(both);
    vi.advanceTimersByTime(449);
    expect(tip.textContent).toBe('');
    vi.advanceTimersByTime(1);
    expect(tip.textContent).toBe('双语对照');
    await t.settle();
    expect(tip.style.opacity).toBe('1');
    // Kept inside the viewport, above the toolbar.
    const at = t.box('.tp');
    expect(at.x).toBeGreaterThanOrEqual(8);
    expect(at.y).toBeLessThan(t.box('.bar').y);

    leave(both);
    vi.advanceTimersByTime(73);
    t.frame();
    // 89ms after leaving: still there.
    expect(tip.style.opacity).toBe('1');
    expect(tip.textContent).toBe('双语对照');
    vi.advanceTimersByTime(2);
    t.frame();
    // Fading: the words stay until the tip is fully transparent (no empty capsule).
    let frames = 0;
    while (Number(tip.style.opacity) > 0) {
      expect(Number(tip.style.opacity)).toBeLessThan(1);
      expect(tip.textContent).toBe('双语对照');
      t.frame();
      frames += 1;
    }
    expect(frames).toBeGreaterThan(3);
    expect(tip.textContent).toBe('');
  });

  it('switches straight to another button while showing or within 300ms of hiding', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    await t.hoverDot();
    const both = modes(t)[0] as HTMLElement;
    const only = modes(t)[1] as HTMLElement;
    const tip = t.$('.tp');
    enter(both);
    vi.advanceTimersByTime(450);
    await t.settle();
    // Lingering on the way to the next button: content and place switch at once.
    leave(both);
    vi.advanceTimersByTime(50);
    enter(only);
    expect(tip.textContent).toBe('只看译文');
    vi.advanceTimersByTime(100);
    expect(tip.textContent).toBe('只看译文');
    expect(tip.style.opacity).toBe('1');

    // Hidden, then on another button within 300ms: no new wait.
    leave(only);
    vi.advanceTimersByTime(91);
    await t.settle();
    expect(tip.textContent).toBe('');
    enter(t.$('.eg'));
    expect(tip.textContent).toBe(ENGINE_LABEL);

    // Later than that: the pause again.
    leave(t.$('.eg'));
    vi.advanceTimersByTime(91);
    await t.settle();
    vi.advanceTimersByTime(300);
    enter(both);
    expect(tip.textContent).toBe('');
    vi.advanceTimersByTime(450);
    expect(tip.textContent).toBe('双语对照');
  });

  it('fades out with its words when the engine list opens, and stays away there', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    await t.hoverDot();
    const tip = t.$('.tp');
    enter(t.$('.eg'));
    vi.advanceTimersByTime(450);
    await t.settle();
    expect(tip.textContent).toBe(ENGINE_LABEL);
    t.$('.eg').click();
    t.frame();
    expect(t.root().getAttribute('data-view')).toBe('list');
    expect(Number(tip.style.opacity)).toBeLessThan(1);
    expect(Number(tip.style.opacity)).toBeGreaterThan(0);
    expect(tip.textContent).toBe(ENGINE_LABEL);
    await t.settle();
    expect(tip.textContent).toBe('');
    enter(modes(t)[0] as HTMLElement);
    vi.advanceTimersByTime(1000);
    expect(tip.textContent).toBe('');
  });

  /** Hovers the dot until the isle opens, without letting the growth run. */
  const openMoving = (t: Awaited<ReturnType<typeof setup>>) => {
    const { x, y } = t.dotPoint();
    t.pointer('pointermove', x, y);
    vi.advanceTimersByTime(60);
    t.pointer('pointermove', x, y + 1);
    vi.advanceTimersByTime(200);
    expect(t.root().getAttribute('data-view')).toBe('isle');
  };

  it('reads no layout while the shape moves: a tip asked for then shows once still', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    const left = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
    const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get');
    const reads = [
      left,
      top,
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
    ];
    const count = () => reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    try {
      openMoving(t);
      t.frame();
      const tip = t.$('.tp');
      enter(modes(t)[0] as HTMLElement);
      vi.advanceTimersByTime(450);
      // Mid-growth: nothing measured, nothing shown yet.
      expect(count()).toBe(0);
      expect(tip.textContent).toBe('');
      t.frame();
      expect(count()).toBe(0);
      await t.settle();
      expect(tip.textContent).toBe('双语对照');
      expect(tip.style.opacity).toBe('1');
      expect(t.box('.tp').y).toBeLessThan(t.box('.bar').y);
      // Still: the buttons' places come from the cache.
      const buttonReads = () => left.mock.calls.length + top.mock.calls.length;
      const before = buttonReads();
      leave(modes(t)[0] as HTMLElement);
      enter(modes(t)[1] as HTMLElement);
      expect(tip.textContent).toBe('只看译文');
      enter(t.$('.eg'));
      expect(tip.textContent).toBe(ENGINE_LABEL);
      expect(buttonReads()).toBe(before);
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it('follows its button to where the retry button pushes it, once still', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    const both = modes(t)[0] as HTMLElement;
    // Stand-in layout: the first mode button sits 3px into the toolbar, 28px wide.
    Object.defineProperty(both, 'offsetLeft', { configurable: true, get: () => 3 });
    Object.defineProperty(both, 'offsetWidth', { configurable: true, get: () => 28 });
    await t.hoverDot();
    const tip = t.$('.tp');
    enter(both);
    vi.advanceTimersByTime(450);
    await t.settle();
    const before = t.box('.tp').x;
    expect(before).toBe(W - 16 - 148 + 3 + 14);
    // The retry button shows: the toolbar grows 38px leftward and the button with it.
    t.emit({ failed: 1 });
    t.frame();
    expect(t.box('.tp').x).toBe(before);
    await t.settle();
    expect(t.box('.tp').x).toBe(before - 38);
    expect(tip.textContent).toBe('双语对照');
    expect(tip.style.opacity).toBe('1');
  });

  it('updates the words of a showing tip when its label changes', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start({ failed: 1 });
    await t.hoverDot();
    const tip = t.$('.tp');
    enter(t.$('.rt'));
    vi.advanceTimersByTime(450);
    await t.settle();
    expect(tip.textContent).toBe('重试 1 段未译出的段落');
    t.emit({ failed: 2 });
    expect(tip.textContent).toBe('重试 2 段未译出的段落');
    await t.settle();
    expect(tip.style.opacity).toBe('1');
    // Its button goes away: the tip fades out with it.
    t.emit({ failed: 0 });
    await t.settle();
    expect(tip.textContent).toBe('');
  });

  for (const phase of ['waiting', 'lingering', 'fading'] as const) {
    for (const action of ['destroy', 'exit', 'dock'] as const) {
      it(`leaves no frame or timer behind: ${action} while the tip is ${phase}`, async () => {
        const t = await setup({ dock: 'bottom' });
        await t.start();
        await t.hoverDot();
        const both = modes(t)[0] as HTMLElement;
        enter(both);
        if (phase === 'waiting') {
          vi.advanceTimersByTime(200);
          expect(t.leftovers().timers).toBeGreaterThan(0);
        } else {
          vi.advanceTimersByTime(450);
          await t.settle();
          leave(both);
          vi.advanceTimersByTime(phase === 'lingering' ? 40 : 91);
          if (phase === 'fading') {
            t.frame();
            expect(t.leftovers().frames).toBeGreaterThan(0);
          } else {
            expect(t.leftovers().timers).toBeGreaterThan(0);
          }
        }
        if (action === 'destroy') {
          t.isle.destroy();
          expect(t.host()).toBeNull();
        } else if (action === 'exit') {
          t.emit({ phase: 'idle' });
          await t.settle();
          expect(t.host()).toBeNull();
        } else {
          t.setConfig({ isleDock: 'right' });
          await t.settle();
          expect(t.root().getAttribute('data-dock')).toBe('right');
          expect(t.$('.tp').textContent).toBe('');
          // A tip that was waiting never shows up late.
          vi.advanceTimersByTime(1000);
          expect(t.$('.tp').textContent).toBe('');
        }
        expect(t.leftovers()).toMatchObject({ frames: 0, timers: 0 });
      });
    }
  }

  it('fades out the same way when the isle folds up', async () => {
    const t = await setup({ dock: 'bottom' });
    await t.start();
    await t.hoverDot();
    const tip = t.$('.tp');
    enter(t.$('.eg'));
    vi.advanceTimersByTime(450);
    await t.settle();
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    t.frame();
    expect(t.root().getAttribute('data-view')).toBe('dot');
    expect(Number(tip.style.opacity)).toBeLessThan(1);
    expect(tip.textContent).toBe(ENGINE_LABEL);
    await t.settle();
    expect(tip.textContent).toBe('');
  });
});

/** Switches the getMessage stub to the en copy (vitest.setup puts zh_CN back each test). */
async function switchToEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

describe('English copy', () => {
  it('announces the too-long count in the singular and finishes with a note', async () => {
    await switchToEnglish();
    const t = await setup();
    t.emit({ phase: 'running' });
    t.frame();
    t.emit({ skipped: 1, phase: 'done' });
    t.frame();
    expect(t.$('[aria-live="polite"]').textContent).toBe(
      'Translation finished. 1 paragraph too long to translate',
    );
  });

  it('picks the singular or plural retry label by the failure count', async () => {
    await switchToEnglish();
    const t = await setup();
    await t.start();
    const retry = t.$('.rt');
    t.emit({ failed: 1 });
    expect(retry.getAttribute('aria-label')).toBe("Retry 1 paragraph that wasn't translated");
    t.emit({ failed: 3 });
    expect(retry.getAttribute('aria-label')).toBe("Retry 3 paragraphs that weren't translated");
    t.emit({ failed: 0, engineError: undefined });
  });

  it('says plainly "Retry" for an engine error, and names the engine in English', async () => {
    await switchToEnglish();
    const t = await setup();
    await t.start();
    const error = {
      kind: 'provider',
      code: 'provider/unauthorized',
      message: '',
      retryable: false,
    } as const;
    t.emit({ engineError: { ...error, userMessage: 'Invalid key' } });
    expect(t.$('.rt').getAttribute('aria-label')).toBe('Retry');
    expect(t.$('.eg').getAttribute('aria-label')).toBe(
      'Engine for this page: Google 翻译 (Invalid key)',
    );
    t.emit({ engineError: undefined });
    expect(t.$('.eg').getAttribute('aria-label')).toBe(
      'Engine for this page: Google 翻译 (click to switch)',
    );
  });

  it('draws icons for the modes in English, with full labels', async () => {
    await switchToEnglish();
    const t = await setup();
    await t.start();
    const buttons = [...t.root().querySelectorAll<HTMLElement>('.md')];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.textContent).toBe('');
    }
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Bilingual',
      'Translation only',
      'Show original (ends this translation)',
    ]);
  });

  it('keeps the Chinese characters on the mode buttons in Chinese', async () => {
    const t = await setup();
    await t.start();
    const buttons = [...t.root().querySelectorAll<HTMLElement>('.md')];
    expect(buttons.map((button) => button.textContent)).toEqual(['双', '译', '原']);
    expect(buttons.some((button) => button.querySelector('svg'))).toBe(false);
  });

  it('sets lang on the host to the interface language, not the page', async () => {
    document.documentElement.setAttribute('lang', 'fr');
    try {
      await switchToEnglish();
      const t = await setup();
      await t.start();
      expect(t.host()?.getAttribute('lang')).toBe('en');
    } finally {
      document.documentElement.removeAttribute('lang');
    }
  });

  it('sets the Chinese interface language on the host in Chinese', async () => {
    document.documentElement.setAttribute('lang', 'fr');
    try {
      const t = await setup();
      await t.start();
      expect(t.host()?.getAttribute('lang')).toBe('zh-CN');
    } finally {
      document.documentElement.removeAttribute('lang');
    }
  });
});
