// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StyleReader } from '../dom-rules';
import type { RegionKind } from '../runtime-contract';
import { saveFocus } from './focus';
import { createPicker, type Picker, STEADY_MS } from './pick';

/** Block by tag (as discovery's tests do), or the element's own inline `display`. */
const readStyle: StyleReader = (el) => {
  const own = (el as HTMLElement).style?.display;
  if (own) return { display: own };
  return { display: /^(DIV|BODY|HTML)$/.test(el.tagName) ? 'block' : 'inline' };
};

const PAGE = `
  <input id="field">
  <main id="main">
    <section id="sec">
      <p id="a">First <span id="s">paragraph</span> text.</p>
      <p id="b">Second paragraph text.</p>
    </section>
    <p id="c">Outside the section.</p>
    <nav id="nav"><span id="navtext">Home</span></nav>
    <div id="hidden" aria-hidden="true"><p id="h">Hidden text.</p></div>
    <div id="edit" contenteditable="true"><p id="e">Draft.</p></div>
  </main>
  <a id="link" href="#elsewhere">A link</a>`;

const el = (id: string) => document.getElementById(id) as HTMLElement;

let picker: Picker | undefined;
let frames: (() => void)[] = [];
/** What `elementsFromPoint` answers, by "x,y". */
let hits: Record<string, Element[]> = {};
let trusted = true;
/** Where the host belongs (`parent()`): <html>, or a test's modal dialog. */
let parentEl: Element = document.documentElement;

function runFrames() {
  const due = frames;
  frames = [];
  for (const frame of due) frame();
}

function setup(options: { region?: (kind: RegionKind, root: Element) => Promise<boolean> } = {}) {
  const region = vi.fn(options.region ?? (async () => true));
  const guardKeyUp = vi.fn();
  picker = createPicker({
    env: {
      win: window,
      shadowMode: 'open',
      isTrusted: () => trusted,
      raf: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelRaf: () => {},
      matchMedia: () => ({ matches: false }),
      elementsFromPoint: (x, y) => hits[`${x},${y}`] ?? [],
      createReadStyle: () => readStyle,
    },
    parent: () => parentEl,
    guardKeyUp,
    region,
  });
  const host = () => document.querySelector('et-pick') as HTMLElement | null;
  const root = () => host()?.shadowRoot as ShadowRoot;
  const box = () => root().querySelector('.bx') as HTMLElement;
  const hint = () => root().querySelector('.hn') as HTMLElement;
  /** The highlighted block: the element whose box the highlight was drawn around. */
  const start = (kind?: RegionKind) => {
    picker?.start(saveFocus(document), kind);
  };
  const key = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key,
      code: key,
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };
  const pointer = (type: string, target: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const move = (x: number, y: number) => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
  };
  /** Whether a pick is running: its hint bar shows. */
  const picking = () => !!host() && !hint().hidden;
  const live = () => root().querySelector('[aria-live]') as HTMLElement;
  return { region, guardKeyUp, host, root, box, hint, start, key, pointer, move, picking, live };
}

const CENTER = () => `${window.innerWidth / 2},${window.innerHeight / 2}`;

/** Every element's box, for the highlight: a 100×20 box at (10, 50). */
function layout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 50,
    left: 10,
    top: 50,
    right: 110,
    bottom: 70,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect);
}

/** happy-dom has no layout: the n-th element in document order sits at top n×10. */
const topOf = (element: Element) => [...document.querySelectorAll('*')].indexOf(element) * 10;
function rects() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = topOf(this);
    return {
      x: 0,
      y: top,
      left: 0,
      top,
      right: 100,
      bottom: top + 5,
      width: 100,
      height: 5,
    } as DOMRect;
  });
}

