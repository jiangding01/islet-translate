import isleTokens from '@/styles/tokens-isle.css?inline';
import {
  createStyleReader,
  HOLD_BLOCK_CHARS,
  isInlineElement,
  isSkipped,
  OWN_TAG,
  PICK_TAG,
  type StyleReader,
  sourceLength,
} from '../dom-rules';
import { message, type NoArgKey, uiLocale } from '../i18n';
import { type ProbeEnv, probeTheme } from '../isle/probe';
import type { RegionKind } from '../runtime-contract';
import { isOwnNode } from '../selection/watch';
import { restoreFocus, type SavedFocus } from './focus';
import { adoptSheet, HOST_STYLE, PICK_CSS } from './styles';

// The region picker (docs/plans/m3c.md, "区域选择器", PR4; Design prototype PaletteM3c boards
// 5 and 5b), started by the palette's "选择要翻译的区域" (and, PR5, "选择不翻译的区域"): a box
// around the block under the pointer (or, from the keyboard, at the viewport's centre), ↑ to
// grow it to the parent block, ↓ back, Enter or a click to translate it (or leave it alone),
// Escape or a right click to stop. Its own host `ET-PICK` draws the box and the hint bar and
// never takes the pointer. While picking, the window's capture phase keeps every trusted key
// and press from the page (a link is not followed, a field gets no caret), and the focus stays
// on a hidden element in the host, handed back to the page when the pick ends. The hold and
// selection watches listen on the document's capture phase, after the window, so they hear
// none of it either. A page that registered on the window's capture phase before us still
// hears first (known limit).

/** The pointer rests this long on another block before the box moves there. */
export const STEADY_MS = 80;
/** The box sits this far outside the block. */
const OUTSET = 4;
/** After a press ended the pick, the rest of that gesture is kept from the page this long. */
const AFTER_MS = 500;
/** "Translated" is said, then cleared after this long. */
const SAID_MS = 5000;
/** Where the keyboard's first block is looked for: down the viewport's middle, these heights. */
const STARTS = [0.5, 0.4, 0.6, 0.3, 0.7];
/** Presses: the page never sees them while picking, nor the rest of the one that ended it. */
const PRESSES = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
];
/** Everything the page never sees while picking (contextmenu: a right click, which stops). */
const BLOCKED = [
  ...PRESSES,
  'contextmenu',
  'pointerover',
  'mouseover',
  'pointerenter',
  'mouseenter',
  'pointerout',
  'mouseout',
  'pointerleave',
  'mouseleave',
];

type MediaQuery = Pick<MediaQueryList, 'matches'>;

export interface PickEnv {
  win: Window;
  raf?(callback: () => void): number;
  cancelRaf?(handle: number): void;
  matchMedia?(query: string): MediaQuery | undefined;
  elementsFromPoint?(x: number, y: number): Element[];
  getComputedStyle?: ProbeEnv['getComputedStyle'];
  /** Closed in production; tests open it to look inside. */
  shadowMode?: ShadowRootMode;
  /** Defaults to `event.isTrusted` (test DOMs dispatch only untrusted events). */
  isTrusted?(event: Event): boolean;
  /** Layout reads for the block test, one reader per pick; defaults to computed styles. */
  createReadStyle?(): StyleReader;
}

export interface PickerOptions {
  env: PickEnv;
  /** Where the host goes: <html>, or the modal dialog the page has open. */
  parent(): Element;
  /** Keeps the keyup of the key that ended the pick from the page (the palette's guard). */
  guardKeyUp(code: string): void;
  /** The confirmed block: translated or left alone (`page.region`); whether anything changed. */
  region(kind: RegionKind, root: Element): Promise<boolean>;
}

export interface Picker {
  /**
   * Starts picking an area to translate, or (`exclude`) one the page translation leaves alone;
   * `saved` is the page's focus, handed back when the pick ends.
   */
  start(saved: SavedFocus, kind?: RegionKind): void;
  /**
   * Ends a pick in progress without translating, handing the focus back; a confirmed pick's
   * late "translated" is not said any more.
   */
  cancel(): void;
  /** Removes the host; the picker is unusable afterwards. */
  dispose(): void;
}

