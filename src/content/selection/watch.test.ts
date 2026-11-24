// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import type { SelectionSnapshot } from '../runtime-contract';
import {
  CHANGE_DEBOUNCE_MS,
  CLEAR_GRACE_MS,
  createSelectionWatch,
  estimateLength,
  isOwnNode,
  KEY_DELAY_MS,
  MAX_LENGTH,
  POINTER_DELAY_MS,
  readSelection,
} from './watch';

const RECT = { left: 10, top: 20, right: 110, bottom: 36, width: 100, height: 16 };

function rectOf(): DOMRect {
  return { ...RECT, x: RECT.left, y: RECT.top, toJSON: () => ({}) } as DOMRect;
}

/** happy-dom has no layout: every range gets one fixed box. */
function stubGeometry() {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  const original = { rects: proto.getClientRects, box: proto.getBoundingClientRect };
  proto.getClientRects = () => [rectOf()];
  proto.getBoundingClientRect = () => rectOf();
  return () => {
    proto.getClientRects = original.rects;
    proto.getBoundingClientRect = original.box;
  };
}

interface Options {
  config?: (config: ConfigV1) => void;
  getConfig?: () => Promise<ConfigV1>;
  /** Subscribing throws (the extension was reloaded: its context is invalidated). */
  watchThrows?: boolean;
}

function setup(options: Options = {}) {
  const config = createDefaultConfig('zh-CN');
  options.config?.(config);
  let listener: ((config: ConfigV1) => void) | undefined;
  const getConfig = vi.fn(options.getConfig ?? (async () => config));
  const unwatch = vi.fn();
  const watchConfig = vi.fn((callback: (config: ConfigV1) => void) => {
    if (options.watchThrows) {
      throw new Error(
        "Failed to read the 'onChanged' property from 'Object': Extension context invalidated.",
      );
    }
    listener = callback;
    return unwatch;
  });
  const onCandidate = vi.fn<(selection: SelectionSnapshot) => void>();
  const onClear = vi.fn();
  const watch = createSelectionWatch({
    doc: document,
    getConfig,
    watchConfig,
    onCandidate,
    onClear,
  });
  watch.start();
  return {
    watch,
    config,
    getConfig,
    watchConfig,
    unwatch,
    onCandidate,
    onClear,
    pushConfig: (next: ConfigV1) => listener?.(next),
  };
}