/** Which element the box is drawn around (4px outside it), read from the page. */
function picked(): Element | undefined {
  const box = document.querySelector('et-pick')?.shadowRoot?.querySelector('.bx') as
    | HTMLElement
    | undefined;
  if (!box || box.hidden) return undefined;
  const top = Number.parseFloat(box.style.top) + 4;
  return [...document.querySelectorAll('*')].find((element) => topOf(element) === top);
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  el('field').focus();
  frames = [];
  hits = {};
  trusted = true;
  parentEl = document.documentElement;
  rects();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  picker?.dispose();
  picker = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const host of document.querySelectorAll('et-pick')) host.remove();
});

describe('the candidate block', () => {
  it('starts from the viewport’s centre: the nearest block around the element there', () => {
    hits[CENTER()] = [el('s'), el('a'), el('sec'), document.body];
    const p = setup();
    p.start();
    expect(picked()).toBe(el('a'));
    expect(p.box().hidden).toBe(false);
    expect(p.hint().hidden).toBe(false);
    expect(p.hint().getAttribute('role')).toBe('status');
    expect(p.hint().textContent).toBe('↑扩大·↓缩小·Enter确认·Esc取消');
  });

  it('with nothing at the centre, tries 40%, 60%, 30% and 70% of the height in turn', () => {
    const x = window.innerWidth / 2;
    hits[`${x},${window.innerHeight * 0.6}`] = [el('b')];
    hits[`${x},${window.innerHeight * 0.3}`] = [el('c')];
    const p = setup();
    p.start();
    expect(picked()).toBe(el('b'));
    p.key('Escape');
    delete hits[`${x},${window.innerHeight * 0.6}`];
    p.start();
    expect(picked()).toBe(el('c'));
  });

  it('looks past our own hosts, and a translation stands for its paragraph', () => {
    const palette = document.createElement('et-palette');
    const isle = document.createElement('et-isle');
    document.documentElement.append(palette, isle);
    const tr = document.createElement('et-tr');
    tr.textContent = '第二段';
    el('b').append(tr);
    hits[CENTER()] = [palette, isle, tr, el('b')];
    const p = setup();
    p.start();
    expect(picked()).toBe(el('b'));
    palette.remove();
    isle.remove();
  });

  it.each([
    ['the body', () => [document.body]],
    ['the root element', () => [document.documentElement]],
    ['a navigation', () => [el('navtext'), el('nav')]],
    ['an aria-hidden area', () => [el('h')]],
    ['editable content', () => [el('e')]],
    ['a text field', () => [el('field')]],
    ['nothing at all', () => []],
  ] as [string, () => Element[]][])('offers nothing over %s', (_name, at) => {
    hits[CENTER()] = at();
    const p = setup();
    p.start();
    expect(picked()).toBeUndefined();
    expect(p.box().hidden).toBe(true);
    // Enter then does nothing.
    p.key('Enter');
    expect(p.region).not.toHaveBeenCalled();
  });
});

describe('expanding and shrinking', () => {
  it('↑ takes the parent block, up to a child of the body; ↓ goes back; ↓ on the first is nothing', () => {
    hits[CENTER()] = [el('s')];
    const p = setup();
    p.start();
    expect(picked()).toBe(el('a'));
    p.key('ArrowDown');
    expect(picked()).toBe(el('a'));
    p.key('ArrowUp');
    expect(picked()).toBe(el('sec'));
    p.key('ArrowUp');
    expect(picked()).toBe(el('main'));
    // <main> is the body's child: no further.
    p.key('ArrowUp');
    expect(picked()).toBe(el('main'));
    p.key('ArrowDown');
    expect(picked()).toBe(el('sec'));
    p.key('ArrowDown');
    expect(picked()).toBe(el('a'));
  });

  it('moving the pointer to another block starts over from there (the stack is cleared)', () => {
    hits[CENTER()] = [el('a')];
    hits['5,5'] = [el('c')];
    const p = setup();
    p.start();
    p.key('ArrowUp');
    expect(picked()).toBe(el('sec'));
    p.move(5, 5);
    vi.advanceTimersByTime(STEADY_MS);
    expect(picked()).toBe(el('c'));
    p.key('ArrowDown');
    expect(picked()).toBe(el('c'));
  });

  it('the pointer moving within the block it picked keeps the expansion', () => {
    hits['1,1'] = [el('s')];
    hits['2,2'] = [el('a')];
    const p = setup();
    p.start();
    p.move(1, 1);
    vi.advanceTimersByTime(STEADY_MS);
    expect(picked()).toBe(el('a'));
    p.key('ArrowUp');
    p.move(2, 2);
    vi.advanceTimersByTime(STEADY_MS);
    expect(picked()).toBe(el('sec'));
  });
});

