import {
  BUILTIN_ENGINES,
  type ConfigV1,
  type Engine,
  type IsleDock,
  type PageMode,
} from '@/lib/config/types';
import type { EngineOptions, PageState } from '@/lib/messaging/protocol';
import isleTokens from '@/styles/tokens-isle.css?inline';
import { ISLE_TAG, PALETTE_TAG, SELECTION_TAG } from '../dom-rules';
import { errorText } from '../error-text';
import { message, type NoArgKey, pluralMessage, uiLocale } from '../i18n';
import { hasRetry, isActive } from '../page-state';
import type { PageRuntimeDeps } from '../runtime-contract';
import type { PageSession } from '../session';
import { engineMark, SVG_NS, showMark } from '../svg-icon';
import {
  alignedCenter,
  catchZone,
  clampOffset,
  clipPath,
  contains,
  contentRects,
  DOT_SHELL,
  DOT_SIZE,
  dotCenter,
  homeOffset,
  ISLE_DEPTH,
  isVertical,
  liftOf,
  listFits,
  MARGIN,
  outward,
  type Rect,
  rectOf,
  reservedLength,
  type Shape,
  shapesFor,
  type View,
  type Viewport,
} from './geometry';
import { createIntent } from './intent';
import { AVOID_GAP, avoid, findBanner, findObstacles, type ProbeEnv, probeTheme } from './probe';
import { createSpring, GROW, isResting, LIST, retarget, SHRINK, snap, step } from './spring';
import { ISLE_CSS } from './styles';

// The page isle (M2b PR2, docs/plans/m2b-lazy-runtime-and-isle.md section 9): one
// element that is the status dot, the toolbar and the engine list. It only calls the
// session's public methods; the session does not know it exists. Every frame writes
// the two clip-paths (plus compositor-only opacity/transform for the content
// choreography); layout is read only before an animation starts.

type MediaQuery = Pick<MediaQueryList, 'matches'> &
  Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>>;

export interface IsleEnv {
  win: Window;
  raf?(callback: () => void): number;
  cancelRaf?(handle: number): void;
  /** Milliseconds; defaults to `performance.now`. */
  now?(): number;
  matchMedia?(query: string): MediaQuery;
  elementsFromPoint?(x: number, y: number): Element[];
  getComputedStyle?: ProbeEnv['getComputedStyle'];
  /** Closed in production; tests open it to look inside. */
  shadowMode?: ShadowRootMode;
  /**
   * Whether a window event came from the user; page scripts can forge the rest.
   * Defaults to `event.isTrusted` (test DOMs dispatch only untrusted events).
   */
  isTrusted?(event: Event): boolean;
}

export interface IsleOptions {
  session: PageSession;
  deps: Pick<
    PageRuntimeDeps,
    'getConfig' | 'watchConfig' | 'listEngines' | 'openPalette' | 'paletteShortcut'
  >;
  env: IsleEnv;
}

export interface Isle {
  destroy(): void;
}

const HOST_STYLE: [string, string][] = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['pointer-events', 'none'],
  ['z-index', '2147483647'],
  ['contain', 'layout paint style'],
];