export function createPicker({ env, parent, guardKeyUp, region }: PickerOptions): Picker {
  const { win } = env;
  const doc = win.document;
  const raf = env.raf ?? ((callback: () => void) => win.requestAnimationFrame(callback));
  const cancelRaf = env.cancelRaf ?? ((handle: number) => win.cancelAnimationFrame(handle));
  const trusted = env.isTrusted ?? ((event: Event) => event.isTrusted);
  const hitTest = env.elementsFromPoint ?? ((x: number, y: number) => doc.elementsFromPoint(x, y));
  const createReadStyle = env.createReadStyle ?? (() => createStyleReader(win));

  let host: HTMLElement | undefined;
  let els:
    | { box: HTMLElement; hint: HTMLElement; focus: HTMLElement; live: HTMLElement }
    | undefined;
  let active = false;
  let disposed = false;
  let kind: RegionKind = 'translate';
  const excluding = () => kind === 'exclude';
  let saved: SavedFocus = { element: null };
  let readStyle!: StyleReader;
  /** The highlighted block. */
  let current: Element | undefined;
  /** The block the pointer (or the centre) picked: ↑ grew `current` from it. */
  let base: Element | undefined;
  /** The blocks ↑ left behind, for ↓. */
  let stack: Element[] = [];
  let over = false;
  /** Which hint the bar shows (the too-large one or not); undefined: none yet. */
  let shownOver: boolean | undefined;
  /** The pointer's last position, and the block it moved to, waiting out STEADY_MS. */
  let point: { x: number; y: number } | undefined;
  let next: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  /** Bumped on every start, confirm and cancel: a late answer for an older pick says nothing. */
  let serial = 0;
  let saidTimer: ReturnType<typeof setTimeout> | undefined;
  /** Removes the after-press guard (guardPresses), if one is up. */
  let unguard = () => {};

  function node<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: (Node | string)[]
  ): HTMLElementTagNameMap[K] {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    element.append(...children);
    return element;
  }

  function mount() {
    const element = doc.createElement(PICK_TAG.toLowerCase());
    for (const [prop, value] of HOST_STYLE) element.style.setProperty(prop, value, 'important');
    element.setAttribute('data-et-theme', 'light');
    element.setAttribute('lang', uiLocale());
    const shadow = element.attachShadow({ mode: env.shadowMode ?? 'closed' });
    adoptSheet(win, shadow, `${isleTokens}\n${PICK_CSS}`);
    const box = node('div', { class: 'bx', hidden: '' });
    const hint = node('div', { class: 'hn', role: 'status', hidden: '' });
    // Holds the focus while picking (not in any tab order); the keys are heard on the window.
    // Hidden between picks: no stray "application" left for a screen reader to browse to.
    const focus = node('span', {
      class: 'sr',
      tabindex: '-1',
      role: 'application',
      hidden: '',
    });
    // Outlives the pick: "translated" is said after the focus went back to the page.
    const live = node('span', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    shadow.append(node('div', { class: 'r' }, box, hint, focus, live));
    host = element;
    els = { box, hint, focus, live };
  }

  /** Light or dark, judged by the page under the hint bar as the palette does. */
  function probe() {
    if (!host) return;
    const penv: ProbeEnv = {
      elementsFromPoint: hitTest,
      getComputedStyle:
        env.getComputedStyle ?? ((element: Element) => win.getComputedStyle(element)),
      host,
      prefersDark: () =>
        !!(env.matchMedia ?? ((query: string) => win.matchMedia?.(query)))(
          '(prefers-color-scheme: dark)',
        )?.matches,
    };
    let theme: 'light' | 'dark' = 'light';
    try {
      theme = probeTheme(penv, win.innerWidth / 2, win.innerHeight - 42, doc.documentElement);
    } catch {
      // Hit testing broken by the page: light.
    }
    host.setAttribute('data-et-theme', theme);
  }

  // ---- Blocks ------------------------------------------------------------------------------

  /** The nearest block from `el` up, short of the body; undefined when only the body is. */
  function blockFrom(el: Element | null): Element | undefined {
    const body = doc.body;
    let block = el;
    while (block && block !== body && isInlineElement(block, readStyle))
      block = block.parentElement;
    return block && block !== body && body?.contains(block) ? block : undefined;
  }

  /**
   * The block at a viewport point: the first element there that is not ours (a translation
   * stands for the paragraph it was added to), then its nearest block. None in a skipped or
   * protected area (isSkipped covers protectedAncestor's rules), nor on the body itself.
   */
  function candidateAt(x: number, y: number): Element | undefined {
    let hits: Element[];
    try {
      hits = hitTest(x, y);
    } catch {
      return undefined;
    }
    const hit = hits.find((element) => !isOwnNode(element));
    if (!hit) return undefined;
    const el = hit.closest(OWN_TAG)?.parentElement ?? hit;
    for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
      if (isSkipped(node)) return undefined;
    }
    return blockFrom(el);
  }

  /** The pointer (or the centre) picked a block: ↑ starts over from it. */
  function pick(block: Element | undefined) {
    base = block;
    stack = [];
    show(block);
  }

  function show(block: Element | undefined) {
    if (!els) return;
    const moved = !!current && !els.box.hidden;
    current = block;
    // The size limit is translation's: a whole sidebar or comment section may be left alone.
    over = !excluding() && !!block && sourceLength(block) > HOLD_BLOCK_CHARS;
    // From one block to another the box glides; it appears in place.
    els.box.toggleAttribute('data-t', moved);
    els.box.toggleAttribute('data-over', over);
    hint(over);
    place();
  }

  function expand() {
    const parentBlock = current && blockFrom(current.parentElement);
    if (!current || !parentBlock) return;
    stack.push(current);
    show(parentBlock);
  }

  function shrink() {
    const previous = stack.pop();
    if (previous) show(previous);
  }

  // ---- Drawing -----------------------------------------------------------------------------

  /** The hint bar, rebuilt only when it changes (it is a status: a rebuild is read out). */
  function hint(tooLarge: boolean) {
    if (!els || tooLarge === shownOver) return;
    shownOver = tooLarge;
    const key = (name: string, word: NoArgKey) => [
      node('span', { class: 'k' }, name),
      message(word),
    ];
    const parts: (Node | string)[][] = tooLarge
      ? [
          [
            node('span', { class: 'dt', 'aria-hidden': 'true' }),
            node('span', { class: 'wt' }, message('palette.pick.tooLarge')),
          ],
          key('↓', 'palette.pick.shrink'),
          key('Esc', 'palette.pick.cancel'),
        ]
      : [
          key('↑', 'palette.pick.expand'),
          key('↓', 'palette.pick.shrink'),
          key('Enter', 'palette.pick.confirm'),
          key('Esc', 'palette.pick.cancel'),
        ];
    els.hint.replaceChildren(
      ...parts.flatMap((part, index) =>
        index ? [node('span', { class: 'sp', 'aria-hidden': 'true' }, '·'), ...part] : part,
      ),
    );
  }

  /**
   * Whether the host can still be seen where it belongs, checked on every frame, key and
   * press. A modal dialog opened, or closed (a closed one is no longer `:modal`, so `parent()`
   * moves on), takes the host along. A host that cannot be seen even so (<html> or the dialog
   * itself set to `display:none`) ends the pick rather than swallow every input unseen.
   */
  function mounted(): boolean {
    if (!els || !host) return false;
    const where = parent();
    if (host.parentNode !== where) {
      where.append(host);
      els.focus.focus({ preventScroll: true });
    }
    if (host.checkVisibility?.() !== false) return true;
    end();
    return false;
  }

  /** Puts the box around the block; a block that left the page takes the box with it. */
  function place() {
    frame = 0;
    if (!els || !mounted()) return;
    if (current && !current.isConnected) {
      stack = [];
      base = undefined;
      show(undefined);
      return;
    }
    const { box } = els;
    box.hidden = !current;
    if (!current) return;
    const rect = current.getBoundingClientRect();
    const { style } = box;
    style.left = `${rect.left - OUTSET}px`;
    style.top = `${rect.top - OUTSET}px`;
    style.width = `${rect.width + 2 * OUTSET}px`;
    style.height = `${rect.height + 2 * OUTSET}px`;
  }

  // ---- Events ------------------------------------------------------------------------------

  const onHide = () => {
    end();
  };

  /** Scrolled, zoomed or resized: the box follows in the next frame, without gliding. */
  const onScroll = () => {
    els?.box.removeAttribute('data-t');
    if (!frame) frame = raf(place);
  };

  /**
   * Every trusted key stops here. Without ⌘, Ctrl or Alt it also loses its default (no
   * scrolling, no form submit, no caret move); with them the browser's own shortcuts work.
   */
  const onKey = (event: KeyboardEvent) => {
    if (!trusted(event) || !mounted()) return;
    event.stopImmediatePropagation();
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    if (!modified) event.preventDefault();
    const { key } = event;
    // A held Enter or Escape does not act again (the pick may have just begun on its press).
    if (event.type !== 'keydown' || (event.repeat && !key.startsWith('Arrow'))) return;
    if (key === 'Escape') end(event);
    else if (modified) return;
    else if (key === 'ArrowUp') expand();
    else if (key === 'ArrowDown') shrink();
    else if (key === 'Enter') confirm(event);
  };

  const swallow = (event: Event) => {
    if (!trusted(event)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  };

  /**
   * A click confirms the block clicked: the box when inside it (grown by ↑ or not), else the
   * block there. A click on no block, or a double click's second one, confirms nothing.
   */
  const onPress = (event: MouseEvent) => {
    if (!mounted() || !swallow(event)) return;
    if (event.type === 'contextmenu') end(undefined, true);
    else if (event.type === 'click' && event.button === 0 && !(event.detail >= 2)) {
      const at = candidateAt(event.clientX, event.clientY);
      if (!at) return;
      if (!current?.contains(at)) pick(at);
      confirm(undefined, true);
    }
  };

  /** Moves are only watched (passive): the page still sees them. */
  const onMove = (event: PointerEvent) => {
    if (!trusted(event)) return;
    point = { x: event.clientX, y: event.clientY };
    const found = candidateAt(point.x, point.y);
    if (found === base) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (timer !== undefined && found === next) return;
    clearTimeout(timer);
    next = found;
    timer = setTimeout(() => {
      if (point) steady(point.x, point.y);
    }, STEADY_MS);
  };

  /** The steady window is over: the pointer's block is taken if it is still the one there. */
  function steady(x: number, y: number) {
    clearTimeout(timer);
    timer = undefined;
    if (active && candidateAt(x, y) === next) pick(next);
  }

  function listen(on: boolean) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    win[method]('keydown', onKey as EventListener, true);
    win[method]('keyup', onKey as EventListener, true);
    for (const type of BLOCKED) win[method](type, onPress as EventListener, true);
    win[method]('pagehide', onHide);
    win[method]('pointermove', onMove as EventListener, { capture: true, passive: true });
    win[method]('scroll', onScroll, { capture: true, passive: true });
    win[method]('resize', onScroll);
  }

  // ---- Start and end -----------------------------------------------------------------------

  function confirm(event?: KeyboardEvent, pressed = false) {
    const root = current;
    if (!root?.isConnected || over) return;
    end(event, pressed);
    const mine = serial;
    region(kind, root).then(
      (added) => {
        // Only when something was added, and only for the latest pick still standing.
        if (!added || mine !== serial || !els) return;
        const { live } = els;
        live.textContent = message(excluding() ? 'palette.pick.excluded' : 'palette.pick.done');
        clearTimeout(saidTimer);
        saidTimer = setTimeout(() => {
          live.textContent = '';
        }, SAID_MS);
      },
      () => {
        // The isle and the panel report the session; the palette says nothing of errors.
      },
    );
  }

  /**
   * After a press ended the pick, the rest of that gesture (the mouseup of a right click, a
   * double click's second press) is kept from the page for AFTER_MS.
   */
  function guardPresses() {
    unguard();
    const timer = setTimeout(() => unguard(), AFTER_MS);
    // Presses on our own interface (the palette, the isle) are the user's next step, not the
    // rest of this gesture. In a closed shadow root the window sees the host as the target.
    const guard = (event: Event) => {
      if (!isOwnNode(event.target as Node | null)) swallow(event);
    };
    for (const type of PRESSES) win.addEventListener(type, guard, true);
    unguard = () => {
      clearTimeout(timer);
      for (const type of PRESSES) win.removeEventListener(type, guard, true);
      unguard = () => {};
    };
  }

  /**
   * Ends the pick: `event` is the key that ended it, whose keyup the page must not see;
   * `pressed`, a press did (the rest of its gesture is kept from the page too).
   */
  function end(event?: KeyboardEvent, pressed = false) {
    serial += 1;
    if (!active) return;
    active = false;
    listen(false);
    if (pressed) guardPresses();
    clearTimeout(timer);
    timer = undefined;
    if (frame) cancelRaf(frame);
    frame = 0;
    current = base = next = point = undefined;
    stack = [];
    if (els) {
      els.box.hidden = true;
      els.hint.hidden = true;
      els.focus.blur();
      els.focus.hidden = true;
    }
    if (event) guardKeyUp(event.code || event.key);
    restoreFocus(doc, saved);
    saved = { element: null };
  }

  return {
    start(focus, which = 'translate') {
      if (disposed) return;
      end();
      saved = focus;
      kind = which;
      if (!host?.isConnected) mount();
      if (!host || !els) return;
      // Into the modal dialog the page has open, if any: outside it everything is inert.
      const where = parent();
      if (host.parentNode !== where) where.append(host);
      active = true;
      readStyle = createReadStyle();
      shownOver = undefined;
      els.live.textContent = '';
      els.hint.hidden = false;
      els.focus.hidden = false;
      els.focus.setAttribute(
        'aria-label',
        message(excluding() ? 'palette.regionExclude' : 'palette.regionTranslate'),
      );
      probe();
      // A new pick takes its presses at once: the last one's guard goes.
      unguard();
      listen(true);
      els.focus.focus({ preventScroll: true });
      // From the keyboard: the first block down the viewport's middle, centre first.
      let first: Element | undefined;
      for (const at of STARTS) {
        first ??= candidateAt(win.innerWidth / 2, win.innerHeight * at);
      }
      pick(first);
    },
    cancel() {
      end();
    },
    dispose() {
      end();
      unguard();
      clearTimeout(saidTimer);
      disposed = true;
      host?.remove();
      host = undefined;
      els = undefined;
    },
  };
}
