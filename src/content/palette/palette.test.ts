// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigV1, IsleDock } from '@/lib/config/types';
import type { EngineOptions, PageState } from '@/lib/messaging/protocol';
import { IDLE_PAGE_STATE, type PageActions, type PaletteRuntime } from '../runtime-contract';
import { createPalette } from './palette';

const ENGINES: EngineOptions = {
  configured: 'google',
  options: [
    { id: 'google', name: 'Google 翻译', short: 'G', ready: true },
    { id: 'openai', name: 'OpenAI', short: 'AI', ready: false, note: '未配置密钥' },
    { id: 'deepseek', name: 'DeepSeek', short: 'DS', ready: true },
  ],
};

interface SetupOptions {
  state?: Partial<PageState>;
  dock?: IsleDock;
  reduced?: boolean;
  engines?: () => Promise<EngineOptions>;
}

let palette: PaletteRuntime | undefined;
let t = 0;
let frames: (() => void)[] = [];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs animation frames (16 ms apart) until none is asked for. */
function settle() {
  for (let i = 0; i < 500 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    t += 16;
    for (const frame of due) frame();
  }
}

async function setup(options: SetupOptions = {}) {
  let state: PageState = { ...IDLE_PAGE_STATE, ...options.state };
  const answer = async () => state;
  const page: PageActions = {
    getState: vi.fn(answer),
    start: vi.fn(answer),
    stop: vi.fn(answer),
    toggle: vi.fn(answer),
    setMode: vi.fn(answer),
    retryFailed: vi.fn(answer),
  };
  const send = vi.fn(options.engines ?? (async () => ENGINES));
  palette = createPalette({
    deps: {
      getConfig: async () => ({ page: { isleDock: options.dock ?? 'right' } }) as ConfigV1,
      send: send as never,
      page,
    },
    env: {
      win: window,
      shadowMode: 'open',
      isTrusted: () => true,
      now: () => t,
      raf: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelRaf: () => {},
      matchMedia: (query) => ({ matches: !!options.reduced && query.includes('reduced') }),
      elementsFromPoint: () => [],
    },
  });
  const host = () => document.querySelector('et-palette') as HTMLElement | null;
  const root = () => host()?.shadowRoot as ShadowRoot;
  const input = () => root().querySelector('.in') as HTMLInputElement;
  const titles = () => [...root().querySelectorAll('.o .tt')].map((el) => el.textContent);
  const selected = () => root().querySelector('[aria-selected="true"] .tt')?.textContent;
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    input().dispatchEvent(event);
    return event;
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  };
  const open = async () => {
    palette?.toggle();
    await flush();
    await flush();
  };
  return {
    page,
    send,
    host,
    root,
    input,
    titles,
    selected,
    key,
    type,
    open,
    setState: (next: Partial<PageState>) => {
      state = { ...state, ...next };
    },
  };
}

beforeEach(() => {
  t = 1000;
  frames = [];
  document.body.innerHTML = '<input id="field"><button id="other">x</button>';
  (document.getElementById('field') as HTMLElement).focus();
});

afterEach(() => {
  palette?.dispose();
  palette = undefined;
  for (const element of document.querySelectorAll('et-palette')) element.remove();
});

describe('opening', () => {
  it('mounts its host, moves the focus into the input and lists the commands', async () => {
    const p = await setup();
    await p.open();
    expect(p.host()?.hasAttribute('data-open')).toBe(true);
    expect(p.host()?.getAttribute('lang')).toBe('zh-CN');
    expect(p.root().activeElement).toBe(p.input());
    expect(p.input().placeholder).toBe('输入指令');
    expect(p.titles()).toEqual(['翻译此页', '用…翻译此页']);
    // The first row is highlighted and announced to the combobox.
    expect(p.selected()).toBe('翻译此页');
    expect(p.input().getAttribute('aria-activedescendant')).toBe('o0');
    expect(p.root().querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('指令台');
  });

  it('the shortcut pressed again closes it', async () => {
    const p = await setup();
    await p.open();
    palette?.toggle();
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement?.id).toBe('field');
  });

  it('does not open in full screen', async () => {
    const p = await setup();
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.body,
      configurable: true,
    });
    try {
      await p.open();
      expect(p.host()).toBeNull();
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    }
  });

  it('joins an open modal dialog (outside it everything is inert)', async () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const matches = dialog.matches.bind(dialog);
    dialog.matches = ((selector: string) =>
      selector === ':modal' || matches(selector)) as typeof dialog.matches;
    const p = await setup();
    await p.open();
    expect(p.host()?.parentElement).toBe(dialog);
  });

  it('slides the shape out of the dock edge and fades the content in', async () => {
    const p = await setup({ dock: 'right' });
    await p.open();
    const content = p.root().querySelector('.cn') as HTMLElement;
    const shape = p.root().querySelector('.sl') as HTMLElement;
    expect(p.root().querySelector('.r')?.hasAttribute('data-anim')).toBe(true);
    frames.shift()?.();
    expect(Number(content.style.opacity)).toBeLessThan(1);
    settle();
    expect(content.style.opacity).toBe('1');
    expect(shape.style.clipPath).toMatch(/^inset\(.* round 14px\)$/);
    expect(p.root().querySelector('.r')?.hasAttribute('data-anim')).toBe(false);
    palette?.toggle();
    settle();
    expect(p.host()).toBeNull();
  });

  it('with reduced motion, skips the slide', async () => {
    const p = await setup({ reduced: true });
    await p.open();
    expect(frames).toHaveLength(0);
    expect((p.root().querySelector('.cn') as HTMLElement).style.opacity).toBe('1');
    expect(p.root().querySelector('.r')?.hasAttribute('data-rm')).toBe(true);
  });
});