// Key table: the copy is looked up when the isle is built (docs/plans/i18n.md 4.2).
const MODES: { mode: PageMode | 'original'; glyph: NoArgKey; label: NoArgKey }[] = [
  { mode: 'bilingual', glyph: 'isle.glyphBilingual', label: 'isle.modeBilingual' },
  { mode: 'translation', glyph: 'isle.glyphTranslation', label: 'isle.modeTranslation' },
  { mode: 'original', glyph: 'isle.glyphOriginal', label: 'isle.modeOriginal' },
];
/** Icon strokes for the mode buttons outside Chinese UIs: `[path, stroke-opacity?]`. */
const MODE_ICONS: Record<string, [string, string?][]> = {
  'isle.glyphBilingual': [['M2.5 4.5h9'], ['M2.5 9.5h6', '.55']],
  'isle.glyphTranslation': [['M2.5 7h9']],
  'isle.glyphOriginal': [['M5 4 2.5 6.5 5 9'], ['M2.5 6.5h6a3 3 0 0 1 0 6H7']],
};
/** The palette button's ⌘ (14px grid, the mode icons' stroke). */
const PALETTE_ICON = 'M9 3v8a2 2 0 1 0 2-2H3a2 2 0 1 0 2 2V3a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2';
/** Mode button pitch: 28px button + 2px gap. */
const MODE_PITCH = 30;
/** The open isle tolerates the pointer this far outside its shape. */
const OPEN_PAD = 8;
const RESIZE_SETTLE_MS = 100;
/** Reduced motion keeps only a short opacity change. */
const REDUCED_FADE_MS = 120;
/** Bottom dock hover tip: wait before the first one shows… */
const TIP_DELAY_MS = 450;
/** …linger this long after the pointer leaves its button… */
const TIP_LINGER_MS = 90;
/** …and while showing, or within this long of hiding, jump straight to the next button. */
const TIP_SWITCH_MS = 300;
const TIP_FADE_MS = 120;
/** Above the button, and inside the viewport by this much. */
const TIP_GAP = 6;
const TIP_EDGE = 8;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function createIsle({ session, deps, env }: IsleOptions): Isle {
  const { win } = env;
  // Only the top frame gets an isle.
  if (win.top !== win) return { destroy() {} };
  const doc = win.document;
  const raf = env.raf ?? ((callback: () => void) => win.requestAnimationFrame(callback));
  const cancelRaf = env.cancelRaf ?? ((handle: number) => win.cancelAnimationFrame(handle));
  const now = env.now ?? (() => win.performance.now());
  const trusted = env.isTrusted ?? ((event: Event) => event.isTrusted);
  const media = (query: string): MediaQuery | undefined =>
    env.matchMedia?.(query) ?? win.matchMedia?.(query);
  const motionQuery = media('(prefers-reduced-motion: reduce)');

  type Mount = 'none' | 'mounted' | 'leaving';
  let mount: Mount = 'none';
  let configReady = false;
  let configEngine: Engine | undefined;
  /** Rows the list will have, known from the config before the engine list arrives. */
  let configRows: number = BUILTIN_ENGINES.length;
  let dock: IsleDock = 'right';
  let pendingDock: IsleDock | undefined;
  let last: PageState = session.state();
  let reduce = !!motionQuery?.matches;
  let options: EngineOptions | undefined;
  let optionsFailed = false;
  let loading: Promise<void> | undefined;
  let modeIndex = 0;
  let announcedDone = false;
  let announceFrame = 0;
  let destroyed = false;

  let viewport: Viewport = { w: 0, h: 0 };
  let shapes = shapesFor(dock, { w: 1, h: 1 }, { retry: false, options: 0 });
  let view: View = 'gone';
  /** Height of the bottom banner the isle rises above (bottom dock; 0 without one). */
  let banner = 0;
  interface Place {
    offset: number;
    floor: number;
    /** The dot's and the toolbar's middle (bottom dock); see centerFor for the list's. */
    center: number;
  }
  /** The last probed place. */
  let placed: Place = { offset: 0, floor: MARGIN, center: MARGIN + DOT_SIZE / 2 };
  // O: offset along the edge. Bottom dock only, as distances above the viewport bottom:
  // B the floor (16, or 8 above a banner), C the middle to line up with a widget the
  // isle steps around (B + 5 when it does not); see liftOf.
  const springs = {
    L: createSpring(0),
    D: createSpring(0),
    R: createSpring(0),
    O: createSpring(0),
    B: createSpring(MARGIN),
    C: createSpring(MARGIN + DOT_SIZE / 2),
    I: createSpring(0),
  };
  const opacity = { bar: 0, list: 0 };
  const shift = { bar: 0, list: 0 };
  interface Transition {
    d0: number;
    p: number;
    t0: number;
    from: { bar: number; list: number };
    shift0: { bar: number; list: number };
    show: { bar: boolean; list: boolean };
  }
  let transition: Transition | undefined;
  let frame = 0;
  let lastT = 0;
  let animating = false;
  const written = new Map<string, string>();

  const intent = createIntent();
  /** Where the pointer opened the isle, before the probe moved it (see open). */
  let origin: Rect | undefined;
  let intentTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** After a press elsewhere that the open palette held off: looked at again once it is over. */
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  // Bottom dock hover tip (the side docks use the native title).
  let tipButton: HTMLElement | undefined;
  let tipShowTimer: ReturnType<typeof setTimeout> | undefined;
  let tipHideTimer: ReturnType<typeof setTimeout> | undefined;
  let tipHiddenAt = Number.NEGATIVE_INFINITY;
  let tipOpacity = 0;
  let tipGoal = 0;
  let tipFrame = 0;
  let tipLastT = 0;
  /**
   * Where each toolbar button sits inside the toolbar, measured once the shape is still
   * (never mid-animation), for this dock and toolbar length.
   */
  let tipSpots:
    | { key: string; at: Map<HTMLElement, { x: number; y: number; w: number }> }
    | undefined;

  // ---- DOM ---------------------------------------------------------------------

  let host: HTMLElement | undefined;
  type Els = ReturnType<typeof build>;
  let els: Els | undefined;

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

  function svg(
    attrs: Record<string, string>,
    ...children: [string, Record<string, string>][]
  ): SVGSVGElement {
    const root = doc.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries({ fill: 'none', 'aria-hidden': 'true', ...attrs })) {
      root.setAttribute(name, value);
    }
    for (const [tag, childAttrs] of children) {
      const child = doc.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(childAttrs)) child.setAttribute(name, value);
      root.append(child);
    }
    return root;
  }

  const button = (cls: string, act: string, attrs: Record<string, string> = {}) =>
    node('button', { type: 'button', class: cls, tabindex: '-1', 'data-act': act, ...attrs });

  function build(shadow: ShadowRoot) {
    const root = node('div', { class: 'r', 'data-view': 'gone' });
    const aura = node(
      'div',
      { class: 'au' },
      svg({ width: '24', height: '24', viewBox: '0 0 24 24' }, [
        'circle',
        { cx: '12', cy: '12', r: '8', fill: 'currentColor', opacity: '.26' },
      ]),
      svg(
        { class: 'arc', width: '24', height: '24', viewBox: '0 0 24 24' },
        [
          'circle',
          {
            cx: '12',
            cy: '12',
            r: '10.5',
            stroke: 'currentColor',
            'stroke-opacity': '.22',
            'stroke-width': '1.5',
          },
        ],
        [
          'circle',
          {
            cx: '12',
            cy: '12',
            r: '10.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-dasharray': '17 49',
          },
        ],
      ),
    );
    const shadowLayer = node('div', { class: 'sh' });
    const line = node('div', { class: 'ln' });
    const tint = node('span', { class: 'tn' });
    const indicator = node('span', { class: 'ind' });
    const modes = MODES.map((item, index) => {
      const mode = button('md', `mode-${index}`, {
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': message(item.label),
      });
      // Chinese UIs keep the single character; other languages get a line icon.
      if (uiLocale().startsWith('zh')) mode.append(message(item.glyph));
      else {
        mode.append(
          svg(
            {
              width: '14',
              height: '14',
              viewBox: '0 0 14 14',
              stroke: 'currentColor',
              'stroke-width': '1.5',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            },
            ...(MODE_ICONS[item.glyph] ?? []).map(
              ([d, opacity]): [string, Record<string, string>] => [
                'path',
                opacity ? { d, 'stroke-opacity': opacity } : { d },
              ],
            ),
          ),
        );
      }
      return mode;
    });
    const count = node('b');
    const retry = button('ib rt', 'retry', { hidden: '' });
    retry.append(
      svg({ width: '13', height: '13', viewBox: '0 0 14 14' }, [
        'path',
        {
          d: 'M11.5 7A4.5 4.5 0 1 1 9.8 3.5M10 1v2.8H7.2',
          stroke: 'currentColor',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      ]),
      count,
    );
    const engine = button('ib eg', 'engine', {
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    // Its label gains the key in effect once read (see open).
    const palette = button('ib', 'palette', { 'aria-label': message('palette.label') });
    palette.append(
      svg(
        {
          width: '14',
          height: '14',
          viewBox: '0 0 14 14',
          stroke: 'currentColor',
          'stroke-width': '1.5',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        ['path', { d: PALETTE_ICON }],
      ),
    );
    const bar = node(
      'div',
      { class: 'bar', role: 'toolbar', 'aria-label': message('isle.toolbar') },
      node(
        'div',
        { class: 'seg', role: 'radiogroup', 'aria-label': message('isle.modes') },
        indicator,
        ...modes,
      ),
      node('span', { class: 'sep', 'aria-hidden': 'true' }),
      retry,
      engine,
      palette,
    );
    const rows = node('div', {
      class: 'op',
      role: 'listbox',
      'aria-label': message('isle.engines'),
    });
    const list = node(
      'div',
      { class: 'ls' },
      node('div', { class: 'lh' }, message('isle.listTitle')),
      rows,
      node('div', { class: 'lf' }, message('isle.listNote')),
    );
    const shell = node('div', { class: 'sl' }, bar, list);
    // Above the shell, not clipped by it: at rest the dot stays 10px over the 8px
    // shell; draw scales it with the shell, so it grows in and folds away with it.
    const hit = node('span', { class: 'hit', 'data-act': 'dot', 'aria-hidden': 'true' });
    const live = node('span', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    // The buttons keep their aria-label; the tip only repeats it for the pointer.
    const tip = node('span', { class: 'tp', 'aria-hidden': 'true' });
    root.append(aura, shadowLayer, line, shell, tint, hit, live, tip);
    shadow.append(root);
    return {
      root,
      aura,
      shadowLayer,
      line,
      shell,
      tint,
      bar,
      list,
      rows,
      indicator,
      modes,
      retry,
      count,
      engine,
      palette,
      hit,
      live,
      tip,
    };
  }

  function adoptStyles(shadow: ShadowRoot) {
    const css = `${isleTokens}\n${ISLE_CSS}`;
    const Sheet = (win as Window & { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
    try {
      if (Sheet && 'adoptedStyleSheets' in shadow) {
        const sheet = new Sheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        return;
      }
    } catch {
      // Fall through to a <style> element.
    }
    shadow.append(node('style', {}, css));
  }

  /** Writes a style property only when it changed (keeps frames cheap). */
  function write(element: HTMLElement | SVGElement, key: string, prop: string, value: string) {
    if (written.get(key) === value) return;
    written.set(key, value);
    element.style.setProperty(prop, value);
  }

  // ---- Probing (layout reads: never during an animation frame) -----------------

  const probeEnv = (): ProbeEnv | undefined => {
    if (!host) return undefined;
    const fromPoint =
      env.elementsFromPoint ?? ((x: number, y: number) => doc.elementsFromPoint(x, y));
    const styleOf = env.getComputedStyle ?? ((element: Element) => win.getComputedStyle(element));
    return {
      elementsFromPoint: fromPoint,
      getComputedStyle: styleOf,
      host,
      prefersDark: () => !!media('(prefers-color-scheme: dark)')?.matches,
    };
  };

  function readViewport(): Viewport {
    const root = doc.documentElement;
    const w = Math.min(root.clientWidth || win.innerWidth, win.innerWidth || root.clientWidth);
    const h = Math.min(root.clientHeight || win.innerHeight, win.innerHeight || root.clientHeight);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function shapeInput() {
    return {
      retry: hasRetry(last),
      options: options?.options.length ?? configRows,
    };
  }

  /** Bottom dock: the lower edges of the dot and the toolbar where they are heading. */
  const dotBase = () => liftOf(springs.B.t, springs.C.t, DOT_SIZE / 2);
  const barBase = () => liftOf(springs.B.t, springs.C.t, ISLE_DEPTH / 2);

  /** Target shapes for the current dock, viewport, content and toolbar height. */
  function reshapes(base = barBase()) {
    shapes = shapesFor(dock, viewport, shapeInput(), isVertical(dock) ? MARGIN : base);
  }

  /**
   * Measures the viewport, rises over a bottom banner, steps around the page's widgets
   * (centering on the one stepped around, bottom dock) and judges light or dark.
   */
  function probe(): Place {
    viewport = readViewport();
    const vertical = isVertical(dock);
    const home = homeOffset(dock, viewport);
    const rest = (floor: number): Place => ({ offset: 0, floor, center: floor + DOT_SIZE / 2 });
    const atHome = (): Place => {
      banner = 0;
      reshapes(MARGIN);
      return { ...rest(MARGIN), offset: clampOffset(home, reservedLength(shapes), dock, viewport) };
    };
    let place = atHome();
    const penv = probeEnv();
    if (!penv) return place;
    try {
      banner = findBanner(penv, dock, viewport);
      const floor = banner > 0 ? banner + AVOID_GAP : MARGIN;
      reshapes(floor);
      const length = reservedLength(shapes);
      const listMiddle = ISLE_DEPTH + (shapes.list.D - ISLE_DEPTH) / 2;
      const base = vertical ? MARGIN : floor;
      const obstacles = findObstacles(penv, dock, viewport, {
        depths: [base + DOT_SIZE / 2, base + ISLE_DEPTH / 2, base + listMiddle],
        offset: clampOffset(home, length, dock, viewport),
        length,
      });
      const avoided = avoid(home, length, obstacles, dock, viewport);
      place = { ...rest(floor), offset: avoided.offset };
      // Lined up with the widget stepped around, unless it is too tall or too high.
      if (!vertical && avoided.obstacle) {
        place.center = alignedCenter(floor, avoided.obstacle, viewport);
      }
      const [x, y] = dotCenter(
        dock,
        viewport,
        place.offset,
        liftOf(place.floor, place.center, DOT_SIZE / 2),
      );
      penv.host.setAttribute('data-et-theme', probeTheme(penv, x, y, doc.documentElement));
    } catch {
      // A page that breaks hit testing keeps the last theme and the home place.
      place = atHome();
    }
    return place;
  }

  // ---- Shape and content placement ---------------------------------------------

  function targetOffset(): number {
    return springs.O.t;
  }

  /** Places the content at its grown position (a layout write, once per change). */
  function placeContent() {
    if (!els) return;
    const offset = targetOffset();
    const { bar, list } = contentRects(dock, viewport, shapes, offset, barBase());
    const px = (element: HTMLElement, rect: Rect) => {
      element.style.left = `${round2(rect.x)}px`;
      element.style.top = `${round2(rect.y)}px`;
      element.style.width = `${round2(rect.w)}px`;
      element.style.height = `${round2(rect.h)}px`;
    };
    px(els.bar, bar);
    px(els.list, list);
    const dot = rectOf(dock, viewport, DOT_SIZE, DOT_SIZE, offset, dotBase());
    els.tint.style.left = `${round2(dot.x)}px`;
    els.tint.style.top = `${round2(dot.y)}px`;
    const [cx, cy] = dotCenter(dock, viewport, offset, dotBase());
    els.hit.style.left = `${round2(cx - 13)}px`;
    els.hit.style.top = `${round2(cy - 13)}px`;
    els.root.setAttribute('data-dock', dock);
    els.bar.setAttribute('aria-orientation', isVertical(dock) ? 'vertical' : 'horizontal');
  }

  /**
   * Bottom dock: the middle the current view lines up with. The engine list keeps the
   * toolbar lined up only while there is room above it for its header, footer and 3
   * rows; otherwise that view alone drops to the floor (the dot and the toolbar stay
   * lined up).
   */
  function centerFor(next: View): number {
    const { floor, center } = placed;
    if (next !== 'list' || isVertical(dock)) return center;
    const base = liftOf(floor, center, ISLE_DEPTH / 2);
    return listFits(viewport, base, shapeInput().options) ? center : floor + DOT_SIZE / 2;
  }

  /** Moves the isle to a probed place: along the edge, and up or down on the bottom dock. */
  function setPlace(place: Place, immediate: boolean) {
    placed = place;
    for (const [spring, target] of [
      [springs.O, place.offset],
      [springs.B, place.floor],
      [springs.C, centerFor(view)],
    ] as const) {
      if (immediate || reduce) snap(spring, target);
      else if (target !== spring.t) retarget(spring, target, LIST);
    }
    reshapes();
    placeContent();
    kick();
  }

  /** Re-aims the middle for a view (the list may drop to the floor); a spring like the rest. */
  function aim(next: View) {
    const center = centerFor(next);
    if (center === springs.C.t) return;
    if (reduce) snap(springs.C, center);
    else retarget(springs.C, center, LIST);
    reshapes();
    placeContent();
  }

  function setOffset(offset: number) {
    if (reduce) snap(springs.O, offset);
    else if (offset !== springs.O.t) retarget(springs.O, offset, LIST);
    placeContent();
    kick();
  }

  /** Re-aims L/D/R at the current view's shape (after a size or content change). */
  function reshape() {
    aim(view);
    const target = shapes[view];
    const grow = target.L * target.D > springs.L.x * springs.D.x;
    for (const key of ['L', 'D', 'R'] as const) {
      retarget(springs[key], target[key], grow ? GROW : SHRINK);
      if (reduce) snap(springs[key], target[key]);
    }
    setOffset(clampOffset(springs.O.t, reservedLength(shapes), dock, viewport));
  }

  function setView(next: View) {
    if (!els) return;
    aim(next);
    const target: Shape = shapes[next];
    const changed = next !== view;
    let params = SHRINK;
    if (changed && next === 'list') params = LIST;
    else if (target.L * target.D > springs.L.x * springs.D.x) params = GROW;
    for (const key of ['L', 'D', 'R'] as const) {
      retarget(springs[key], target[key], params);
      if (reduce) snap(springs[key], target[key]);
    }
    if (changed) {
      // Opening the list or folding up fades the tip out, words and all.
      if (next !== 'isle') hideTip();
      if (next === 'dot' || next === 'gone') origin = undefined;
      transition = {
        d0: Math.abs(springs.L.x - target.L) + Math.abs(springs.D.x - target.D),
        p: 0,
        t0: now(),
        from: { ...opacity },
        shift0: { ...shift },
        show: { bar: next === 'isle' || next === 'list', list: next === 'list' },
      };
      view = next;
      els.root.setAttribute('data-view', next);
      els.engine.setAttribute('aria-expanded', String(next === 'list'));
    }
    kick();
  }

  // ---- Frame loop ----------------------------------------------------------------

  function kick() {
    if (!els) return;
    if (!animating) {
      animating = true;
      // Shadow and will-change only while still / only while moving.
      els.shadowLayer.style.transition = 'none';
      els.shadowLayer.style.opacity = '0';
      els.shell.style.willChange = 'clip-path';
      els.line.style.willChange = 'clip-path';
    }
    if (!frame) frame = raf(tick);
  }

  function tick() {
    frame = 0;
    const t = now();
    const dt = lastT ? Math.min((t - lastT) / 1000, 1 / 30) : 1 / 60;
    lastT = t;
    let rest = true;
    for (const spring of Object.values(springs)) if (!step(spring, dt)) rest = false;
    choreograph(t);
    draw();
    if (!rest || transition) {
      frame = raf(tick);
      return;
    }
    lastT = 0;
    settle();
  }

  /** Old content fades in the first 35% of the morph, new content in the last 60%. */
  function choreograph(t: number) {
    const tr = transition;
    if (!tr) return;
    let p: number;
    if (reduce) p = clamp01((t - tr.t0) / REDUCED_FADE_MS);
    else {
      const d = Math.abs(springs.L.x - springs.L.t) + Math.abs(springs.D.x - springs.D.t);
      p = tr.d0 < 0.5 ? 1 : Math.max(tr.p, clamp01(1 - d / tr.d0));
    }
    tr.p = p;
    for (const name of ['bar', 'list'] as const) {
      const from = tr.from[name];
      const show = tr.show[name];
      if (reduce) {
        opacity[name] = from + ((show ? 1 : 0) - from) * p;
        shift[name] = 0;
      } else if (show) {
        opacity[name] = from >= 0.999 ? 1 : from + (1 - from) * clamp01((p - 0.4) / 0.6);
        shift[name] = tr.shift0[name] * (1 - clamp01(p / 0.6));
      } else {
        const q = clamp01(p / 0.35);
        opacity[name] = from * (1 - q);
        if (from > 0.01) shift[name] = tr.shift0[name] + (4 - tr.shift0[name]) * q;
      }
    }
    if (p >= 1 && springs.L.x === springs.L.t && springs.D.x === springs.D.t)
      transition = undefined;
  }

  function draw() {
    if (!els) return;
    const L = Math.max(0, springs.L.x);
    const D = Math.max(0, springs.D.x);
    const O = springs.O.x;
    const vertical = isVertical(dock);
    const { B, C } = springs;
    // Bottom dock: the lower edge follows the depth, so a shape centered on a widget
    // grows around its middle instead of bobbing.
    const base = vertical ? MARGIN : liftOf(B.x, C.x, D / 2);
    const dotLift = vertical ? MARGIN : liftOf(B.x, C.x, DOT_SIZE / 2);
    const rect = rectOf(dock, viewport, L, D, O, base);
    const grown = clamp01((D - DOT_SHELL) / (ISLE_DEPTH - DOT_SHELL));
    write(els.shell, 'shell', 'clip-path', clipPath(rect, viewport, springs.R.x));
    // The 1px outline (dark hosts) grows in with the depth: none around the dot.
    write(els.line, 'line', 'clip-path', clipPath(rect, viewport, springs.R.x, round2(grown)));
    const along = O - springs.O.t;
    // Content is placed where it is heading; these translate it to where it is now.
    const ax = vertical ? 0 : along;
    const ay = vertical ? along : dotBase() - dotLift;
    const ayBar = vertical ? along : barBase() - liftOf(B.x, C.x, ISLE_DEPTH / 2);
    // The dot grows and shrinks with the shell around their shared center (the shell
    // no longer clips it): full size from the 8px shell up, nothing when gone.
    const scale = clamp01(Math.min(L, D) / DOT_SHELL);
    write(els.tint, 'tint-o', 'opacity', String(round2(clamp01(1 - grown * 1.8))));
    write(
      els.tint,
      'tint-t',
      'transform',
      `translate(${round2(ax)}px,${round2(ay)}px) scale(${round2(scale)})`,
    );
    const [cx, cy] = dotCenter(dock, viewport, O, dotLift);
    write(
      els.aura,
      'aura-t',
      'transform',
      `translate(${round2(cx - 12)}px,${round2(cy - 12)}px) scale(${round2(scale)})`,
    );
    write(els.aura, 'aura-o', 'opacity', String(round2((1 - clamp01(grown * 2.2)) * scale)));
    const [dx, dy] = outward(dock);
    for (const name of ['bar', 'list'] as const) {
      const element = els[name];
      write(element, `${name}-o`, 'opacity', String(round2(opacity[name])));
      write(
        element,
        `${name}-t`,
        'transform',
        `translate(${round2(ax + dx * shift[name])}px,${round2(ayBar + dy * shift[name])}px)`,
      );
    }
    const offset = round2(springs.I.x);
    write(
      els.indicator,
      'ind',
      'transform',
      vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`,
    );
  }

  /** Everything is still: drop will-change, lay the shadow under the final shape. */
  function settle() {
    if (!els) return;
    animating = false;
    els.shell.style.willChange = '';
    els.line.style.willChange = '';
    if (view === 'gone') {
      // At rest, 'leaving' always ends in an unmount and 'mounted' never stays gone.
      // Leaving is decided by the last state this isle applied, not session.state():
      // a restart it has not been pushed yet mounts afresh when the push arrives.
      if (mount === 'leaving') unmountNow();
      else {
        switchDock();
        setView(regrown());
      }
      return;
    }
    publishRect();
    if (view === 'isle' || view === 'list') {
      const target = shapes[view];
      const base = liftOf(springs.B.t, springs.C.t, target.D / 2);
      const rect = rectOf(dock, viewport, target.L, target.D, springs.O.t, base);
      const style = els.shadowLayer.style;
      style.left = `${round2(rect.x)}px`;
      style.top = `${round2(rect.y)}px`;
      style.width = `${round2(rect.w)}px`;
      style.height = `${round2(rect.h)}px`;
      style.borderRadius = `${round2(Math.min(target.R, rect.w / 2, rect.h / 2))}px`;
      style.transition = '';
      style.opacity = '1';
    }
    if (view === 'isle' && dock === 'bottom') {
      // Still: the one moment the tip may measure, and place one asked for meanwhile.
      if (tipSpots?.key !== spotsKey()) measureSpots();
      if (tipButton) placeTip();
    }
  }

  /**
   * `data-et-rect="x,y,w,h"` on the host: what the selection card keeps clear of (it
   * cannot see inside the closed shadow). The toolbar even while a dot, since that is
   * what the dot grows into; the list while open. Written only at rest. With it
   * `data-et-dock`, the edge it sits on: the palette beside it follows a dock change.
   */
  function publishRect() {
    if (!host) return;
    const target = shapes[view === 'list' ? 'list' : 'isle'];
    const base = isVertical(dock) ? MARGIN : liftOf(springs.B.t, springs.C.t, target.D / 2);
    const rect = rectOf(dock, viewport, target.L, target.D, springs.O.t, base);
    setAttr(host, 'data-et-dock', dock);
    setAttr(host, 'data-et-rect', [rect.x, rect.y, rect.w, rect.h].map(Math.round).join(','));
  }

  // ---- Mount state machine -------------------------------------------------------

  function mountNow() {
    const element = doc.createElement(ISLE_TAG.toLowerCase());
    for (const [prop, value] of HOST_STYLE) element.style.setProperty(prop, value, 'important');
    element.setAttribute('data-et-theme', 'light');
    // The page's own language must not leak in: it picks fonts and the screen reader's voice.
    element.setAttribute('lang', uiLocale());
    const shadow = element.attachShadow({ mode: env.shadowMode ?? 'closed' });
    adoptStyles(shadow);
    host = element;
    els = build(shadow);
    if (reduce) els.root.setAttribute('data-rm', '');
    doc.documentElement.append(element);
    mount = 'mounted';
    view = 'gone';
    written.clear();
    for (const spring of Object.values(springs)) snap(spring, 0);
    setPlace(probe(), true);
    snap(springs.I, modeIndex * MODE_PITCH);
    listen();
    renderState();
    renderEngines();
    void loadEngines();
    announceStart();
    setView('dot');
  }

  function unmountNow() {
    unlisten();
    if (frame) cancelRaf(frame);
    frame = 0;
    if (announceFrame) cancelRaf(announceFrame);
    announceFrame = 0;
    resetTip();
    lastT = 0;
    animating = false;
    transition = undefined;
    host?.remove();
    host = undefined;
    els = undefined;
    mount = 'none';
    view = 'gone';
    opacity.bar = 0;
    opacity.list = 0;
    shift.bar = 0;
    shift.list = 0;
    if (pendingDock) {
      dock = pendingDock;
      pendingDock = undefined;
    }
  }

  function switchDock() {
    if (!pendingDock) return;
    dock = pendingDock;
    pendingDock = undefined;
    written.clear();
    setPlace(probe(), true);
    renderState();
  }

  function announceStart() {
    announcedDone = false;
    const live = els?.live;
    if (!live) return;
    // An empty live region first, the words on the next frame: a region filled at
    // insertion time is not announced.
    live.textContent = '';
    if (announceFrame) cancelRaf(announceFrame);
    announceFrame = raf(() => {
      announceFrame = 0;
      if (els?.live === live) live.textContent = message('isle.started');
    });
  }

  function apply(state: PageState) {
    const previous = last;
    last = state;
    if (!configReady) return;
    const index = state.mode === 'translation' ? 1 : 0;
    if (isActive(state)) {
      if (mount === 'none') {
        modeIndex = index;
        mountNow();
      } else {
        if (mount === 'leaving') {
          // Back before the exit finished: keep the springs' velocity and grow again.
          mount = 'mounted';
          announceStart();
          if (!pendingDock) setView('dot');
        }
        // Follow mode changes made elsewhere (the panel); a click already moved it.
        if (state.mode !== previous.mode || modeIndex === 2) setMode(index);
      }
      renderState();
      if (hasRetry(previous) !== hasRetry(state) && els) {
        reshapes();
        reshape();
      }
      if (state.phase === 'done' && !announcedDone && els) {
        announcedDone = true;
        // The start announcement queued for the next frame must not overwrite this one.
        if (announceFrame) cancelRaf(announceFrame);
        announceFrame = 0;
        els.live.textContent =
          (state.skipped ?? 0) > 0
            ? message(
                'isle.withNote',
                message('isle.finished'),
                pluralMessage(
                  'common.skippedCount',
                  state.skipped ?? 0,
                  (state.skipped ?? 0).toLocaleString(uiLocale()),
                ),
              )
            : message('isle.finished');
      }
      return;
    }
    if (mount === 'mounted') {
      mount = 'leaving';
      clearTimeout(intentTimer);
      setView('gone');
    }
  }

  // ---- Rendering state ------------------------------------------------------------

  function currentEngine(): Engine | undefined {
    return last.engine ?? configEngine ?? options?.configured;
  }

  /** Attribute and text writes that skip unchanged values (every state push lands here). */
  function setAttr(element: Element, name: string, value: string) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
  function setText(element: Element, value: string) {
    if (element.textContent !== value) element.textContent = value;
  }

  function renderState() {
    if (!els) return;
    const { root, modes, retry, count, engine, palette } = els;
    root.toggleAttribute('data-run', last.phase === 'running');
    const failing = hasRetry(last);
    root.toggleAttribute('data-fail', failing);
    modes.forEach((item, index) => {
      setAttr(item, 'aria-checked', String(index === modeIndex));
    });
    // Retry coming or going resizes the toolbar: the springs move, settle re-places a tip.
    const reflow = retry.hidden === failing;
    if (!failing && tipButton === retry) hideTip();
    retry.toggleAttribute('hidden', !failing);
    setText(count, last.failed > 0 ? String(last.failed) : '');
    const label =
      last.failed > 0 ? pluralMessage('isle.retryCount', last.failed) : message('common.retry');
    setAttr(retry, 'aria-label', label);
    const current = currentEngine();
    const option = options?.options.find((item) => item.id === current);
    showMark(doc, engine, option);
    // An engine no longer in the list (deleted while in use) shows by its id.
    const name = option?.name ?? current ?? '';
    const engineLabel = last.engineError
      ? message('isle.engineError', name, errorText(last.engineError))
      : message('isle.engineSwitch', name);
    setAttr(engine, 'aria-label', engineLabel);
    engine.toggleAttribute('data-err', !!last.engineError);
    // The side docks show the native title; the bottom dock draws its own tip.
    for (const item of [...modes, retry, engine, palette]) {
      const text = item.getAttribute('aria-label') ?? '';
      if (isVertical(dock)) setAttr(item, 'title', text);
      else if (item.hasAttribute('title')) item.removeAttribute('title');
    }
    // A showing tip follows its button's label (the failure count, an engine error).
    const words = tipButton?.getAttribute('aria-label') ?? '';
    if (tipShowing() && words !== els.tip.textContent) {
      if (!reflow && still()) placeTip();
      else setText(els.tip, words);
    }
  }

  function setMode(index: number) {
    modeIndex = index;
    retarget(springs.I, index * MODE_PITCH, GROW);
    if (reduce) snap(springs.I, index * MODE_PITCH);
    els?.modes.forEach((item, i) => {
      item.setAttribute('aria-checked', String(i === index));
    });
    kick();
  }

  function renderEngines() {
    if (!els) return;
    const current = currentEngine();
    const rows: HTMLElement[] = [];
    if (!options) {
      if (optionsFailed) rows.push(node('div', { class: 'lh' }, message('isle.listFailed')));
    } else {
      for (const option of options.options) {
        const selected = option.id === current;
        const row = button('o', 'pick', {
          role: 'option',
          'aria-selected': String(selected),
          'data-id': option.id,
        });
        row.disabled = !option.ready;
        row.append(engineMark(doc, option), node('span', { class: 'nm' }, option.name));
        if (selected) {
          const check = svg({ class: 'ck', width: '14', height: '14', viewBox: '0 0 14 14' }, [
            'path',
            {
              d: 'M3 7.3l2.6 2.6L11 4.5',
              stroke: 'currentColor',
              'stroke-width': '1.6',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            },
          ]);
          row.append(check);
        } else if (!option.ready && option.note) {
          row.append(node('span', { class: 'nt' }, option.note));
        }
        rows.push(row);
      }
    }
    els.rows.replaceChildren(...rows);
    renderState();
  }

  function loadEngines(): Promise<void> {
    if (loading) return loading;
    const count = shapeInput().options;
    loading = deps
      .listEngines()
      .then(
        (result) => {
          options = result;
          optionsFailed = false;
        },
        () => {
          optionsFailed = !options;
        },
      )
      .finally(() => {
        loading = undefined;
        renderEngines();
        if (els && shapeInput().options !== count) {
          reshapes();
          placeContent();
          reshape();
        }
      });
    return loading;
  }

  // ---- Interaction ------------------------------------------------------------------

  const isOpen = () => view === 'isle' || view === 'list';
  /** Live: the fallback for a palette in a modal dialog, without a query per call. */
  const palettes = doc.getElementsByTagName(PALETTE_TAG.toLowerCase());
  const showing = (palette: Element) =>
    palette.hasAttribute('data-open') &&
    palette.isConnected &&
    palette.checkVisibility?.() !== false;
  /**
   * The palette is open and showing: its host under <html>, or in the modal dialog it joined
   * (so a page's own `et-palette`, or one hidden with its dialog, never holds the isle open).
   * The usual host is checked among <html>'s few children first: no document walk.
   */
  function paletteOpen(): boolean {
    for (const child of doc.documentElement.children) {
      if (child.nodeName === PALETTE_TAG && showing(child)) return true;
    }
    for (const palette of palettes) {
      const parent = palette.parentElement;
      try {
        if (parent?.nodeName === 'DIALOG' && parent.matches(':modal') && showing(palette)) {
          return true;
        }
      } catch {
        // `:modal` unsupported: the palette never joins a dialog there.
      }
    }
    return false;
  }

  /**
   * What a fold for a dock change grows back into: the toolbar while the palette is open (it
   * keeps the isle open, and sits beside the toolbar), the dot otherwise.
   */
  const regrown = (): View => (paletteOpen() ? 'isle' : 'dot');

  function inside(x: number, y: number): boolean {
    const offset = targetOffset();
    if (contains(catchZone(dock, viewport, offset, dotBase(), banner), x, y)) return true;
    if (!isOpen()) return false;
    if (origin && contains(origin, x, y)) return true;
    const shape = shapes[view];
    const base = liftOf(springs.B.t, springs.C.t, shape.D / 2);
    return contains(rectOf(dock, viewport, shape.L, shape.D, offset, base), x, y, OPEN_PAD);
  }

  function evaluate() {
    clearTimeout(intentTimer);
    intentTimer = undefined;
    if (mount !== 'mounted') return;
    const decision = intent.decide(now(), isOpen());
    if (decision.action === 'open') open();
    // The palette beside it keeps it open; the next move after it closes decides again.
    else if (decision.action === 'close') {
      if (!paletteOpen()) close();
    } else if (decision.wait !== undefined) intentTimer = setTimeout(evaluate, decision.wait + 1);
  }

  function open() {
    if (mount !== 'mounted' || view !== 'dot') return;
    // The probe may move the isle out from under the pointer that opened it (a banner
    // gone, a widget appeared): that spot keeps it open as well, until it folds.
    const before = catchZone(dock, viewport, targetOffset(), dotBase(), banner);
    // About to animate: the one moment layout may be read.
    setPlace(probe(), false);
    origin = before;
    void loadEngines();
    setView('isle');
    // Read on every opening: a key changed in chrome://extensions/shortcuts shows next time.
    deps.paletteShortcut().then((key) => {
      if (!els) return;
      setAttr(
        els.palette,
        'aria-label',
        key ? message('isle.palette', key) : message('palette.label'),
      );
      renderState();
    });
  }

  function close() {
    intent.closed(now());
    if (isOpen()) setView('dot');
  }

  // ---- Hover tip (bottom dock) -----------------------------------------------------

  const tipShowing = () => !!tipButton && !!els?.tip.textContent;

  function tipIn(button: HTMLElement) {
    if (dock !== 'bottom' || view !== 'isle') return;
    clearTimeout(tipShowTimer);
    // Showing (lingering included) or only just hidden: switch over at once.
    if (tipShowing() || now() - tipHiddenAt < TIP_SWITCH_MS) showTip(button);
    else tipShowTimer = setTimeout(() => showTip(button), TIP_DELAY_MS);
  }

  function tipOut() {
    clearTimeout(tipShowTimer);
    tipShowTimer = undefined;
    if (!tipButton) return;
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(hideTip, TIP_LINGER_MS);
  }

  /** The shape (not just the mode indicator) is at rest: content sits where it was placed. */
  function still(): boolean {
    if (transition) return false;
    return (['L', 'D', 'R', 'O', 'B', 'C'] as const).every((key) => isResting(springs[key]));
  }

  /** The tip's spots hold for one dock and one toolbar length (retry shown or not). */
  const spotsKey = () => `${dock}:${shapes.isle.L}`;

  /** Layout reads: only once the shape is still (settle, or a tip asked for at rest). */
  function measureSpots() {
    if (!els) return;
    const at = new Map<HTMLElement, { x: number; y: number; w: number }>();
    for (const button of [...els.modes, els.retry, els.engine, els.palette]) {
      // The button's resting place: offsets ignore the content's morph transforms.
      let x = 0;
      let y = 0;
      for (
        let element: HTMLElement | null = button;
        element && element !== els.bar;
        element = element.offsetParent as HTMLElement | null
      ) {
        x += element.offsetLeft;
        y += element.offsetTop;
      }
      at.set(button, { x, y, w: button.offsetWidth });
    }
    tipSpots = { key: spotsKey(), at };
  }

  function showTip(button: HTMLElement) {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    tipShowTimer = undefined;
    tipHideTimer = undefined;
    if (!els || dock !== 'bottom' || view !== 'isle') return;
    tipButton = button;
    // Mid-animation nothing is read: settle places it once the shape is still.
    if (still()) placeTip();
  }

  /** Writes the tip's words and place from the cached spots; the shape is still. */
  function placeTip() {
    if (!els || !tipButton) return;
    if (tipSpots?.key !== spotsKey()) measureSpots();
    const spot = tipSpots?.at.get(tipButton) ?? { x: 0, y: 0, w: 0 };
    const tip = els.tip;
    setText(tip, tipButton.getAttribute('aria-label') ?? '');
    const { bar } = contentRects(dock, viewport, shapes, targetOffset(), barBase());
    const width = tip.offsetWidth;
    const center = bar.x + spot.x + spot.w / 2;
    const left = Math.max(TIP_EDGE, Math.min(viewport.w - TIP_EDGE - width, center - width / 2));
    const top = Math.max(TIP_EDGE, bar.y + spot.y - TIP_GAP - tip.offsetHeight);
    tip.style.left = `${round2(left)}px`;
    tip.style.top = `${round2(top)}px`;
    fadeTip(1);
  }

  /** Fades out with its words and size; the text clears only once fully transparent. */
  function hideTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    tipShowTimer = undefined;
    tipHideTimer = undefined;
    // One asked for but never placed (the shape still moving) was not seen.
    if (tipShowing()) tipHiddenAt = now();
    tipButton = undefined;
    if (els?.tip.textContent) fadeTip(0);
  }

  function fadeTip(goal: number) {
    tipGoal = goal;
    if (!tipFrame) {
      tipLastT = 0;
      tipFrame = raf(tipTick);
    }
  }

  /** Its own frame loop: the tip never wakes the shape's (which hides the shadow). */
  function tipTick() {
    tipFrame = 0;
    if (!els) return;
    const t = now();
    const dt = tipLastT ? t - tipLastT : 16;
    tipLastT = t;
    const delta = dt / TIP_FADE_MS;
    tipOpacity =
      tipGoal > tipOpacity
        ? Math.min(tipGoal, tipOpacity + delta)
        : Math.max(tipGoal, tipOpacity - delta);
    els.tip.style.opacity = String(round2(tipOpacity));
    if (tipOpacity !== tipGoal) {
      tipFrame = raf(tipTick);
      return;
    }
    tipLastT = 0;
    if (tipGoal === 0) setText(els.tip, '');
  }

  function resetTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    tipShowTimer = undefined;
    tipHideTimer = undefined;
    if (tipFrame) cancelRaf(tipFrame);
    tipFrame = 0;
    tipButton = undefined;
    tipHiddenAt = Number.NEGATIVE_INFINITY;
    tipOpacity = 0;
    tipGoal = 0;
    if (!els) return;
    els.tip.style.opacity = '0';
    setText(els.tip, '');
  }

  function act(action: string, target: HTMLElement) {
    if (mount !== 'mounted') return;
    const ignore = () => {};
    // Any other button closes the palette first (focus back to the page): it would cover the
    // engine list, and its list would show the state before this action. The dot only grows
    // the isle, as hovering it does, so the palette stays.
    if (action !== 'palette' && action !== 'dot' && paletteOpen()) deps.openPalette();
    if (action === 'dot') open();
    else if (action === 'mode-0' || action === 'mode-1') {
      const index = action === 'mode-0' ? 0 : 1;
      setMode(index);
      session.setMode(index === 0 ? 'bilingual' : 'translation').catch(ignore);
    } else if (action === 'mode-2') {
      setMode(2);
      session.stop().catch(ignore);
    } else if (action === 'retry') session.retryFailed();
    else if (action === 'engine') {
      if (view === 'list') setView('isle');
      else if (view === 'isle') {
        void loadEngines();
        setView('list');
      }
    } else if (action === 'pick') {
      const id = target.getAttribute('data-id') as Engine | null;
      setView('isle');
      if (id && id !== currentEngine()) session.start({ engine: id }).catch(ignore);
    } else if (action === 'palette') {
      // Beside the toolbar, not the engine list (which folds away).
      if (view === 'list') setView('isle');
      // The palette reads where the isle sits: published now, even if it is still moving.
      publishRect();
      deps.openPalette();
    }
  }

  // Window listeners: passive pointer tracking (no hot zone over the page).
  // Page scripts can dispatch these too: only the user's own input moves the isle.
  const onPointerMove = (event: PointerEvent) => {
    if (mount !== 'mounted' || !trusted(event)) return;
    intent.move(
      { x: event.clientX, y: event.clientY, t: now(), buttons: event.buttons },
      inside(event.clientX, event.clientY),
    );
    evaluate();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget || mount !== 'mounted' || !trusted(event)) return;
    intent.leave(now());
    evaluate();
  };
  const onScroll = () => {
    intent.scroll(now());
    if (mount === 'mounted' && !isOpen()) evaluate();
  };
  const onPointerDownOutside = (event: PointerEvent) => {
    if (!host || !isOpen() || !trusted(event)) return;
    if (event.composedPath().includes(host)) return;
    if (!paletteOpen()) {
      close();
      return;
    }
    // Inside the palette, nothing to do. Elsewhere, the palette closes on this same press
    // (its own listener, maybe after this one): look again once the event is over.
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      if (isOpen() && !paletteOpen()) close();
    }, 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Only closes; the page still sees the key (no preventDefault).
    if (event.key !== 'Escape' || !isOpen() || !trusted(event)) return;
    // The selection card or the palette above closes first: one Escape closes only the top layer.
    for (const child of doc.documentElement.children) {
      if (child.nodeName === SELECTION_TAG && child.hasAttribute('data-open')) return;
    }
    if (paletteOpen()) return;
    if (view === 'list') setView('isle');
    else close();
  };
  const onResize = () => {
    // The shell and the content are placed in viewport pixels: redrawn only after the
    // settle, a window dragged wider showed a dark bar from the old dot to the new edge
    // and a narrower one clipped the dot away. Glue to the new edge on every event (no
    // layout beyond the viewport size); stepping around widgets waits for the settle.
    if (els && mount !== 'none') {
      hideTip();
      viewport = readViewport();
      const offset = clampOffset(placed.offset, reservedLength(shapes), dock, viewport);
      setPlace({ ...placed, offset }, true);
      draw();
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!els || mount === 'none') return;
      hideTip();
      setPlace(probe(), true);
      reshape();
    }, RESIZE_SETTLE_MS);
  };
  const onMotion = () => {
    reduce = !!motionQuery?.matches;
    els?.root.toggleAttribute('data-rm', reduce);
  };
  // Inside the shadow: keep the page's focus and selection, act on click.
  const keepFocus = (event: Event) => {
    event.preventDefault();
  };
  const onTipIn = (event: Event) => {
    tipIn(event.currentTarget as HTMLElement);
  };
  const onTipOut = () => {
    tipOut();
  };
  const onTipPress = () => {
    hideTip();
  };
  const onClick = (event: Event) => {
    const target = (event.target as Element | null)?.closest?.('[data-act]') as HTMLElement | null;
    if (!target || (target as HTMLButtonElement).disabled) return;
    act(target.getAttribute('data-act') ?? '', target);
  };

  function listen() {
    const passive = { passive: true } as const;
    win.addEventListener('pointermove', onPointerMove, passive);
    win.addEventListener('pointerout', onPointerOut, passive);
    win.addEventListener('scroll', onScroll, { capture: true, passive: true });
    win.addEventListener('pointerdown', onPointerDownOutside, { capture: true, passive: true });
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('resize', onResize, passive);
    motionQuery?.addEventListener?.('change', onMotion);
    if (!els) return;
    for (const target of [els.shell, els.hit]) {
      target.addEventListener('pointerdown', keepFocus);
      target.addEventListener('mousedown', keepFocus);
      target.addEventListener('click', onClick);
    }
    for (const target of [...els.modes, els.retry, els.engine, els.palette]) {
      target.addEventListener('pointerenter', onTipIn);
      target.addEventListener('pointerleave', onTipOut);
      target.addEventListener('pointerdown', onTipPress);
    }
  }

  function unlisten() {
    clearTimeout(intentTimer);
    clearTimeout(resizeTimer);
    clearTimeout(pressTimer);
    pressTimer = undefined;
    resetTip();
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerout', onPointerOut);
    win.removeEventListener('scroll', onScroll, true);
    win.removeEventListener('pointerdown', onPointerDownOutside, true);
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('resize', onResize);
    motionQuery?.removeEventListener?.('change', onMotion);
  }

  // ---- Wiring -------------------------------------------------------------------------

  function onConfig(config: ConfigV1) {
    configEngine = config.translation.engine;
    configRows = BUILTIN_ENGINES.length + Object.keys(config.customProviders).length;
    const next = config.page.isleDock;
    if (mount === 'none') dock = next;
    else if (next !== (pendingDock ?? dock)) {
      if (next === dock) {
        // Changed back before the fold finished: grow again where it is.
        pendingDock = undefined;
        if (mount === 'mounted') setView(regrown());
      } else {
        // Fold into the dot's spot, then grow on the new edge (settle does the switch).
        pendingDock = next;
        if (mount === 'mounted') setView('gone');
      }
    }
    if (mount !== 'none') {
      void loadEngines();
      renderState();
    }
  }

  const unsubscribe = session.subscribe(apply);
  let stopWatching: (() => void) | undefined;
  deps
    .getConfig()
    .then(onConfig, () => {
      // Unreadable config: the session will not start either; keep the defaults.
    })
    .finally(() => {
      if (destroyed) return;
      configReady = true;
      try {
        stopWatching = deps.watchConfig(onConfig);
      } catch {
        // The extension was reloaded ("Extension context invalidated"): no live updates.
      }
      // Prefetched so the first probe already reserves room for the whole list.
      void loadEngines();
      apply(session.state());
    });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      stopWatching?.();
      stopWatching = undefined;
      if (mount !== 'none') unmountNow();
    },
  };
}