describe('the pointer’s steady window', () => {
  it('switches only once the pointer has rested for 80 ms on the new block', () => {
    hits[CENTER()] = [el('a')];
    hits['5,5'] = [el('b')];
    const p = setup();
    p.start();
    p.move(5, 5);
    vi.advanceTimersByTime(STEADY_MS - 1);
    expect(picked()).toBe(el('a'));
    vi.advanceTimersByTime(1);
    expect(picked()).toBe(el('b'));
  });

  it('checks again when the window ends: another block there by then, no switch', () => {
    hits[CENTER()] = [el('a')];
    hits['5,5'] = [el('b')];
    const p = setup();
    p.start();
    p.move(5, 5);
    // The page changed under the pointer meanwhile.
    hits['5,5'] = [el('c')];
    vi.advanceTimersByTime(STEADY_MS);
    expect(picked()).toBe(el('a'));
  });

  it('ignores a forged pointer move', () => {
    hits[CENTER()] = [el('a')];
    hits['5,5'] = [el('b')];
    const p = setup();
    p.start();
    trusted = false;
    p.move(5, 5);
    vi.advanceTimersByTime(STEADY_MS);
    expect(picked()).toBe(el('a'));
  });
});

describe('the size limit', () => {
  const big = () => {
    const long = document.createElement('p');
    long.id = 'long';
    long.textContent = 'word '.repeat(4001);
    el('sec').append(long);
    return long;
  };

  it('over 20 000 characters: coral, a hint to translate the page, Enter and a click do nothing', () => {
    big();
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    expect(p.box().hasAttribute('data-over')).toBe(false);
    p.key('ArrowUp');
    expect(picked()).toBe(el('sec'));
    expect(p.box().hasAttribute('data-over')).toBe(true);
    expect(p.hint().textContent).toBe('区域太大，可直接翻译此页·↓缩小·Esc取消');
    expect(p.hint().querySelector('.dt')).not.toBeNull();
    p.key('Enter');
    p.pointer('click', el('c'));
    expect(p.region).not.toHaveBeenCalled();
    expect(p.picking()).toBe(true);
    // ↓ still shrinks, and the smaller block can be confirmed.
    p.key('ArrowDown');
    expect(p.box().hasAttribute('data-over')).toBe(false);
    expect(p.hint().textContent).toBe('↑扩大·↓缩小·Enter确认·Esc取消');
    p.key('Enter');
    expect(p.region).toHaveBeenCalledWith('translate', el('a'));
  });

  it('does not apply to an area left untranslated: a whole sidebar may be excluded', () => {
    big();
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start('exclude');
    p.key('ArrowUp');
    expect(picked()).toBe(el('sec'));
    expect(p.box().hasAttribute('data-over')).toBe(false);
    expect(p.hint().textContent).toBe('↑扩大·↓缩小·Enter确认·Esc取消');
    p.key('Enter');
    expect(p.region).toHaveBeenCalledWith('exclude', el('sec'));
  });

  it('counts the source text only, not our translations', () => {
    const tr = document.createElement('et-tr');
    tr.textContent = '译'.repeat(25_000);
    el('a').append(tr);
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    expect(p.box().hasAttribute('data-over')).toBe(false);
  });
});