describe('keys', () => {
  it('keeps keys and text input from the page (they stop at the shadow root)', async () => {
    const p = await setup();
    await p.open();
    const seen = vi.fn();
    const types = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'];
    for (const type of types) document.addEventListener(type, seen);
    try {
      p.key('s');
      p.key('Escape');
      for (const type of ['keypress', 'keyup']) {
        p.input().dispatchEvent(
          new KeyboardEvent(type, { key: 's', bubbles: true, composed: true }),
        );
      }
      for (const type of ['beforeinput', 'input']) {
        p.input().dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      }
      expect(seen).not.toHaveBeenCalled();
    } finally {
      for (const type of types) document.removeEventListener(type, seen);
    }
  });

  it('Enter runs the highlighted (first) command and hands the focus back', async () => {
    const p = await setup();
    await p.open();
    p.key('Enter');
    expect(p.page.start).toHaveBeenCalledOnce();
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement?.id).toBe('field');
  });

  it('↓ then Enter runs the next command; the highlight wraps', async () => {
    const p = await setup({ state: { phase: 'running' } });
    await p.open();
    expect(p.titles()).toEqual(['显示原文（结束本次翻译）', '只看译文', '切换翻译服务…']);
    p.key('ArrowDown');
    expect(p.selected()).toBe('只看译文');
    p.key('ArrowUp');
    p.key('ArrowUp');
    expect(p.selected()).toBe('切换翻译服务…');
    p.key('ArrowDown');
    p.key('ArrowDown');
    p.key('Enter');
    expect(p.page.setMode).toHaveBeenCalledWith('translation');
  });

  it('leaves Enter and the arrows to an input method while it composes', async () => {
    const p = await setup();
    await p.open();
    const enter = p.key('Enter', { isComposing: true });
    p.key('ArrowDown', { keyCode: 229 });
    expect(enter.defaultPrevented).toBe(false);
    expect(p.page.start).not.toHaveBeenCalled();
    expect(p.selected()).toBe('翻译此页');
  });

  it('Tab stays inside', async () => {
    const p = await setup();
    await p.open();
    expect(p.key('Tab').defaultPrevented).toBe(true);
    expect(p.key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
  });

  it('filters as you type: a leading slash only filters, no match says so', async () => {
    const p = await setup({ state: { phase: 'running' } });
    await p.open();
    p.type('只看');
    expect(p.titles()).toEqual(['只看译文']);
    expect(p.root().querySelector('.hl')?.textContent).toBe('只看');
    p.type('/engine');
    expect(p.titles()).toEqual(['切换翻译服务…']);
    p.type('zzz');
    expect(p.titles()).toEqual([]);
    expect(p.root().querySelector('.em')?.textContent).toBe('没有匹配的指令');
    expect(p.root().querySelector('[role="status"]')?.textContent).toBe('没有匹配的指令');
    p.key('Enter');
    expect(p.page.setMode).not.toHaveBeenCalled();
  });

  it('Escape closes and hands the focus and the selection back', async () => {
    document.body.innerHTML = '<p id="p">Some words</p><input id="field">';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p') as HTMLElement);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const p = await setup();
    await p.open();
    document.getSelection()?.removeAllRanges();
    p.key('Escape');
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
    expect(document.getSelection()?.toString()).toBe('Some words');
  });
});