function select(node: Node, start = 0, end?: number) {
  const range = document.createRange();
  if (node.nodeType === 3) {
    range.setStart(node, start);
    range.setEnd(node, end ?? (node as Text).data.length);
  } else {
    range.selectNodeContents(node);
  }
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function para(text: string, parent: Element = document.body): Text {
  const p = document.createElement('p');
  p.textContent = text;
  parent.append(p);
  return p.firstChild as Text;
}

const pointer = (type: string) => document.dispatchEvent(new Event(type, { bubbles: true }));
async function release(delay = POINTER_DELAY_MS) {
  pointer('pointerup');
  await vi.advanceTimersByTimeAsync(delay);
}

let restore: () => void;
let active: ReturnType<typeof setup> | undefined;
const start = (options?: Options) => {
  active = setup(options);
  return active;
};

beforeEach(() => {
  vi.useFakeTimers();
  restore = stubGeometry();
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

afterEach(() => {
  active?.watch.stop();
  active = undefined;
  restore();
  vi.useRealTimers();
});

describe('when a check runs', () => {
  it('checks 100ms after the pointer is released', async () => {
    const t = start();
    select(para('Hello world, again'));
    pointer('pointerup');
    await vi.advanceTimersByTimeAsync(POINTER_DELAY_MS - 1);
    expect(t.onCandidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('checks 50ms after a key release', async () => {
    const t = start();
    select(para('Hello world, again'));
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('debounces selectionchange', async () => {
    const t = start();
    select(para('Hello world, again'));
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS - 1);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS - 1);
    expect(t.onCandidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('does nothing while the pointer is held, then checks on release', async () => {
    const t = start();
    select(para('Hello world, again'));
    pointer('pointerdown');
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS + 50);
    expect(t.onCandidate).not.toHaveBeenCalled();
    expect(t.getConfig).not.toHaveBeenCalled();
    await release();
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('a window blur releases a stuck press', async () => {
    const t = start();
    select(para('Hello world, again'));
    pointer('pointerdown');
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('stop removes the listeners and timers', async () => {
    const t = start();
    select(para('Hello world, again'));
    pointer('pointerup');
    t.watch.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.onCandidate).not.toHaveBeenCalled();
    pointer('pointerup');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.onCandidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stopping', () => {
  it('stop does not throw when unsubscribing throws (extension reloaded), and resets', async () => {
    const t = start();
    select(para('Hello world, again'));
    await release();
    expect(t.watchConfig).toHaveBeenCalledOnce();
    t.unwatch.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => t.watch.stop()).not.toThrow();
    expect(t.unwatch).toHaveBeenCalledOnce();
    // Started again, it subscribes afresh instead of keeping the old cache.
    t.unwatch.mockReset();
    t.watch.start();
    await release();
    expect(t.watchConfig).toHaveBeenCalledTimes(2);
  });
});

describe('the candidate', () => {
  it('carries the normalized text, the rectangle and the bottom right of the last character', async () => {
    const t = start();
    select(para('  Hello \n  world, again '));
    await release();
    expect(t.onCandidate).toHaveBeenCalledWith({
      source: 'Hello world, again',
      rect: { left: 10, top: 20, right: 110, bottom: 36 },
      anchor: { x: 110, y: 36 },
      range: expect.any(Range),
      pointer: expect.anything(),
    });
    // A copy of the range: the runtime follows and remembers it.
    const range = t.onCandidate.mock.calls[0]?.[0].range;
    expect(range?.toString()).toBe('  Hello \n  world, again ');
    expect(range).not.toBe(document.getSelection()?.getRangeAt(0));
  });

  it('carries where the pointer was released; a keyboard selection carries none', async () => {
    const t = start();
    const text = para('Hello world, again');
    select(text);
    document.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 108, clientY: 30 }),
    );
    await vi.advanceTimersByTimeAsync(POINTER_DELAY_MS);
    expect(t.onCandidate.mock.calls.at(-1)?.[0].pointer).toEqual({ x: 108, y: 30 });
    // Shift+arrows: the old release says nothing about this selection.
    select(para('Another selection here'));
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.onCandidate).toHaveBeenCalledTimes(2);
    expect(t.onCandidate.mock.calls.at(-1)?.[0].pointer).toBeUndefined();
  });

  it('anchors the dot at the pointer when the range only knows a shadow host', async () => {
    const t = start();
    const p = document.createElement('p');
    p.append('before ');
    const host = document.createElement('span');
    host.attachShadow({ mode: 'open' }).append('inside a shadow root');
    p.append(host, ' after');
    document.body.append(p);
    // What getRangeAt gives for a selection in the shadow root, without getComposedRanges.
    const range = document.createRange();
    range.setStart(p, 1);
    range.setEnd(p, 2);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const rendered = vi
      .spyOn(selection as Selection, 'toString')
      .mockReturnValue('inside a shadow root');
    document.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 321, clientY: 123 }),
    );
    await vi.advanceTimersByTimeAsync(POINTER_DELAY_MS);
    rendered.mockRestore();
    expect(t.onCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'inside a shadow root', anchor: { x: 321, y: 123 } }),
    );
  });

  it('the same selection again does not repeat the dot', async () => {
    const t = start();
    select(para('Hello world, again'));
    await release();
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('a different selection shows the dot again', async () => {
    const t = start();
    const text = para('Hello world, again');
    select(text, 0, 5);
    await release();
    select(text, 6, 11);
    await release();
    expect(t.onCandidate.mock.calls.map(([s]) => s.source)).toEqual(['Hello', 'world']);
  });
});

describe('cheap filters', () => {
  it('needs at least 2 characters after normalization, and at most 2000', async () => {
    const t = start();
    select(para('  a  '));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    select(para('ab'));
    await release();
    expect(t.onCandidate).toHaveBeenCalledTimes(1);
    select(para('x'.repeat(MAX_LENGTH)));
    await release();
    expect(t.onCandidate).toHaveBeenCalledTimes(2);
    select(para('y'.repeat(MAX_LENGTH + 1)));
    await release();
    expect(t.onCandidate).toHaveBeenCalledTimes(2);
  });

  it('measures the length after whitespace collapses', async () => {
    const t = start();
    select(para(`word${' '.repeat(2500)}word`));
    await release();
    expect(t.onCandidate).toHaveBeenCalledOnce();
    expect(t.onCandidate.mock.calls[0]?.[0].source).toBe('word word');
  });

  it('gives up on a huge selection without reading its text', async () => {
    const t = start();
    const text = para('z'.repeat(MAX_LENGTH * 5));
    select(text);
    const selection = document.getSelection() as Selection;
    const read = vi.spyOn(selection, 'toString');
    await release();
    expect(read).not.toHaveBeenCalled();
    expect(t.onCandidate).not.toHaveBeenCalled();
    expect(t.getConfig).not.toHaveBeenCalled();
  });

  it('skips a selection inside a focused input or textarea', async () => {
    const t = start();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    select(para('Hello world, again'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    input.remove();
    const area = document.createElement('textarea');
    document.body.append(area);
    area.focus();
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  it('skips a selection that starts in contenteditable content', async () => {
    const t = start();
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(editable);
    select(para('Hello world, again', editable));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  /** Chrome's view of a selection in an open shadow root: a range around the host. */
  function shadowEditable(focus: boolean) {
    const p = document.createElement('p');
    p.append('before ');
    const host = document.createElement('span');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    editable.textContent = 'typing inside a shadow root';
    host.attachShadow({ mode: 'open' }).append(editable);
    p.append(host, ' after');
    document.body.append(p);
    if (focus) editable.focus();
    const range = document.createRange();
    range.setStart(p, 1);
    range.setEnd(p, 2);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    const rendered = vi.spyOn(selection, 'toString').mockReturnValue('typing inside');
    return { selection, editable, rendered };
  }

  it('skips a selection in a focused contenteditable inside an open shadow root', async () => {
    const t = start();
    const { rendered } = shadowEditable(true);
    await release();
    rendered.mockRestore();
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  it('skips a selection whose composed start is in shadow contenteditable content', async () => {
    const t = start();
    const { selection, editable, rendered } = shadowEditable(false);
    const text = editable.firstChild as Text;
    Object.defineProperty(selection, 'getComposedRanges', {
      configurable: true,
      value: () => {
        const inner = document.createRange();
        inner.setStart(text, 0);
        inner.setEnd(text, 13);
        return [inner];
      },
    });
    await release();
    rendered.mockRestore();
    delete (selection as unknown as Record<string, unknown>).getComposedRanges;
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  it.each(['et-isle', 'et-selection'])('skips a selection inside our %s host', async (tag) => {
    const t = start();
    const host = document.createElement(tag);
    document.documentElement.append(host);
    select(para('Hello world, again', host));
    await release();
    host.remove();
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  it('skips a selection with no box (nothing to anchor the dot to)', async () => {
    const t = start();
    const proto = Range.prototype as unknown as Record<string, unknown>;
    proto.getClientRects = () => [];
    proto.getBoundingClientRect = () => ({ width: 0, height: 0 });
    select(para('Hello world, again'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
  });

  it('prechecks the script against the target language', async () => {
    const t = start({ config: (c) => (c.language.target = 'ja') });
    select(para('これは日本語のテストです'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    select(para('This is an English test'));
    await release();
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('leaves Han text to the detector for a Chinese target (no early skip)', async () => {
    const t = start();
    select(para('这是一段中文文字'));
    await release();
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });
});

describe('the setting', () => {
  it('reads the config once, on the first non-empty selection, then caches it', async () => {
    const t = start();
    pointer('pointerup');
    await vi.advanceTimersByTimeAsync(POINTER_DELAY_MS);
    expect(t.getConfig).not.toHaveBeenCalled();
    select(para('Hello world, again'));
    await release();
    expect(t.getConfig).toHaveBeenCalledOnce();
    expect(t.watchConfig).toHaveBeenCalledOnce();
    select(para('Another selection here'));
    await release();
    expect(t.getConfig).toHaveBeenCalledOnce();
    expect(t.onCandidate).toHaveBeenCalledTimes(2);
  });

  it('shows nothing while showDot is off, and follows a change through the watch', async () => {
    const t = start({ config: (c) => (c.selection.showDot = false) });
    select(para('Hello world, again'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    t.pushConfig({ ...t.config, selection: { showDot: true } });
    select(para('Hello world, again'));
    await release();
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('removes a shown dot at once when the setting is turned off', async () => {
    const t = start();
    select(para('Hello world, again'));
    await release();
    t.pushConfig({ ...t.config, selection: { showDot: false } });
    expect(t.onClear).toHaveBeenCalledOnce();
  });

  it('retries the read after a failure', async () => {
    let attempt = 0;
    const t = start({
      getConfig: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('storage unavailable');
        return createDefaultConfig('zh-CN');
      },
    });
    select(para('Hello world, again'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    expect(t.unwatch).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('keeps a setting pushed while the first read was out over the older read', async () => {
    let answer!: (config: ConfigV1) => void;
    const t = start({
      getConfig: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    select(para('Hello world, again'));
    await release();
    expect(t.getConfig).toHaveBeenCalledOnce();
    t.pushConfig({ ...t.config, selection: { showDot: false } });
    // The read started before the change: it still says the dot is on.
    answer(t.config);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onCandidate).not.toHaveBeenCalled();
    select(para('Another selection here'));
    await release();
    expect(t.onCandidate).not.toHaveBeenCalled();
    expect(t.getConfig).toHaveBeenCalledOnce();
  });

  it('after a failed read, subscribes and reads again instead of keeping a pushed setting', async () => {
    let attempt = 0;
    let fail!: (error: Error) => void;
    const t = start({
      getConfig: () => {
        attempt += 1;
        if (attempt > 1) return Promise.resolve(createDefaultConfig('zh-CN'));
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    });
    select(para('Hello world, again'));
    await release();
    t.pushConfig({ ...t.config, selection: { showDot: false } });
    fail(new Error('storage unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.unwatch).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(t.watchConfig).toHaveBeenCalledTimes(2);
    expect(t.getConfig).toHaveBeenCalledTimes(2);
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });
});

describe('an invalidated extension context', () => {
  it('recovers when the read fails and unsubscribing throws too', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let attempt = 0;
      const t = start({
        getConfig: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('Extension context invalidated.');
          return createDefaultConfig('zh-CN');
        },
      });
      t.unwatch.mockImplementationOnce(() => {
        throw new Error('Extension context invalidated.');
      });
      select(para('Hello world, again'));
      await release();
      await vi.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => process.nextTick(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(t.onCandidate).not.toHaveBeenCalled();
      expect(t.unwatch).toHaveBeenCalledOnce();
      // The cache was reset: the next check subscribes and reads again.
      document.dispatchEvent(new Event('keyup'));
      await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
      expect(t.watchConfig).toHaveBeenCalledTimes(2);
      expect(t.getConfig).toHaveBeenCalledTimes(2);
      expect(t.onCandidate).toHaveBeenCalledOnce();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('ends the check quietly when subscribing throws, and tries again next time', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const t = start({ watchThrows: true });
      select(para('Hello world, again'));
      await release();
      await vi.advanceTimersByTimeAsync(0);
      // Let a rejection that nobody handled reach the process.
      await new Promise((resolve) => process.nextTick(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(t.onCandidate).not.toHaveBeenCalled();
      // Nothing is cached: the next selection subscribes again.
      document.dispatchEvent(new Event('keyup'));
      await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
      await new Promise((resolve) => process.nextTick(resolve));
      expect(t.watchConfig).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('the grace period', () => {
  it('removes the dot 160ms after the selection vanishes', async () => {
    const t = start();
    select(para('Hello world, again'));
    await release();
    document.getSelection()?.removeAllRanges();
    await release();
    expect(t.onClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLEAR_GRACE_MS - 1);
    expect(t.onClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.onClear).toHaveBeenCalledOnce();
  });

  it('keeps the dot when the selection comes back within the grace period', async () => {
    const t = start();
    const text = para('Hello world, again');
    select(text);
    await release();
    document.getSelection()?.removeAllRanges();
    await release();
    select(text);
    await release();
    await vi.advanceTimersByTimeAsync(CLEAR_GRACE_MS * 2);
    expect(t.onClear).not.toHaveBeenCalled();
    expect(t.onCandidate).toHaveBeenCalledOnce();
  });

  it('also removes the dot when the selection stops qualifying', async () => {
    const t = start();
    select(para('Hello world, again'));
    await release();
    select(para('x'));
    await release(POINTER_DELAY_MS + CLEAR_GRACE_MS);
    expect(t.onClear).toHaveBeenCalledOnce();
  });

  it('sets no timer for a selection that never had a dot', async () => {
    const t = start();
    document.dispatchEvent(new Event('keyup'));
    await vi.advanceTimersByTimeAsync(KEY_DELAY_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.onClear).not.toHaveBeenCalled();
  });
});

describe('estimateLength and readSelection', () => {
  it('counts a single text node exactly and several nodes by their text', () => {
    const one = para('0123456789');
    const range = document.createRange();
    range.setStart(one, 2);
    range.setEnd(one, 7);
    expect(estimateLength(document, range, 100)).toBe(5);

    document.body.innerHTML = '<p>aaaa<b>bbbb</b>cccc</p><p>dddd</p>';
    const [p1, p2] = document.querySelectorAll('p');
    const multi = document.createRange();
    multi.setStart(p1?.firstChild as Text, 2);
    multi.setEnd(p2?.firstChild as Text, 3);
    // 2 + 4 + 4 + 3
    expect(estimateLength(document, multi, 100)).toBe(13);
  });

  it('stops counting once past the limit', () => {
    document.body.innerHTML = `<p>${'a'.repeat(50)}</p><p>${'b'.repeat(50)}</p><p>${'c'.repeat(50)}</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(estimateLength(document, range, 60)).toBeGreaterThan(60);
    expect(estimateLength(document, range, 60)).toBeLessThan(150);
  });

  it('readSelection returns the snapshot with no length limit, and undefined when empty', () => {
    expect(readSelection(document)).toBeUndefined();
    select(para('a'));
    expect(readSelection(document)?.source).toBe('a');
    select(para('y'.repeat(MAX_LENGTH + 5)));
    expect(readSelection(document)?.source).toHaveLength(MAX_LENGTH + 5);
  });
});

describe('isOwnNode', () => {
  it.each(['et-isle', 'et-selection', 'et-palette', 'et-pick'])(
    'counts nodes inside <%s>',
    (tag) => {
      const host = document.createElement(tag);
      const inner = document.createElement('span');
      host.append(inner);
      document.body.append(host);
      expect(isOwnNode(inner)).toBe(true);
      expect(isOwnNode(host)).toBe(true);
      host.remove();
    },
  );

  it('does not count the page’s own nodes', () => {
    expect(isOwnNode(document.body)).toBe(false);
    expect(isOwnNode(null)).toBe(false);
  });
});