describe('keys and pointer presses while picking', () => {
  it('keys never reach the page; unmodified ones lose their default (no scrolling, no caret)', () => {
    hits[CENTER()] = [el('a')];
    const seen: string[] = [];
    document.addEventListener('keydown', (event) => seen.push(event.key), true);
    document.addEventListener('keyup', (event) => seen.push(`up:${event.key}`), true);
    const p = setup();
    p.start();
    const up = p.key('ArrowUp');
    expect(up.defaultPrevented).toBe(true);
    const space = p.key(' ');
    expect(space.defaultPrevented).toBe(true);
    // The browser's own shortcuts keep working: stopped for the page, not prevented.
    const copy = p.key('c', { metaKey: true });
    expect(copy.defaultPrevented).toBe(false);
    const tab = p.key('Tab', { ctrlKey: true });
    expect(tab.defaultPrevented).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    expect(seen).toEqual([]);
    // Ctrl+↑ is not ↑.
    p.key('ArrowUp', { ctrlKey: true });
    expect(picked()).toBe(el('sec'));
  });

  it('a held Enter or Escape does nothing; held arrows keep moving', () => {
    hits[CENTER()] = [el('s')];
    const p = setup();
    p.start();
    p.key('Enter', { repeat: true });
    p.key('Escape', { repeat: true });
    expect(p.region).not.toHaveBeenCalled();
    expect(p.picking()).toBe(true);
    p.key('ArrowUp', { repeat: true });
    p.key('ArrowUp', { repeat: true });
    expect(picked()).toBe(el('main'));
    p.key('ArrowDown', { repeat: true });
    expect(picked()).toBe(el('sec'));
  });

  it('forged keys and presses are left alone', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    trusted = false;
    const enter = p.key('Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(p.region).not.toHaveBeenCalled();
    const click = p.pointer('click', el('link'));
    expect(click.defaultPrevented).toBe(false);
    p.pointer('contextmenu', el('c'));
    expect(p.picking()).toBe(true);
  });

  it('presses are swallowed: a link is not followed, the page hears nothing', () => {
    hits[CENTER()] = [el('a')];
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'mouseover', 'auxclick']) {
      document.addEventListener(type, () => seen.push(type), true);
    }
    const p = setup();
    p.start();
    for (const type of [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'pointerover',
      'mouseover',
      'dblclick',
    ]) {
      expect(p.pointer(type, el('link')).defaultPrevented).toBe(true);
    }
    expect(p.pointer('auxclick', el('link'), { button: 1 }).defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
  });

  it('a right press (the context menu) cancels, and no menu opens', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const menu = p.pointer('contextmenu', el('c'), { button: 2 });
    expect(menu.defaultPrevented).toBe(true);
    expect(p.picking()).toBe(false);
    expect(p.region).not.toHaveBeenCalled();
    expect(p.hint().hidden).toBe(true);
  });

  it('a left click inside the box confirms it, as Enter does (↑ grown included)', () => {
    hits[CENTER()] = [el('a')];
    hits['3,3'] = [el('s')];
    const p = setup();
    p.start();
    p.key('ArrowUp');
    const click = p.pointer('click', el('s'), { clientX: 3, clientY: 3 });
    expect(click.defaultPrevented).toBe(true);
    expect(p.region).toHaveBeenCalledWith('translate', el('sec'));
    expect(p.picking()).toBe(false);
  });

  it('a click on another block, with no hover before it, confirms the block clicked', () => {
    hits[CENTER()] = [el('a')];
    hits['7,7'] = [el('c')];
    const p = setup();
    p.start();
    p.key('ArrowUp');
    p.pointer('click', el('c'), { clientX: 7, clientY: 7 });
    expect(p.region).toHaveBeenCalledWith('translate', el('c'));
  });

  it('a click where there is no block is swallowed and confirms nothing', () => {
    hits[CENTER()] = [el('a')];
    hits['8,8'] = [el('navtext')];
    const p = setup();
    p.start();
    expect(p.pointer('click', el('link'), { clientX: 0, clientY: 0 }).defaultPrevented).toBe(true);
    expect(p.pointer('click', el('navtext'), { clientX: 8, clientY: 8 }).defaultPrevented).toBe(
      true,
    );
    expect(p.region).not.toHaveBeenCalled();
    expect(p.picking()).toBe(true);
    expect(picked()).toBe(el('a'));
  });

  it('the second click of a double click is swallowed, never a confirmation', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const second = p.pointer('click', el('a'), { clientX: 512, clientY: 384, detail: 2 });
    expect(second.defaultPrevented).toBe(true);
    expect(p.region).not.toHaveBeenCalled();
    expect(p.picking()).toBe(true);
  });

  it('hover events stop here too, entering and leaving included', () => {
    hits[CENTER()] = [el('a')];
    const seen: string[] = [];
    const types = [
      'pointerenter',
      'mouseenter',
      'pointerout',
      'mouseout',
      'pointerleave',
      'mouseleave',
    ];
    for (const type of types) el('link').addEventListener(type, () => seen.push(type));
    const p = setup();
    p.start();
    for (const type of types) {
      const event = new MouseEvent(type, { bubbles: type.endsWith('out'), cancelable: true });
      el('link').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it('after a click confirmed, the rest of the double click never reaches the page', () => {
    hits[CENTER()] = [el('a')];
    hits['3,3'] = [el('s')];
    const seen: string[] = [];
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];
    for (const type of types) document.addEventListener(type, () => seen.push(type));
    const p = setup();
    p.start();
    p.pointer('click', el('s'), { clientX: 3, clientY: 3 });
    expect(p.region).toHaveBeenCalledOnce();
    // As Chrome sends them: the second press's pointer and mouse events may say detail 0.
    for (const type of types) {
      const detail = type === 'click' || type === 'dblclick' ? 2 : 0;
      expect(p.pointer(type, el('link'), { detail }).defaultPrevented).toBe(true);
    }
    expect(seen).toEqual([]);
    // Half a second later the page has its presses back.
    vi.advanceTimersByTime(500);
    expect(p.pointer('click', el('link')).defaultPrevented).toBe(false);
    expect(seen).toEqual(['click']);
  });

  it('a new pick within the half second takes clicks at once', () => {
    hits[CENTER()] = [el('a')];
    hits['3,3'] = [el('s')];
    hits['7,7'] = [el('c')];
    const p = setup();
    p.start();
    p.pointer('click', el('s'), { clientX: 3, clientY: 3 });
    p.start();
    expect(p.pointer('click', el('c'), { clientX: 7, clientY: 7 }).defaultPrevented).toBe(true);
    expect(p.region).toHaveBeenLastCalledWith('translate', el('c'));
  });

  it('the half second after a pick never swallows presses on our own interface', () => {
    hits[CENTER()] = [el('a')];
    hits['3,3'] = [el('s')];
    const palette = document.createElement('et-palette');
    document.documentElement.append(palette);
    const p = setup();
    p.start();
    p.pointer('click', el('s'), { clientX: 3, clientY: 3 });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      expect(p.pointer(type, palette).defaultPrevented).toBe(false);
    }
    palette.remove();
  });

  it('after a right click cancelled, the rest of that press never reaches the page', () => {
    hits[CENTER()] = [el('a')];
    const seen: string[] = [];
    for (const type of ['pointerup', 'mouseup', 'auxclick']) {
      document.addEventListener(type, () => seen.push(type));
    }
    const p = setup();
    p.start();
    p.pointer('contextmenu', el('c'), { button: 2 });
    for (const type of ['pointerup', 'mouseup', 'auxclick']) {
      expect(p.pointer(type, el('c'), { button: 2 }).defaultPrevented).toBe(true);
    }
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(500);
    p.pointer('mouseup', el('c'), { button: 2 });
    expect(seen).toEqual(['mouseup']);
  });

  it('a click right after moving to another block confirms that block', () => {
    hits[CENTER()] = [el('a')];
    hits['5,5'] = [el('c')];
    const p = setup();
    p.start();
    p.move(5, 5);
    p.pointer('click', el('c'), { clientX: 5, clientY: 5 });
    expect(p.region).toHaveBeenCalledWith('translate', el('c'));
  });
});