describe('engine list', () => {
  async function openEngines(state: Partial<PageState> = { phase: 'running', engine: 'google' }) {
    const p = await setup({ state });
    await p.open();
    p.type('engine');
    p.key('Enter');
    await flush();
    return p;
  }

  it('shows the engines in place of the commands, the current one checked', async () => {
    const p = await openEngines();
    expect(p.host()?.hasAttribute('data-open')).toBe(true);
    expect(p.titles()).toEqual(['Google 翻译', 'OpenAI', 'DeepSeek']);
    expect(p.root().querySelector('.cp')?.textContent).toBe('切换翻译服务');
    expect(p.root().querySelector('[aria-current="true"] .tt')?.textContent).toBe('Google 翻译');
    expect(p.root().querySelector('[aria-disabled="true"] .nt')?.textContent).toBe('未配置密钥');
    // The not-ready engine is skipped.
    p.key('ArrowDown');
    expect(p.selected()).toBe('DeepSeek');
    p.key('Enter');
    expect(p.page.start).toHaveBeenCalledWith({ engine: 'deepseek' });
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
  });

  it('picking the engine already in use changes nothing', async () => {
    const p = await openEngines();
    p.key('Enter');
    expect(p.page.start).not.toHaveBeenCalled();
  });

  it('when idle, starts the page with the picked engine; the chip is the plain title', async () => {
    const p = await openEngines({});
    expect(p.root().querySelector('.cp')?.textContent).toBe('翻译此页');
    p.key('Enter');
    expect(p.page.start).toHaveBeenCalledWith({ engine: 'google' });
  });

  it('Escape, ← or Backspace in an empty input go back to the commands, not out', async () => {
    for (const back of ['Escape', 'ArrowLeft', 'Backspace']) {
      const p = await openEngines();
      p.key(back);
      expect(p.host()?.hasAttribute('data-open')).toBe(true);
      expect(p.titles()[0]).toBe('显示原文（结束本次翻译）');
      expect(p.root().querySelector('.cp')?.hasAttribute('hidden')).toBe(true);
      palette?.dispose();
    }
  });

  it('says so when the engines cannot be read', async () => {
    const p = await setup({
      state: { phase: 'running' },
      engines: () => Promise.reject(new Error('gone')),
    });
    await p.open();
    p.type('engine');
    p.key('Enter');
    await flush();
    expect(p.titles()).toEqual([]);
    expect(p.root().querySelector('.em')?.textContent).toBe('暂时取不到引擎列表');
  });
});

describe('the page around it', () => {
  it('closes on a press elsewhere, leaving the focus to the page', async () => {
    const p = await setup();
    await p.open();
    document
      .getElementById('other')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement?.id).not.toBe('field');
  });

  it('takes the focus back once, and gives up when it is taken twice within 100 ms', async () => {
    const p = await setup();
    await p.open();
    (document.getElementById('other') as HTMLElement).focus();
    expect(p.root().activeElement).toBe(p.input());
    expect(p.host()?.hasAttribute('data-open')).toBe(true);
    t += 50;
    (document.getElementById('other') as HTMLElement).focus();
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
  });

  it('a halted session shows only the reload strip and hands the focus back at once', async () => {
    const p = await setup({ state: { phase: 'running', halted: true } });
    await p.open();
    expect(p.root().querySelector('.r')?.hasAttribute('data-halted')).toBe(true);
    expect(p.root().querySelector('.hs')?.textContent).toBe(
      '无法连接页面，请刷新网页后重试。Chrome 商店等受限页面无法使用。',
    );
    expect(p.input().hidden).toBe(true);
    expect(p.titles()).toEqual([]);
    expect(document.activeElement?.id).toBe('field');
    // No focus reclaim; Escape heard from the page closes it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
  });
});

describe('review round 1', () => {
  it('R1: after a key closes it, that key’s keyup does not reach the page', async () => {
    for (const [k, code] of [
      ['Escape', 'Escape'],
      ['Enter', 'Enter'],
    ] as const) {
      const p = await setup();
      await p.open();
      const seen = vi.fn();
      document.addEventListener('keyup', seen);
      try {
        p.key(k, { code });
        expect(p.host()?.hasAttribute('data-open')).toBe(false);
        const field = document.getElementById('field') as HTMLElement;
        expect(document.activeElement).toBe(field);
        const other = new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true });
        field.dispatchEvent(other);
        expect(seen).toHaveBeenCalledOnce();
        const up = new KeyboardEvent('keyup', { key: k, code, bubbles: true, cancelable: true });
        field.dispatchEvent(up);
        expect(up.defaultPrevented).toBe(true);
        expect(seen).toHaveBeenCalledOnce();
        // Only once.
        field.dispatchEvent(new KeyboardEvent('keyup', { key: k, code, bubbles: true }));
        expect(seen).toHaveBeenCalledTimes(2);
      } finally {
        document.removeEventListener('keyup', seen);
        palette?.dispose();
      }
    }
  });

  it('R1: the keyup guard goes away after about a second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = await setup();
      palette?.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      p.key('Escape', { code: 'Escape' });
      await vi.advanceTimersByTimeAsync(1100);
      const seen = vi.fn();
      document.addEventListener('keyup', seen);
      document.body.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
      document.removeEventListener('keyup', seen);
      expect(seen).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('R2: a page focus trap that takes the focus back at once makes it give up', async () => {
    const other = document.getElementById('other') as HTMLElement;
    const trap = (event: Event) => {
      // A focus trap: whatever else takes the focus, it goes back to the page's button.
      if (event.target !== other) other.focus();
    };
    document.addEventListener('focusin', trap, true);
    try {
      const p = await setup();
      await p.open();
      expect(p.host()?.hasAttribute('data-open')).toBe(false);
      expect(document.activeElement).toBe(other);
    } finally {
      document.removeEventListener('focusin', trap, true);
    }
  });

  it('R3: closes with the modal dialog it joined', async () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const matches = dialog.matches.bind(dialog);
    dialog.matches = ((selector: string) =>
      selector === ':modal' || matches(selector)) as typeof dialog.matches;
    const p = await setup();
    await p.open();
    expect(p.host()?.parentElement).toBe(dialog);
    dialog.dispatchEvent(new Event('close'));
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
  });

  it('R3: a host the page removed counts as closed: the shortcut opens a new one', async () => {
    const p = await setup();
    await p.open();
    p.host()?.remove();
    await p.open();
    expect(p.host()?.hasAttribute('data-open')).toBe(true);
    expect(p.root().activeElement).toBe(p.input());
  });

  it('R3: closes when the page goes full screen', async () => {
    const p = await setup();
    await p.open();
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.body,
      configurable: true,
    });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(p.host()?.hasAttribute('data-open')).toBe(false);
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    }
  });

  it('R4: the host keeps display:block against the page’s translation-only rule', async () => {
    const p = await setup();
    await p.open();
    expect(p.host()?.style.getPropertyValue('display')).toBe('block');
    expect(p.host()?.style.getPropertyPriority('display')).toBe('important');
  });

  it('S1: closes when the focus moves into a frame', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const p = await setup();
    await p.open();
    frame.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    expect(p.host()?.hasAttribute('data-open')).toBe(false);
  });

  it('S2: clipboard and composition events stop at the shadow root too', async () => {
    const p = await setup();
    await p.open();
    const seen = vi.fn();
    const types = [
      'paste',
      'copy',
      'cut',
      'compositionstart',
      'compositionupdate',
      'compositionend',
    ];
    for (const type of types) document.addEventListener(type, seen);
    try {
      for (const type of types) {
        p.input().dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      }
      expect(seen).not.toHaveBeenCalled();
    } finally {
      for (const type of types) document.removeEventListener(type, seen);
    }
  });
});

describe('review round 2', () => {
  it('closes when the input cannot take the focus at all', async () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {});
    try {
      const p = await setup();
      await p.open();
      expect(p.host()?.hasAttribute('data-open')).toBe(false);
      expect(document.activeElement?.id).toBe('field');
    } finally {
      focus.mockRestore();
    }
  });

  it('a first focus that did not take is retried once, and then it stays open', async () => {
    const real = HTMLInputElement.prototype.focus;
    let calls = 0;
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(function (
      this: HTMLInputElement,
      options?: FocusOptions,
    ) {
      calls += 1;
      if (calls > 1) real.call(this, options);
    });
    try {
      const p = await setup();
      await p.open();
      expect(calls).toBe(2);
      expect(p.host()?.hasAttribute('data-open')).toBe(true);
      expect(p.root().activeElement).toBe(p.input());
    } finally {
      focus.mockRestore();
    }
  });

  it('a host hidden by the page (checkVisibility false) counts as closed: the shortcut reopens', async () => {
    const p = await setup();
    await p.open();
    const first = p.host() as HTMLElement & { checkVisibility?: () => boolean };
    first.checkVisibility = () => false;
    await p.open();
    expect(p.host()).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(p.host()?.hasAttribute('data-open')).toBe(true);
    expect(p.root().activeElement).toBe(p.input());
  });

  it('while the keyup guard waits, auto-repeats of that key do not reach the page', async () => {
    const p = await setup();
    await p.open();
    p.key('Escape', { code: 'Escape' });
    const field = document.getElementById('field') as HTMLElement;
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    try {
      const repeat = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(repeat);
      expect(repeat.defaultPrevented).toBe(true);
      expect(seen).not.toHaveBeenCalled();
      // Another key, or a fresh press of the same one, goes through.
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', repeat: true, bubbles: true }),
      );
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
      expect(seen).toHaveBeenCalledTimes(2);
      // Gone with the guard: after the keyup, repeats pass too.
      field.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
      field.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          repeat: true,
          bubbles: true,
        }),
      );
      expect(seen).toHaveBeenCalledTimes(3);
    } finally {
      document.removeEventListener('keydown', seen);
    }
  });
});