describe('focus and ending', () => {
  it('holds the focus inside its host while picking and hands it back on Escape', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    expect(document.activeElement).toBe(p.host());
    expect(p.root().activeElement?.getAttribute('tabindex')).toBe('-1');
    p.key('Escape');
    expect(p.picking()).toBe(false);
    expect(document.activeElement).toBe(el('field'));
    // Its keyup is kept from the page (the palette's guard).
    expect(p.guardKeyUp).toHaveBeenCalledWith('Escape');
    expect(p.box().hidden).toBe(true);
    expect(p.hint().hidden).toBe(true);
  });

  it('Enter translates the block, hands the focus back, then says so for a few seconds', async () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const live = p.live();
    p.key('Enter');
    expect(p.region).toHaveBeenCalledWith('translate', el('a'));
    expect(p.guardKeyUp).toHaveBeenCalledWith('Enter');
    expect(document.activeElement).toBe(el('field'));
    await vi.waitFor(() => expect(live.textContent).toBe('已翻译该区域'));
    vi.advanceTimersByTime(5000);
    expect(live.textContent).toBe('');
    p.key('Escape');
    p.start();
    p.key('Enter');
    await vi.waitFor(() => expect(live.textContent).toBe('已翻译该区域'));
    // The host stays so the announcement is not cut off; the next pick reuses it.
    expect(p.host()?.isConnected).toBe(true);
    const host = p.host();
    p.start();
    expect(p.host()).toBe(host);
    expect(live.textContent).toBe('');
  });

  it('an area left untranslated: named so while picking, and says so once confirmed', async () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start('exclude');
    expect(p.root().activeElement?.getAttribute('aria-label')).toBe('选择不翻译的区域');
    p.key('Enter');
    expect(p.region).toHaveBeenCalledWith('exclude', el('a'));
    await vi.waitFor(() => expect(p.live().textContent).toBe('该区域不再翻译'));
    // The next pick is a translating one again, unless told otherwise.
    p.start();
    expect(p.root().activeElement?.getAttribute('aria-label')).toBe('选择要翻译的区域');
    p.key('Enter');
    expect(p.region).toHaveBeenLastCalledWith('translate', el('a'));
    await vi.waitFor(() => expect(p.live().textContent).toBe('已翻译该区域'));
  });

  it('says nothing when nothing was added to the translation', async () => {
    hits[CENTER()] = [el('a')];
    const p = setup({ region: async () => false });
    p.start();
    p.key('Enter');
    await vi.waitFor(() => expect(p.region).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    expect(p.live().textContent).toBe('');
  });

  it.each([
    ['a new pick started', (p: ReturnType<typeof setup>) => p.start()],
    ['the pick was cancelled from outside (closed)', () => picker?.cancel()],
  ])('drops a late answer once %s', async (_name, after) => {
    hits[CENTER()] = [el('a')];
    let answer: (added: boolean) => void = () => {};
    const p = setup({
      region: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    p.start();
    p.key('Enter');
    after(p);
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.live().textContent).toBe('');
  });

  it('cancel and dispose end a pick from outside', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    picker?.cancel();
    expect(p.picking()).toBe(false);
    expect(document.activeElement).toBe(el('field'));
    expect(p.guardKeyUp).not.toHaveBeenCalled();
    p.start();
    picker?.dispose();
    expect(p.host()).toBeNull();
    expect(document.activeElement).toBe(el('field'));
    // Disposed: a later start does nothing.
    picker?.start(saveFocus(document));
    expect(p.host()).toBeNull();
  });

  it('the hidden focus holder is hidden from screen readers between picks', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const holder = p.root().querySelector('[tabindex="-1"]') as HTMLElement;
    expect(holder.hidden).toBe(false);
    p.key('Escape');
    expect(holder.hidden).toBe(true);
    p.start();
    expect(holder.hidden).toBe(false);
    expect(p.root().activeElement).toBe(holder);
  });

  it('ends when the page is hidden (pagehide)', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    window.dispatchEvent(new Event('pagehide'));
    expect(p.picking()).toBe(false);
    expect(document.activeElement).toBe(el('field'));
  });

  it('follows a modal dialog opening, and ends once its host cannot be seen', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const dialog = document.createElement('dialog');
    dialog.open = true;
    document.body.append(dialog);
    parentEl = dialog;
    window.dispatchEvent(new Event('scroll'));
    runFrames();
    expect(p.host()?.parentNode).toBe(dialog);
    expect(document.activeElement).toBe(p.host());
    expect(p.picking()).toBe(true);
    // Hidden with the dialog: still swallowing every key would trap the page.
    (p.host() as HTMLElement & { checkVisibility(): boolean }).checkVisibility = () => false;
    window.dispatchEvent(new Event('scroll'));
    runFrames();
    expect(p.picking()).toBe(false);
    expect(document.activeElement).toBe(el('field'));
  });

  it('checks its host on every key and press: moved with a dialog, or ended once unseen', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const dialog = document.createElement('dialog');
    dialog.open = true;
    document.body.append(dialog);
    parentEl = dialog;
    // No frame ran: the key itself takes the host along.
    p.key('ArrowUp');
    expect(p.host()?.parentNode).toBe(dialog);
    expect(picked()).toBe(el('sec'));
    // Hidden by a script (the dialog set to display:none): the next key goes to the page.
    (p.host() as HTMLElement & { checkVisibility(): boolean }).checkVisibility = () => false;
    const key = p.key('ArrowDown');
    expect(key.defaultPrevented).toBe(false);
    expect(p.picking()).toBe(false);
    expect(document.activeElement).toBe(el('field'));
  });

  it('a press finds its host unseen: the pick ends and the press goes to the page', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    (p.host() as HTMLElement & { checkVisibility(): boolean }).checkVisibility = () => false;
    expect(p.pointer('mousedown', el('link')).defaultPrevented).toBe(false);
    expect(p.picking()).toBe(false);
  });

  it('after the pick, keys and presses reach the page again', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    p.key('Escape');
    const seen: string[] = [];
    document.addEventListener('keydown', (event) => seen.push(event.key));
    const click = p.pointer('click', el('c'));
    p.key('ArrowUp');
    expect(click.defaultPrevented).toBe(false);
    expect(seen).toEqual(['ArrowUp']);
  });
});

describe('the highlight box', () => {
  it('sits 4px outside the block and follows it on scroll, in a frame', () => {
    layout();
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    const style = p.box().style;
    expect([style.left, style.top, style.width, style.height]).toEqual([
      '6px',
      '46px',
      '108px',
      '28px',
    ]);
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      left: 10,
      top: 20,
      width: 100,
      height: 20,
    } as DOMRect);
    window.dispatchEvent(new Event('scroll'));
    expect(style.top).toBe('46px');
    runFrames();
    expect(style.top).toBe('16px');
    // Moved by scrolling: no transition; moved to another block: one.
    expect(p.box().hasAttribute('data-t')).toBe(false);
    p.key('ArrowUp');
    expect(p.box().hasAttribute('data-t')).toBe(true);
  });

  it('goes away when the block leaves the page', () => {
    hits[CENTER()] = [el('a')];
    const p = setup();
    p.start();
    el('a').remove();
    window.dispatchEvent(new Event('resize'));
    runFrames();
    expect(p.box().hidden).toBe(true);
    expect(picked()).toBeUndefined();
    p.key('Enter');
    expect(p.region).not.toHaveBeenCalled();
  });
});
