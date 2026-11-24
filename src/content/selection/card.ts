import type { ConfigV1, Engine } from '@/lib/config/types';
import type { AppError } from '@/lib/errors';
import {
  type DetectedLanguages,
  isTargetLanguage,
  type LanguageCode,
  languageName,
  normalizeLanguage,
} from '@/lib/languages';
import type { EngineOptions, TranslateDisposition } from '@/lib/messaging/protocol';
import isleTokens from '@/styles/tokens-isle.css?inline';
import { ISLE_TAG, SELECTION_TAG } from '../dom-rules';
import { errorText } from '../error-text';
import { message, type NoArgKey, uiLocale } from '../i18n';
import { type ProbeEnv, probeTheme } from '../isle/probe';
import { createSpring, GROW, retarget, SHRINK, snap, step } from '../isle/spring';
import type {
  SelectionRuntime,
  SelectionRuntimeDeps,
  SelectionSnapshot,
} from '../runtime-contract';
import { engineMark, SVG_NS, showMark } from '../svg-icon';
import { extractText } from './extract';
import {
  type Box,
  CARD_MAX_HEIGHT,
  cardTop,
  clampPinned,
  dotAt,
  estimateHeight,
  isOutOfView,
  type Placement,
  placeCard,
  placeDetached,
  type Size,
} from './place';
import {
  type CardPort,
  createCardRequests,
  MAX_SOURCE_LENGTH,
  type RequestEvent,
  reliableLanguage,
  wantsPhonetic,
} from './request';
import { createSpeech, type SpeechEnv } from './speech';
import { CARD_CSS } from './styles';

// The selection dot and card (plan 4.3): one element that is the amber dot and, grown,
// the card. The dot asks nothing of anyone; the card's request starts only when it opens
// (plan 1.3 rule 3). Every frame writes the shell's clip-path plus compositor-only
// opacity/transform; layout is read only when the selection, the content or the viewport
// changed, never inside a frame.

type MediaQuery = Pick<MediaQueryList, 'matches'> &
  Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>>;

export interface CardEnv {
  win: Window;
  raf?(callback: () => void): number;
  cancelRaf?(handle: number): void;
  /** Milliseconds; defaults to `performance.now`. */
  now?(): number;
  matchMedia?(query: string): MediaQuery | undefined;
  elementsFromPoint?(x: number, y: number): Element[];
  getComputedStyle?: ProbeEnv['getComputedStyle'];
  /** Closed in production; tests open it to look inside. */
  shadowMode?: ShadowRootMode;
  /**
   * Whether an event came from the user; page scripts can forge the rest.
   * Defaults to `event.isTrusted` (test DOMs dispatch only untrusted events).
   */
  isTrusted?(event: Event): boolean;
  speech?: SpeechEnv;
  /** Defaults to `navigator.clipboard.writeText`. */
  writeClipboard?(text: string): Promise<void>;
  /** The page isle's rectangle, if it shows; defaults to its host's `data-et-rect`. */
  isleRect?(): Box | undefined;
}

export interface CardOptions {
  deps: SelectionRuntimeDeps;
  port: CardPort;
  env: CardEnv;
}

export type View = 'gone' | 'dot' | 'card';

/** The selection the dot or card is about. */
interface Current {
  /** Plan 1.2 rule 1: fixed once taken; the request and the source line both use it. */
  source: string;
  range?: Range;
  /** The selection's rectangles united (viewport coordinates), kept fresh on scroll. */
  rect: Box;
  /** The last character's bottom right: the dot sits just right of it (see `dotAt`). */
  anchor: { x: number; y: number };
  /**
   * Where the pointer was released (a pointer selection only). Only the hover rule reads
   * it, once, when the dot first shows: a release on the dot does not arm it.
   */
  pointer?: { x: number; y: number };
  /** No selection to follow (an iframe's text): the card sits in the upper third. */
  detached: boolean;
  detected?: DetectedLanguages;
}

type Status = 'loading' | 'partial' | 'done' | 'error' | 'too-long';

const HOST_STYLE: [string, string][] = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['pointer-events', 'none'],
  ['z-index', '2147483647'],
  ['contain', 'layout paint style'],
];

/** Shorter selections are not worth a card (the bootstrap's own minimum). */
const MIN_SOURCE_LENGTH = 2;
const DOT = 10;
/** The dot's hit area: a circle this wide around its center (styles.ts `.zn` matches). */
const ZONE_RADIUS = 14;
/** Resting on the dot this long, after coming in from outside its zone, opens it. */
const HOVER_MS = 300;
/** The card folds into the dot, which then disappears. */
const FOLD_MS = 170;
const RADIUS = 14;
const HEADER = 40;
const LIST_ROW = 34;
/** List header (28) + footer (24) + padding (10). */
const LIST_CHROME = 62;
const REDUCED_FADE_MS = 120;
const TIP_DELAY_MS = 450;
const TIP_LINGER_MS = 90;
const TIP_SWITCH_MS = 300;
/** The tip's words are cleared only once it has faded (no empty shell left behind). */
const TIP_CLEAR_MS = 160;
const TIP_GAP = 6;
const TIP_EDGE = 8;
const COPIED_MS = 1500;
/** Shown on the button that was pressed when no voice could read (speech.ts). */
const SPEECH_FAILED: NoArgKey = 'card.speechFailed';
const SPEECH_FAILED_MS = 3000;
/** Selection changes the copy fallback causes are ignored this long (debounce included). */
const QUIET_MS = 400;
/**
 * A pinned card translates a new selection in place only this soon after the user's own
 * pointer or key release: a page script moving the selection sends nothing anywhere.
 */
const GESTURE_MS = 1000;

/** Icon paths (the prototype's), one per icon. */
const PATH = {
  aura: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z',
  down: 'M2.5 4l2.5 2.5L7.5 4',
  chevron: 'M3 4.5L6 7.5 9 4.5',
  arrow: 'M2 6h8M7 3l3 3-3 3',
  copy: 'M7.3 5.5h4.4a1.8 1.8 0 0 1 1.8 1.8v4.4a1.8 1.8 0 0 1-1.8 1.8H7.3a1.8 1.8 0 0 1-1.8-1.8V7.3a1.8 1.8 0 0 1 1.8-1.8zM10.5 5.5V4.3a1.8 1.8 0 0 0-1.8-1.8H4.3a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8h1.2',
  copied: 'M3.5 8.4l3 3 6-6.4',
  speak:
    'M2.8 6.2h2.4L8.6 3.4v9.2L5.2 9.8H2.8zM10.8 6a2.8 2.8 0 0 1 0 4M12.6 4.2a5.3 5.3 0 0 1 0 7.6',
  stop: 'M6.1 4.5h3.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6H6.1a1.6 1.6 0 0 1-1.6-1.6V6.1a1.6 1.6 0 0 1 1.6-1.6z',
  // The open strokes take no fill: filling the path fills only the pin's head.
  pin: 'M5.2 2.5h5.6M6.3 2.5v4.1L4.4 9.2h7.2L9.7 6.6V2.5zM8 9.2v4.3',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  check: 'M3 7.3l2.6 2.6L11 4.5',
};
const SOLID = { fill: 'currentColor', stroke: 'none' };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The panel's names (languages.ts: English, 简体中文…) for a supported language;
 * undefined for any other, which the header shows as "Auto-detect".
 */
function languageLabel(tag: string): string | undefined {
  const code = normalizeLanguage(tag);
  return code ? languageName(code) : undefined;
}

function sameRange(a: Range | undefined, b: Range | undefined): boolean {
  if (!a || !b) return !a && !b;
  try {
    // START_TO_START = 0, END_TO_END = 2.
    return a.compareBoundaryPoints(0, b) === 0 && a.compareBoundaryPoints(2, b) === 0;
  } catch {
    return false;
  }
}

/** The page isle's host: a direct child of <html> only (a page can put an `et-isle` anywhere). */
const ISLE_HOST = `:scope > ${ISLE_TAG.toLowerCase()}`;

/** The isle host's `data-et-rect="x,y,w,h"` (written at rest), when it has an area. */
function readIsleRect(doc: Document): Box | undefined {
  const value = doc.documentElement.querySelector(ISLE_HOST)?.getAttribute('data-et-rect');
  const [x = 0, y = 0, w = 0, h = 0] = (value ?? '').split(',').map(Number);
  if (!(w > 0 && h > 0) || !Number.isFinite(x + y)) return undefined;
  return { left: x, top: y, right: x + w, bottom: y + h };
}

function unionOf(rects: Iterable<DOMRect>): Box | undefined {
  let box: Box | undefined;
  for (const rect of rects) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    box = box
      ? {
          left: Math.min(box.left, rect.left),
          top: Math.min(box.top, rect.top),
          right: Math.max(box.right, rect.right),
          bottom: Math.max(box.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return box;
}

export function createSelectionCard({ deps, port, env }: CardOptions): SelectionRuntime {
  const { win } = env;
  const doc = win.document;
  const raf = env.raf ?? ((callback: () => void) => win.requestAnimationFrame(callback));
  const cancelRaf = env.cancelRaf ?? ((handle: number) => win.cancelAnimationFrame(handle));
  const now = env.now ?? (() => win.performance.now());
  const trusted = env.isTrusted ?? ((event: Event) => event.isTrusted);
  const media = (query: string): MediaQuery | undefined =>
    env.matchMedia ? env.matchMedia(query) : win.matchMedia?.(query);
  const motionQuery = media('(prefers-reduced-motion: reduce)');
  const writeClipboard =
    env.writeClipboard ?? ((text: string) => win.navigator.clipboard.writeText(text));
  const speech = createSpeech(env.speech ?? {});

  let disposed = false;
  let config: ConfigV1 | undefined;
  const configRead = deps.getConfig().then(
    (value) => {
      config ??= value;
      if (els) renderHeader();
    },
    () => {
      // Unreadable: no language gate, the configured engine is the background's.
    },
  );
  const stopWatching = deps.watchConfig((value) => {
    config = value;
    if (els) renderAll();
  });

  // ---- State ---------------------------------------------------------------------

  let view: View = 'gone';
  /** The card is folding into the dot on its way out. */
  let closing = false;
  let pinned = false;
  let pin: { x: number; y: number } | undefined;
  let listOpen = false;
  let sourceOpen = false;
  let current: Current | undefined;
  let placement: Placement | undefined;
  /** The card's content height without the 380px limit (measured, else estimated). */
  let natural = 0;
  /** Where a pinned card folds to when closed. */
  let foldAt: { x: number; y: number } | undefined;
  /** The last closed selection: the same one never pops up again (plan 4.3 rule 8). */
  let dismissed: { source: string; range?: Range } | undefined;
  /**
   * Scrolled out of view (not closed by the user): folded away, waiting for the
   * selection to come back into view to show the dot again.
   */
  let parked: Current | undefined;
  let parkFrame = 0;
  /** "Use X this time": this card's requests only, never the config. */
  let engineOverride: Engine | undefined;
  let force = false;
  let status: Status = 'loading';
  let text = '';
  let disposition: TranslateDisposition = 'translated';
  let error: AppError | undefined;
  /** The source word's British / American IPA, shown after it on the source line. */
  let phonetic: { uk?: string; us?: string; lemma?: string } | undefined;
  let options: EngineOptions | undefined;
  let optionsFailed = false;
  let loadingEngines: Promise<void> | undefined;
  let voices: boolean | undefined;
  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The button whose reading failed: its tip says so for a while. */
  let speechFailed: HTMLElement | undefined;
  let speechFailedTimer: ReturnType<typeof setTimeout> | undefined;
  let quietUntil = Number.NEGATIVE_INFINITY;
  /** The last trusted pointerup or keyup outside the card. */
  let gestureAt = Number.NEGATIVE_INFINITY;
  const announced = { loading: 0, done: 0 };
  let detectToken = 0;
  let reduce = !!motionQuery?.matches;

  // Hover arming (plan 4.3 rule 7).
  let armed = false;
  /** Tracked only while mounted: unknown (never armed by it) after a fresh mount. */
  let pointer: { x: number; y: number } | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let foldTimer: ReturnType<typeof setTimeout> | undefined;
  let followFrame = 0;

  // Dragging a pinned card (plan 4.3 rule 9).
  let drag: { sx: number; sy: number; x0: number; y0: number; id: number } | undefined;
  let dragTo: { x: number; y: number } | undefined;
  let dragFrame = 0;

  // The hover tip (plan 1.3 rule 4).
  let tipButton: HTMLElement | undefined;
  let tipShowTimer: ReturnType<typeof setTimeout> | undefined;
  let tipHideTimer: ReturnType<typeof setTimeout> | undefined;
  let tipClearTimer: ReturnType<typeof setTimeout> | undefined;
  let tipHiddenAt = Number.NEGATIVE_INFINITY;

  /** The translation shown so far, in paragraphs; appended to while it streams. */
  let shown = '';
  let textWrap: HTMLElement | undefined;
  let caret: HTMLElement | undefined;

  const requests = createCardRequests({ port, currentSource: () => current?.source });

  const springs = {
    X: createSpring(0),
    Y: createSpring(0),
    W: createSpring(0),
    H: createSpring(0),
    R: createSpring(0),
  };
  type Key = keyof typeof springs;
  const KEYS = Object.keys(springs) as Key[];
  /** Content opacity, faded by the morph (choreograph). */
  let opacity = 0;
  let transition: { d0: number; p: number; t0: number; from: number; show: boolean } | undefined;
  let frame = 0;
  let lastT = 0;
  let viewport: Size = { w: 1, h: 1 };

  // ---- DOM ---------------------------------------------------------------------------

  let host: HTMLElement | undefined;
  type Els = ReturnType<typeof build>;
  let els: Els | undefined;
  let observer: ResizeObserver | undefined;
  /** Watches the isle's `data-et-rect` (and the isle coming or going) while the card is open. */
  let isleWatch: MutationObserver | undefined;
  let isleHost: Element | null = null;
  let isleFrame = 0;

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

  /** A `size`px icon of one stroked path (`attrs` override the stroke). */
  function icon(size: number, d: string, attrs: Record<string, string> = {}, cls = '') {
    const root = doc.createElementNS(SVG_NS, 'svg');
    const path = doc.createElementNS(SVG_NS, 'path');
    const box = String(size);
    for (const [name, value] of Object.entries({
      class: cls,
      width: box,
      height: box,
      viewBox: `0 0 ${box} ${box}`,
      fill: 'none',
      'aria-hidden': 'true',
    })) {
      root.setAttribute(name, value);
    }
    for (const [name, value] of Object.entries({
      d,
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...attrs,
    })) {
      path.setAttribute(name, value);
    }
    root.append(path);
    return root;
  }

  /** Swaps a button's icon only when it changes (renders run per streamed chunk). */
  function setIcon(target: HTMLElement, key: string, make: () => SVGSVGElement) {
    if (target.getAttribute('data-i') === key) return;
    target.setAttribute('data-i', key);
    target.replaceChildren(make());
  }

  const button = (cls: string, act: string, attrs: Record<string, string> = {}) =>
    node('button', { type: 'button', class: cls, tabindex: '-1', 'data-act': act, ...attrs });

  function build(shadow: ShadowRoot) {
    const root = node('div', { class: 'r', 'data-view': 'gone' });
    const aura = node('div', { class: 'au' }, icon(24, PATH.aura, { ...SOLID, opacity: '.24' }));
    const shadowLayer = node('div', { class: 'sh' });
    const tint = node('span', { class: 'tn' });
    const direction = node('span', { class: 'dir', id: 'd' });
    const engine = button('eb', 'engine', {
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'data-tip': 'up',
    });
    const engineText = node('span');
    engine.append(engineText, icon(10, PATH.down));
    const header = node(
      'div',
      { class: 'hd' },
      direction,
      node('span', { class: 'dg', 'aria-hidden': 'true' }),
      engine,
    );
    // The word is the expand button; the phonetic buttons sit beside it (never inside a
    // button), the label and the chevron expand too.
    const sourceText = button('st', 'source', { 'aria-expanded': 'false' });
    // Phonetics are shown for English words only: not the host's UI language.
    const phoneticText = node('span', { class: 'ph', lang: 'en' });
    const chevron = icon(12, PATH.chevron, {}, 'sc');
    chevron.setAttribute('data-act', 'source');
    const sourceLine = node(
      'div',
      { class: 'src' },
      node('span', { class: 'k', 'data-act': 'source' }, message('card.source')),
      node('span', { class: 'sw' }, sourceText, phoneticText),
      chevron,
    );
    const content = node('div');
    const inner = node('div', { class: 'bi' }, sourceLine, content);
    const body = node('div', { class: 'bd' }, inner);
    const copy = button('ib', 'copy', { 'data-tip': 'down' });
    const speak = button('ib', 'speak', { 'data-tip': 'down', 'aria-pressed': 'false' });
    const pinButton = button('ib', 'pin', { 'data-tip': 'down', 'aria-pressed': 'false' });
    const pinIcon = icon(16, PATH.pin);
    const pinPath = pinIcon.firstElementChild as SVGPathElement;
    pinButton.append(pinIcon);
    const close = button('ib', 'close', {
      'data-tip': 'down',
      'aria-label': message('card.close'),
    });
    close.append(icon(16, PATH.close, { 'stroke-width': '1.5' }));
    const footer = node(
      'div',
      { class: 'ft' },
      copy,
      speak,
      node('span', { class: 'fs' }),
      pinButton,
      close,
    );
    const rows = node('div', { class: 'op', role: 'listbox', 'aria-labelledby': 'l' });
    const list = node(
      'div',
      { class: 'ls', 'aria-hidden': 'true' },
      node('div', { class: 'lh', id: 'l' }, message('card.listTitle')),
      rows,
      node('div', { class: 'lf' }, message('card.listNote')),
    );
    const card = node(
      'div',
      { class: 'cn', role: 'dialog', 'aria-labelledby': 'd' },
      header,
      body,
      footer,
      list,
    );
    const wrap = node('div', { class: 'cw' }, card);
    const shell = node('div', { class: 'sl' }, tint, wrap);
    const zone = node('span', { class: 'zn', 'aria-hidden': 'true' });
    const tip = node('span', { class: 'tp', 'aria-hidden': 'true' });
    const live = node('span', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    root.append(aura, shadowLayer, shell, zone, tip, live);
    shadow.append(root);
    return {
      root,
      aura,
      shadowLayer,
      shell,
      tint,
      wrap,
      card,
      header,
      direction,
      engine,
      engineText,
      body,
      inner,
      sourceLine,
      sourceText,
      phoneticText,
      content,
      copy,
      speak,
      pin: pinButton,
      pinPath,
      close,
      list,
      rows,
      zone,
      tip,
      live,
    };
  }

  function adoptStyles(shadow: ShadowRoot) {
    const css = `${isleTokens}\n${CARD_CSS}`;
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

  function setAttr(element: Element, name: string, value: string) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function mount() {
    if (host) return;
    const element = doc.createElement(SELECTION_TAG.toLowerCase());
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
    viewport = readViewport();
    for (const key of KEYS) snap(springs[key], 0);
    opacity = 0;
    transition = undefined;
    const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      observer = new Observer(() => measure());
      observer.observe(els.card);
      observer.observe(els.inner);
    }
    listen();
  }

  function watchIsle() {
    if (isleWatch) return;
    const Observer = (win as Window & { MutationObserver?: typeof MutationObserver })
      .MutationObserver;
    if (!Observer) return;
    isleWatch = new Observer((records) => {
      const next = doc.documentElement.querySelector(ISLE_HOST);
      // Our own host being raised is a childList change too: only the isle's count.
      if (next === isleHost && records.every((record) => record.type !== 'attributes')) return;
      if (next !== isleHost) observeIsle(next);
      // No layout read here: the card is re-placed once, in the next frame.
      if (!isleFrame) isleFrame = raf(onIsleMoved);
    });
    observeIsle(doc.documentElement.querySelector(ISLE_HOST));
  }

  function observeIsle(next: Element | null) {
    if (!isleWatch) return;
    isleWatch.disconnect();
    isleHost = next;
    isleWatch.observe(doc.documentElement, { childList: true });
    if (next) isleWatch.observe(next, { attributeFilter: ['data-et-rect'] });
  }

  function unwatchIsle() {
    isleWatch?.disconnect();
    isleWatch = undefined;
    isleHost = null;
    if (isleFrame) cancelRaf(isleFrame);
    isleFrame = 0;
  }

  function onIsleMoved() {
    isleFrame = 0;
    const cur = current;
    // A pinned or detached card does not sit beside the selection: the isle is not its concern.
    if (view !== 'card' || closing || pin || !cur || cur.detached) return;
    placement = placeFor(cur.rect);
    sizeCard();
    aim(GROW);
  }

  function unmount() {
    unwatchIsle();
    unlisten();
    // Moves while unmounted (the drag that made the next selection) were not seen.
    pointer = undefined;
    observer?.disconnect();
    observer = undefined;
    if (frame) cancelRaf(frame);
    frame = 0;
    lastT = 0;
    resetTip();
    host?.remove();
    host = undefined;
    els = undefined;
  }

  /** Every card open puts the host last, above the page isle (plan 4.3 rule 3). */
  function raise() {
    if (host && doc.documentElement.lastElementChild !== host) doc.documentElement.append(host);
  }

  function readViewport(): Size {
    const root = doc.documentElement;
    const w = Math.min(root.clientWidth || win.innerWidth, win.innerWidth || root.clientWidth);
    const h = Math.min(root.clientHeight || win.innerHeight, win.innerHeight || root.clientHeight);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  /** Light or dark, judged by the page under (x, y) as the isle does; always written. */
  function probe(x: number, y: number) {
    if (!host) return;
    const penv: ProbeEnv = {
      elementsFromPoint:
        env.elementsFromPoint ?? ((px: number, py: number) => doc.elementsFromPoint(px, py)),
      getComputedStyle:
        env.getComputedStyle ?? ((element: Element) => win.getComputedStyle(element)),
      host,
      prefersDark: () => !!media('(prefers-color-scheme: dark)')?.matches,
    };
    let theme: 'light' | 'dark' = 'light';
    try {
      theme = probeTheme(penv, x, y, doc.documentElement);
    } catch {
      // Hit testing broken by the page: light.
    }
    host.setAttribute('data-et-theme', theme);
  }

  // ---- Geometry ------------------------------------------------------------------------

  /**
   * The dot's center: the bottom right of the last character (plan 1.3 rule 5), on its
   * line's bottom edge. It never moves for the pointer; the card's top corner is this point.
   */
  function dotCenter(): { x: number; y: number } {
    return dotAt(current?.anchor ?? { x: 0, y: 0 }, viewport);
  }

  /** Whether `at` is inside the dot's round hit zone. */
  function onDot(at: { x: number; y: number }): boolean {
    const center = dotCenter();
    return Math.hypot(at.x - center.x, at.y - center.y) <= ZONE_RADIUS;
  }

  /** The card with a top corner on the dot beside the selection `box`, clear of the page isle. */
  function placeFor(box: Box): Placement {
    let isle: Box | undefined;
    try {
      isle = env.isleRect ? env.isleRect() : readIsleRect(doc);
    } catch {
      // Unreadable: no isle to avoid.
    }
    return placeCard(box, dotCenter(), natural, viewport, isle);
  }

  function listHeight(): number {
    const measured = els?.list.offsetHeight ?? 0;
    return measured > 0 ? measured : LIST_CHROME + LIST_ROW * (options?.options.length ?? 4);
  }

  function cardRect(): { x: number; y: number; w: number; h: number } {
    const place = placement ?? placeDetached(natural, viewport);
    const content = listOpen ? Math.max(natural, HEADER + listHeight()) : natural;
    const h = Math.min(content, place.maxH);
    if (pin) return { x: pin.x, y: pin.y, w: place.w, h };
    const box = current?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 };
    return { x: place.x, y: cardTop(box, dotCenter(), place, h, viewport), w: place.w, h };
  }

  /** The shape the springs head for in the current view. */
  function target(): { x: number; y: number; w: number; h: number; r: number } {
    if (view === 'card') return { ...cardRect(), r: RADIUS };
    const point = foldAt ?? dotCenter();
    if (view === 'dot')
      return { x: point.x - DOT / 2, y: point.y - DOT / 2, w: DOT, h: DOT, r: DOT / 2 };
    return { x: point.x, y: point.y, w: 0, h: 0, r: 0 };
  }

  /** Points the springs at the current view's shape. `from` starts a shape from a point. */
  function aim(params = GROW, from?: { x: number; y: number }) {
    const goal = target();
    if (from) {
      snap(springs.X, from.x);
      snap(springs.Y, from.y);
      snap(springs.W, 0);
      snap(springs.H, 0);
      snap(springs.R, 0);
    }
    const values: Record<Key, number> = { X: goal.x, Y: goal.y, W: goal.w, H: goal.h, R: goal.r };
    for (const key of KEYS) {
      retarget(springs[key], values[key], params);
      if (reduce) snap(springs[key], values[key]);
    }
    kick();
  }

  /** Moves the whole shape by (dx, dy) at once (the page scrolled under it). */
  function shift(dx: number, dy: number) {
    springs.X.x += dx;
    springs.X.t += dx;
    springs.Y.x += dy;
    springs.Y.t += dy;
    kick();
  }

  function setView(next: View, params: typeof GROW, from?: { x: number; y: number }) {
    if (!els) return;
    const changed = next !== view;
    view = next;
    if (changed) {
      const show = next === 'card';
      const goal = target();
      transition = {
        d0:
          Math.abs((from?.x ?? springs.X.x) - goal.x) +
          Math.abs((from?.y ?? springs.Y.x) - goal.y) +
          Math.abs((from ? 0 : springs.W.x) - goal.w) +
          Math.abs((from ? 0 : springs.H.x) - goal.h),
        p: 0,
        t0: now(),
        from: opacity,
        show,
      };
      els.root.setAttribute('data-view', next);
      if (show) watchIsle();
      else {
        unwatchIsle();
        hideTip();
        setList(false);
      }
    }
    syncOpen();
    aim(params, from);
    placeZone();
  }

  /** The dot or the card shows (not folding away): a layer above the page isle. */
  const layerOpen = () => view === 'card' || (view === 'dot' && !closing);

  /**
   * `data-open` on the host: the selection layer is visible (plan 4.3 rule 8). The isle
   * leaves an Escape to it then, so one Escape closes only the top layer.
   */
  function syncOpen() {
    if (!host) return;
    if (layerOpen()) host.setAttribute('data-open', '');
    else if (host.hasAttribute('data-open')) {
      // Removed after this event: the isle, handling the same Escape, must still see
      // the layer open and leave its own alone (one Escape, one layer).
      const element = host;
      setTimeout(() => {
        if (host !== element || !layerOpen()) element.removeAttribute('data-open');
      }, 0);
    }
  }

  function placeZone() {
    if (!els) return;
    const center = dotCenter();
    els.zone.style.left = `${round2(center.x - ZONE_RADIUS)}px`;
    els.zone.style.top = `${round2(center.y - ZONE_RADIUS)}px`;
  }

  /** Content height without the limit: the card minus the body's visible part plus all of it. */
  function measure() {
    if (!els || view === 'gone') return;
    const { card, body } = els;
    const measured = Math.ceil(card.offsetHeight - body.clientHeight + body.scrollHeight);
    const next = measured > 0 ? measured : estimateHeight(current?.source.length ?? 0);
    els.body.toggleAttribute(
      'data-more',
      body.scrollHeight - body.scrollTop - body.clientHeight > 4,
    );
    if (next === natural) return;
    natural = next;
    if (view === 'card' && !closing && !drag) aim(GROW);
  }

  // ---- Frame loop ----------------------------------------------------------------------

  function kick() {
    if (!els || frame) return;
    frame = raf(tick);
  }

  function tick() {
    frame = 0;
    const t = now();
    const dt = lastT ? Math.min((t - lastT) / 1000, 1 / 30) : 1 / 60;
    lastT = t;
    let rest = true;
    for (const key of KEYS) if (!step(springs[key], dt)) rest = false;
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
      const d = (['X', 'Y', 'W', 'H'] as const).reduce(
        (sum, key) => sum + Math.abs(springs[key].x - springs[key].t),
        0,
      );
      p = tr.d0 < 0.5 ? 1 : Math.max(tr.p, clamp01(1 - d / tr.d0));
    }
    tr.p = p;
    if (reduce) opacity = tr.from + ((tr.show ? 1 : 0) - tr.from) * p;
    else if (tr.show)
      opacity = tr.from >= 0.999 ? 1 : tr.from + (1 - tr.from) * clamp01((p - 0.4) / 0.6);
    else opacity = tr.from * (1 - clamp01(p / 0.35));
    if (p >= 1) transition = undefined;
  }

  function draw() {
    if (!els) return;
    const X = springs.X.x;
    const Y = springs.Y.x;
    const W = Math.max(0, springs.W.x);
    const H = Math.max(0, springs.H.x);
    const R = Math.max(0, Math.min(springs.R.x, Math.min(W, H) / 2));
    const { shell, shadowLayer, aura, tint, wrap } = els;
    shell.style.clipPath =
      W <= 0 || H <= 0
        ? 'inset(50%)'
        : `inset(${round2(Y)}px ${round2(viewport.w - X - W)}px ${round2(viewport.h - Y - H)}px ${round2(X)}px round ${round2(R)}px)`;
    const m = Math.min(W, H);
    const grown = clamp01((m - DOT) / 24);
    tint.style.opacity = String(round2(clamp01(1 - grown * 1.6)));
    const shadowStyle = shadowLayer.style;
    shadowStyle.left = `${round2(X)}px`;
    shadowStyle.top = `${round2(Y)}px`;
    shadowStyle.width = `${round2(W)}px`;
    shadowStyle.height = `${round2(H)}px`;
    shadowStyle.borderRadius = `${round2(R)}px`;
    shadowStyle.opacity = String(round2(grown));
    const scale = clamp01(m / DOT);
    aura.style.transform = `translate(${round2(X + W / 2 - 12)}px,${round2(Y + H / 2 - 12)}px) scale(${round2(scale)})`;
    aura.style.opacity = String(round2((1 - clamp01(grown * 3)) * scale));
    wrap.style.transform = `translate(${round2(X)}px,${round2(Y)}px)`;
    wrap.style.opacity = String(round2(opacity));
    wrap.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
  }

  function settle() {
    if (view === 'gone') {
      foldAt = undefined;
      unmount();
      // Folded away while parked: the page may already have scrolled back.
      onParkedScroll();
    }
  }

  // ---- Content ---------------------------------------------------------------------------

  function currentEngine(): Engine | undefined {
    return engineOverride ?? config?.translation.engine ?? options?.configured;
  }

  function targetLanguage(): LanguageCode | undefined {
    return config?.language.target;
  }

  function renderHeader() {
    if (!els) return;
    const { direction, engine, engineText } = els;
    const from = reliableLanguage(current?.detected);
    const to = targetLanguage();
    const fromLabel = (from && languageLabel(from)) ?? message('common.autoDetect');
    const toLabel = to ? languageName(to) : '';
    direction.replaceChildren(
      fromLabel,
      icon(12, PATH.arrow),
      node('span', { class: 'sr' }, '→'),
      toLabel,
    );
    const id = currentEngine();
    const option = options?.options.find((item) => item.id === id);
    showMark(doc, engineText, option);
    setAttr(engine, 'aria-label', message('card.engineSwitch', option?.name ?? ''));
    setAttr(engine, 'aria-expanded', String(listOpen));
  }

  function paragraphs(value: string, into: HTMLElement) {
    const lines = value.split('\n');
    lines.forEach((line, index) => {
      let paragraph = into.lastElementChild as HTMLElement | null;
      if (index > 0 || !paragraph) {
        paragraph = node('p', { class: 'tx' });
        into.append(paragraph);
      }
      if (line) paragraph.append(node('span', { class: 'ch' }, line));
    });
  }

  function renderText(value: string, streaming: boolean) {
    if (!els) return;
    if (!textWrap || !els.content.contains(textWrap) || !value.startsWith(shown)) {
      // The translation is in the target language, whatever the card's own is.
      textWrap = node('div', { class: 'tw', lang: targetLanguage() ?? '' });
      els.content.replaceChildren(textWrap);
      shown = '';
    }
    if (value !== shown) paragraphs(value.slice(shown.length), textWrap);
    shown = value;
    caret?.remove();
    caret = undefined;
    if (streaming) {
      caret = node('span', { class: 'cr', 'aria-hidden': 'true' });
      (textWrap.lastElementChild ?? textWrap).append(caret);
      const { body } = els;
      // Follow the end while it streams, unless the reader scrolled up.
      if (body.scrollHeight - body.scrollTop - body.clientHeight < 24)
        body.scrollTop = body.scrollHeight;
    }
  }

  /** "lemma 英 /…/ 🔈 美 /…/ 🔈", rebuilt only when the phonetic changes. */
  function renderPhonetic(into: HTMLElement) {
    const key = phonetic ? `${phonetic.lemma}|${phonetic.uk}|${phonetic.us}` : '';
    if (into.getAttribute('data-k') === key) return;
    into.setAttribute('data-k', key);
    const blocks: HTMLElement[] = [];
    if (phonetic?.lemma) blocks.push(node('span', { class: 'lm' }, phonetic.lemma));
    for (const [accent, label, name] of [
      ['uk', 'UK', 'card.accentUk'],
      ['us', 'US', 'card.accentUs'],
    ] as const) {
      const ipa = phonetic?.[accent];
      if (!ipa) continue;
      const say = button('pb', 'say', {
        'data-l': accent,
        'aria-label': message('card.sayPhonetic', message(name), ipa),
      });
      say.append(node('span', { class: 'pl' }, label), `/${ipa}/`, icon(16, PATH.speak));
      blocks.push(say);
    }
    into.replaceChildren(...blocks);
  }

  function renderNotice(words: string) {
    els?.content.replaceChildren(node('p', { class: 'nc' }, words));
    textWrap = undefined;
    shown = '';
  }

  function renderBody() {
    if (!els || !current) return;
    const { sourceLine, sourceText, phoneticText, content } = els;
    if (sourceText.textContent !== current.source) sourceText.textContent = current.source;
    // The selected text is in its own language; unknown when the detection is unsure.
    setAttr(sourceText, 'lang', reliableLanguage(current.detected) ?? '');
    renderPhonetic(phoneticText);
    setAttr(sourceText, 'aria-expanded', String(sourceOpen));
    sourceLine.toggleAttribute('data-open', sourceOpen);
    if (status === 'loading') {
      textWrap = undefined;
      shown = '';
      content.replaceChildren(
        node(
          'div',
          { class: 'sk', 'aria-hidden': 'true' },
          node('span', { style: 'width:92%' }),
          node('span', { style: 'width:58%' }),
        ),
      );
    } else if (status === 'partial') renderText(text, true);
    else if (status === 'too-long') {
      renderNotice(
        message(
          'card.tooLong',
          MAX_SOURCE_LENGTH.toLocaleString(uiLocale(), { useGrouping: 'min2' }),
        ),
      );
    } else if (status === 'error') {
      textWrap = undefined;
      shown = '';
      const actions = node('div', { class: 'ea' }, button('bt', 'retry'));
      (actions.firstElementChild as HTMLElement).textContent = message('common.retry');
      if (currentEngine() !== 'google') {
        const google = button('bt ba', 'google');
        google.textContent = message('common.useGoogleOnce', message('engine.googleName'));
        actions.append(google);
      }
      content.replaceChildren(
        node(
          'div',
          { class: 'er', role: 'alert' },
          node('span', { class: 'ed', 'aria-hidden': 'true' }),
          node('div', {}, node('div', {}, error ? errorText(error) : ''), actions),
        ),
      );
    } else if (disposition === 'same-language') {
      const to = targetLanguage();
      renderNotice(message('card.alreadyIn', to ? languageName(to) : ''));
    } else if (disposition === 'unchanged') renderNotice(message('card.unchanged'));
    else renderText(text, false);
  }

  function renderFooter() {
    if (!els) return;
    const { copy, speak, pin: pinButton, pinPath } = els;
    const canCopy = status === 'done' && disposition === 'translated' && !!text;
    setAttr(copy, 'aria-disabled', String(!canCopy));
    setAttr(copy, 'aria-label', message(copied ? 'card.copied' : 'card.copy'));
    copy.toggleAttribute('data-ok', copied);
    setIcon(copy, copied ? 'ok' : 'copy', () =>
      copied ? icon(16, PATH.copied, { 'stroke-width': '1.6' }) : icon(16, PATH.copy),
    );
    const speaking = speech.speaking();
    setAttr(speak, 'aria-pressed', String(speaking));
    setAttr(speak, 'aria-disabled', String(voices === false));
    setAttr(
      speak,
      'aria-label',
      message(voices === false ? 'card.noVoice' : speaking ? 'card.speakStop' : 'card.speak'),
    );
    setIcon(speak, speaking ? 'stop' : 'speak', () =>
      speaking ? icon(16, PATH.stop, SOLID) : icon(16, PATH.speak),
    );
    setAttr(pinButton, 'aria-pressed', String(pinned));
    setAttr(pinButton, 'aria-label', message(pinned ? 'card.unpin' : 'card.pin'));
    setAttr(pinPath, 'fill', pinned ? 'currentColor' : 'none');
    els.root.toggleAttribute('data-pin', pinned);
    // A showing tip follows its button's words ("Copied", "Stop reading").
    if (tipButton && els.tip.textContent) {
      if (tipWords(tipButton) !== els.tip.textContent) placeTip();
    }
  }

  function renderList() {
    if (!els) return;
    const id = currentEngine();
    const rows: HTMLElement[] = [];
    if (!options) {
      if (optionsFailed) rows.push(node('div', { class: 'lh' }, message('card.listFailed')));
    } else {
      for (const option of options.options) {
        const selected = option.id === id;
        const row = button('o', 'pick', {
          role: 'option',
          'aria-selected': String(selected),
          'data-id': option.id,
        });
        row.disabled = !option.ready || !listOpen;
        row.append(engineMark(doc, option), node('span', { class: 'nm' }, option.name));
        if (selected) {
          row.append(icon(14, PATH.check, { 'stroke-width': '1.6' }, 'cm'));
        } else if (!option.ready && option.note) {
          row.append(node('span', { class: 'no' }, option.note));
        }
        rows.push(row);
      }
    }
    els.rows.replaceChildren(...rows);
    els.list.style.maxHeight = `${Math.max(80, (placement?.maxH ?? CARD_MAX_HEIGHT) - HEADER)}px`;
  }

  function renderAll() {
    renderHeader();
    renderBody();
    renderFooter();
    renderList();
    sizeCard();
  }

  function sizeCard() {
    if (els && placement) els.card.style.maxHeight = `${placement.maxH}px`;
    if (els && placement) els.wrap.style.width = `${placement.w}px`;
  }

  function announce(words: string) {
    const live = els?.live;
    if (!live) return;
    // Emptied first, filled on the next frame: a region filled at once is not read.
    live.textContent = '';
    raf(() => {
      if (els?.live === live) live.textContent = words;
    });
  }

  function setList(open: boolean) {
    if (listOpen === open) return;
    listOpen = open;
    if (!els) return;
    els.root.toggleAttribute('data-list', open);
    els.list.setAttribute('aria-hidden', String(!open));
    if (open) {
      hideTip();
      void loadEngines();
    }
    renderHeader();
    renderList();
    if (view === 'card' && !closing) aim(GROW);
  }

  function loadEngines(): Promise<void> {
    loadingEngines ??= deps
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
        loadingEngines = undefined;
        renderHeader();
        renderList();
      });
    return loadingEngines;
  }

  // ---- Requests --------------------------------------------------------------------------

  function onRequest(id: number, event: RequestEvent) {
    // A request the card moved on from (the request module drops those too).
    if (id !== 0 && id !== requests.current()) return;
    if (event.kind === 'phonetic') {
      // Beside the source, whatever the translation is doing.
      phonetic = event;
      renderBody();
      measure();
      return;
    }
    error = undefined;
    if (event.kind === 'loading') {
      // First words, or a retry's reset: anything shown so far is void.
      status = 'loading';
      text = '';
      if (announced.loading !== id) {
        announced.loading = id;
        announce(message('card.translating'));
      }
    } else if (event.kind === 'partial') {
      status = 'partial';
      text = event.text;
    } else if (event.kind === 'done') {
      status = 'done';
      disposition = event.disposition;
      // Plan 1.2 rule 7: unless translated, the text is the source; it is never shown as one.
      text = event.disposition === 'translated' ? event.text : '';
      if (event.disposition !== 'translated') sourceOpen = true;
      if (announced.done !== id) {
        announced.done = id;
        announce(message('card.translated'));
      }
    } else if (event.kind === 'error') {
      // Plan 1.2 rule 6: a failure also clears what had streamed.
      status = 'error';
      text = '';
      error = event.error;
    } else status = 'too-long';
    renderBody();
    renderFooter();
    measure();
  }

  function translate() {
    if (!current) return;
    status = 'loading';
    text = '';
    disposition = 'translated';
    phonetic = undefined;
    copied = false;
    speech.stop();
    if (els) els.body.scrollTop = 0;
    const args = {
      source: current.source,
      engine: engineOverride,
      force,
      phonetic: wantsPhonetic({
        source: current.source,
        target: targetLanguage(),
        detected: reliableLanguage(current.detected),
        pageLanguage: doc.documentElement.lang,
      }),
    };
    // Events can arrive synchronously (too long, loading): number them once it is known.
    let id = 0;
    const early: RequestEvent[] = [];
    id = requests.translate(args, (event) => {
      if (id === 0 && event.kind !== 'too-long') early.push(event);
      else onRequest(id, event);
    });
    for (const event of early) onRequest(id, event);
  }

  // ---- Selections --------------------------------------------------------------------------

  /**
   * Plan 4.3 rule 1: the one source of a selection, for every path (dot, menu, shortcut,
   * a pinned card's new selection). The visible text when there is any; otherwise (only
   * a ruby reading selected, say) the normalized `toString()`, which the snapshot holds.
   */
  function sourceOf(snapshot: SelectionSnapshot): string {
    const { range, source } = snapshot;
    // Too long to translate whatever it holds: not worth walking.
    if (!range || source.length > MAX_SOURCE_LENGTH * 2) return source;
    try {
      return extractText(range, win, source) || source;
    } catch {
      return source;
    }
  }

  /** A selection inside the card itself (its text is selectable): never a new selection. */
  function isOwn(range: Range | undefined): boolean {
    if (!range || !host?.isConnected) return false;
    try {
      return range.intersectsNode(host);
    } catch {
      return false;
    }
  }

  function same(a: { source: string; range?: Range } | undefined, source: string, range?: Range) {
    return !!a && a.source === source && sameRange(a.range, range);
  }

  async function detect(source: string): Promise<DetectedLanguages | undefined> {
    try {
      return await deps.detectLanguage(source);
    } catch {
      return undefined;
    }
  }

  function take(snapshot: SelectionSnapshot | undefined, source: string): Current {
    unpark();
    speech.stop();
    clearSpeechFailed();
    phonetic = undefined;
    const rect = snapshot?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const anchor = snapshot?.anchor ?? { x: 0, y: 0 };
    const released = snapshot?.pointer;
    const pointerAt =
      released && Number.isFinite(released.x) && Number.isFinite(released.y)
        ? { x: released.x, y: released.y }
        : undefined;
    return {
      source,
      range: snapshot?.range,
      rect,
      anchor,
      pointer: pointerAt,
      detached: !snapshot,
    };
  }

  /** Detects the source language for the header and the voice (not a gate here). */
  function detectFor(target: Current) {
    void detect(target.source).then((result) => {
      if (current !== target) return;
      target.detected = result;
      renderHeader();
    });
  }

  function showDotView() {
    if (!current) return;
    // A rest on the old dot must not open the card on the new selection.
    clearTimeout(hoverTimer);
    requests.cancel();
    pin = undefined;
    pinned = false;
    closing = false;
    clearTimeout(foldTimer);
    foldAt = undefined;
    mount();
    viewport = readViewport();
    const center = dotCenter();
    probe(center.x, center.y);
    // Hover opens once the pointer comes in from outside its 14px circle: a pointer
    // already in it (a release on the last character, or nowhere known) must be seen
    // outside it first.
    // The release position counts only for the dot's first showing: stale afterwards.
    const seen = pointer ?? current.pointer;
    current.pointer = undefined;
    armed = !!seen && !onDot(seen);
    const from = view === 'gone' ? center : undefined;
    setView('dot', view === 'card' ? SHRINK : GROW, from);
  }

  function hideDotView() {
    clearTimeout(hoverTimer);
    if (view !== 'dot' || closing) return;
    setView('gone', SHRINK);
  }

  function openCard() {
    if (!current) return;
    clearTimeout(hoverTimer);
    clearTimeout(foldTimer);
    closing = false;
    const wasGone = view === 'gone';
    mount();
    raise();
    viewport = readViewport();
    const cur = current;
    natural = estimateHeight(cur.source.length);
    placement = cur.detached ? placeDetached(natural, viewport) : placeFor(cur.rect);
    pin = undefined;
    pinned = false;
    sourceOpen = false;
    // A new card: "这次用 X" was the last card's.
    engineOverride = undefined;
    setList(false);
    const center = dotCenter();
    if (cur.detached) probe(placement.x + placement.w / 2, placement.y + 20);
    else probe(center.x, center.y);
    renderAll();
    translate();
    void loadEngines();
    if (voices === undefined) {
      void speech.available().then((ok) => {
        voices = ok;
        renderFooter();
      });
    }
    // From nothing it grows out of a point: the selection's end, or for a card with no
    // selection the middle of its own top edge (plan 4.3 rule 6).
    const from = wasGone
      ? cur.detached
        ? { x: placement.x + placement.w / 2, y: placement.y }
        : center
      : undefined;
    setView('card', GROW, from);
    measure();
  }

  /**
   * Folds the card into the dot, then away; or removes the dot. Closed by the user
   * (`remember`): the same selection never pops up again; scrolled away: it may.
   */
  function close(remember = true) {
    if (view === 'gone' || closing) return;
    requests.cancel();
    speech.stop();
    clearSpeechFailed();
    hideTip();
    clearTimeout(hoverTimer);
    if (current && remember) dismissed = { source: current.source, range: current.range };
    if (view !== 'card') {
      setView('gone', SHRINK);
      return;
    }
    if (pin || current?.detached) {
      const rect = cardRect();
      foldAt = { x: rect.x + rect.w / 2, y: rect.y + 20 };
    }
    pinned = false;
    pin = undefined;
    drag = undefined;
    closing = true;
    setView('dot', SHRINK);
    renderFooter();
    foldTimer = setTimeout(
      () => {
        if (closing && view === 'dot') {
          closing = false;
          setView('gone', SHRINK);
        }
      },
      reduce ? 0 : FOLD_MS,
    );
  }

  /** Moves `cur`'s rectangle and dot anchor to `box`; returns how far it moved. */
  function track(cur: Current, box: Box): { dx: number; dy: number } {
    const dx = box.right - cur.rect.right;
    const dy = box.top - cur.rect.top;
    cur.rect = box;
    cur.anchor = { x: cur.anchor.x + dx, y: cur.anchor.y + dy };
    return { dx, dy };
  }

  /**
   * The page scrolled: the dot and an unpinned card follow the selection. Out of view,
   * they fold away and park (not a close: the selection may come back).
   */
  function follow() {
    followFrame = 0;
    const cur = current;
    if (!cur?.range || view === 'gone' || closing || pin) return;
    const box = unionOf(cur.range.getClientRects?.() ?? []);
    viewport = readViewport();
    if (!box || isOutOfView(box, viewport)) {
      close(false);
      park(cur);
      return;
    }
    if (box.right === cur.rect.right && box.top === cur.rect.top) return;
    const before = target();
    const { dx } = track(cur, box);
    if (placement && placement.side !== 'fixed') placement = { ...placement, x: placement.x + dx };
    const after = target();
    placeZone();
    shift(after.x - before.x, after.y - before.y);
    // Moved under a resting pointer: Chrome sends pointerenter without the pointer moving.
    // That is no visit; it must be seen leaving first, as when the dot appears.
    if (view === 'dot' && pointer && onDot(pointer)) {
      armed = false;
      clearTimeout(hoverTimer);
    }
  }

  /** Watches (passively, one read per frame at most) for the selection to come back. */
  function park(cur: Current) {
    if (parked) return;
    parked = cur;
    win.addEventListener('scroll', onParkedScroll, { capture: true, passive: true });
    win.addEventListener('resize', onParkedScroll, { passive: true });
  }

  function unpark() {
    if (!parked) return;
    parked = undefined;
    if (parkFrame) cancelRaf(parkFrame);
    parkFrame = 0;
    win.removeEventListener('scroll', onParkedScroll, true);
    win.removeEventListener('resize', onParkedScroll);
  }

  function checkParked() {
    parkFrame = 0;
    const cur = parked;
    if (!cur?.range || cur !== current) return unpark();
    // Still folding: the next scroll looks again.
    if (view !== 'gone') return;
    const box = unionOf(cur.range.getClientRects?.() ?? []);
    viewport = readViewport();
    if (!box || isOutOfView(box, viewport)) return;
    unpark();
    track(cur, box);
    // Back in view: the dot only; the card (and its request) waits for the user.
    showDotView();
  }

  // ---- Pinning and dragging ---------------------------------------------------------------

  function togglePin() {
    if (view !== 'card' || closing) return;
    if (!pinned) {
      const rect = cardRect();
      pinned = true;
      const kept = clampPinned(rect.x, rect.y, rect.w, viewport);
      pin = { x: kept.x, y: kept.y };
      if (placement) placement = { ...placement, maxH: kept.maxH };
    } else {
      pinned = false;
      const box = current?.range ? unionOf(current.range.getClientRects?.() ?? []) : undefined;
      if (current && box && !isOutOfView(box, viewport)) {
        // Scrolled while pinned: the dot (and so the card's corner) moves with it.
        track(current, box);
        placement = placeFor(box);
      } else if (pin && placement) {
        // Nothing left to follow: it stays where it is.
        placement = { ...placement, x: pin.x, y: pin.y, side: 'fixed' };
      }
      pin = undefined;
    }
    renderAll();
    aim(GROW);
  }

  function applyDrag() {
    dragFrame = 0;
    if (!drag || !dragTo || !placement) return;
    const kept = clampPinned(
      drag.x0 + dragTo.x - drag.sx,
      drag.y0 + dragTo.y - drag.sy,
      placement.w,
      viewport,
    );
    pin = { x: kept.x, y: kept.y };
    if (kept.maxH !== placement.maxH) {
      placement = { ...placement, maxH: kept.maxH };
      if (els) els.card.style.maxHeight = `${kept.maxH}px`;
    }
    const goal = target();
    snap(springs.X, goal.x);
    snap(springs.Y, goal.y);
    retarget(springs.H, goal.h, GROW);
    kick();
  }

  // ---- Tip --------------------------------------------------------------------------------

  function tipIn(target: HTMLElement) {
    if (view !== 'card' || closing || listOpen || drag) return;
    clearTimeout(tipShowTimer);
    if ((tipButton && els?.tip.textContent) || now() - tipHiddenAt < TIP_SWITCH_MS) showTip(target);
    else tipShowTimer = setTimeout(() => showTip(target), TIP_DELAY_MS);
  }

  function tipOut() {
    clearTimeout(tipShowTimer);
    if (!tipButton) return;
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(hideTip, TIP_LINGER_MS);
  }

  function showTip(target: HTMLElement) {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    clearTimeout(tipClearTimer);
    if (!els || view !== 'card' || target.getAttribute('aria-expanded') === 'true') return;
    tipButton = target;
    placeTip();
  }

  /**
   * Outside the card (plan 1.3 rule 4): the footer's tips below their button, the
   * engine button's above; flipped when there is no room, kept 8px inside the viewport.
   */
  function placeTip() {
    if (!els || !tipButton) return;
    const { tip } = els;
    tip.textContent = tipWords(tipButton);
    const box = tipButton.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const up = tipButton.getAttribute('data-tip') === 'up';
    let top = up ? box.top - TIP_GAP - h : box.bottom + TIP_GAP;
    if (up && top < TIP_EDGE) top = box.bottom + TIP_GAP;
    if (!up && top + h > viewport.h - TIP_EDGE) top = box.top - TIP_GAP - h;
    const left = Math.max(
      TIP_EDGE,
      Math.min(viewport.w - TIP_EDGE - w, box.left + box.width / 2 - w / 2),
    );
    tip.style.left = `${round2(left)}px`;
    tip.style.top = `${round2(top)}px`;
    tip.style.opacity = '1';
  }

  /** A button's tip: its label, or that its reading just failed. */
  function tipWords(target: HTMLElement): string {
    return target === speechFailed
      ? message(SPEECH_FAILED)
      : (target.getAttribute('aria-label') ?? '');
  }

  /** Fades out at once; the words stay until it is transparent, then go (no empty shell). */
  function hideTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    if (tipButton && els?.tip.textContent) tipHiddenAt = now();
    tipButton = undefined;
    if (!els) return;
    const { tip } = els;
    tip.style.opacity = '0';
    clearTimeout(tipClearTimer);
    tipClearTimer = setTimeout(
      () => {
        if (!tipButton && els?.tip === tip) tip.textContent = '';
      },
      reduce ? 0 : TIP_CLEAR_MS,
    );
  }

  function resetTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    clearTimeout(tipClearTimer);
    tipButton = undefined;
  }

  // ---- Actions ----------------------------------------------------------------------------

  async function copy() {
    const value = text;
    if (!value) return;
    let ok = false;
    try {
      await writeClipboard(value);
      ok = true;
    } catch {
      ok = fallbackCopy(value);
    }
    if (!ok || !els) return;
    copied = true;
    renderFooter();
    announce(message('card.copied'));
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
      renderFooter();
    }, COPIED_MS);
  }

  /**
   * `execCommand('copy')` from a textarea in the shadow root. It moves the page's
   * selection and focus: both are put back, and the selection changes it causes are
   * ignored (plan 4.5 rule 5).
   */
  function fallbackCopy(value: string): boolean {
    if (!els) return false;
    quietUntil = now() + QUIET_MS;
    const selection = win.getSelection();
    const saved: Range[] = [];
    for (let i = 0; i < (selection?.rangeCount ?? 0); i += 1) {
      const range = selection?.getRangeAt(i);
      if (range) saved.push(range.cloneRange());
    }
    const focused = doc.activeElement as HTMLElement | null;
    const area = node('textarea', { class: 'sr', 'aria-hidden': 'true', tabindex: '-1' });
    area.value = value;
    els.root.append(area);
    let ok = false;
    try {
      area.focus({ preventScroll: true });
      area.select();
      ok = doc.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    try {
      selection?.removeAllRanges();
      for (const range of saved) selection?.addRange(range);
      if (focused && focused !== doc.body && focused !== host)
        focused.focus?.({ preventScroll: true });
    } catch {
      // The page moved on meanwhile; nothing to restore.
    }
    return ok;
  }

  function toggleSpeech() {
    if (!current || voices === false || !els) return;
    const button = els.speak;
    if (speech.speaking()) speech.stop();
    else {
      // English reads in an American voice by default: detected as English, or a word the
      // tables gave a reading for (single words rarely detect reliably).
      const lang = reliableLanguage(current.detected);
      const english = lang ? /^en\b/i.test(lang) : phonetic !== undefined;
      speech.speak(current.source, english ? 'en-US' : lang, (failed) => spoken(button, failed));
    }
    renderFooter();
  }

  /** Reads the word (or the headword whose reading is shown) in a British or American voice. */
  function sayWord(button: HTMLElement) {
    if (!current) return;
    const lang = button.getAttribute('data-l') === 'us' ? 'en-US' : 'en-GB';
    speech.speak(phonetic?.lemma ?? current.source, lang, (failed) => spoken(button, failed));
    renderFooter();
  }

  /** A reading is over: the footer shows it; a failed one says so on the button pressed. */
  function spoken(button: HTMLElement, failed: boolean) {
    renderFooter();
    if (!failed || !els || view !== 'card' || closing || !button.isConnected) return;
    speechFailed = button;
    announce(message(SPEECH_FAILED));
    showTip(button);
    clearTimeout(speechFailedTimer);
    speechFailedTimer = setTimeout(() => {
      speechFailed = undefined;
      if (tipButton === button) hideTip();
    }, SPEECH_FAILED_MS);
  }

  function clearSpeechFailed() {
    clearTimeout(speechFailedTimer);
    speechFailed = undefined;
  }

  function act(action: string, element: HTMLElement) {
    if (view !== 'card' || closing) return;
    if (element.getAttribute('aria-disabled') === 'true') return;
    if (action === 'engine') setList(!listOpen);
    else if (action === 'pick') {
      const id = element.getAttribute('data-id') as Engine | null;
      setList(false);
      if (id && id !== currentEngine()) {
        engineOverride = id;
        renderHeader();
        translate();
      }
    } else if (action === 'source') {
      sourceOpen = !sourceOpen;
      renderBody();
      measure();
    } else if (action === 'retry') translate();
    else if (action === 'google') {
      engineOverride = 'google';
      renderHeader();
      translate();
    } else if (action === 'copy') void copy();
    else if (action === 'speak') toggleSpeech();
    else if (action === 'say') sayWord(element);
    else if (action === 'pin') togglePin();
    else if (action === 'close') close();
  }

  // ---- Listeners ----------------------------------------------------------------------------

  /** Inside the shadow: keep the page's selection and focus (plan 4.3 rule 10). */
  const keep = (event: Event) => {
    const target = event.target as Node | null;
    // The translation itself stays selectable; the body's scrollbar stays draggable.
    if (target && els && (textWrap?.contains(target) || target === els.body)) return;
    event.preventDefault();
  };
  const onClick = (event: Event) => {
    if (!trusted(event)) return;
    const target = (event.target as Element | null)?.closest?.('[data-act]') as HTMLElement | null;
    if (!target || (target as HTMLButtonElement).disabled) return;
    act(target.getAttribute('data-act') ?? '', target);
  };
  const onZoneClick = (event: Event) => {
    if (!trusted(event) || view !== 'dot' || closing) return;
    openCard();
  };
  const onZoneEnter = (event: Event) => {
    if (!trusted(event) || !armed || view !== 'dot' || closing) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (view === 'dot' && !closing) openCard();
    }, HOVER_MS);
  };
  const onZoneLeave = () => {
    clearTimeout(hoverTimer);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!trusted(event)) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (armed || view !== 'dot') return;
    if (!onDot(pointer)) armed = true;
  };
  const onPointerDownOutside = (event: PointerEvent) => {
    if (!host || !trusted(event) || event.composedPath().includes(host)) return;
    if (view === 'card' && !pinned && !closing) close();
    else if (view === 'dot' && !closing) close();
  };
  /** The user's own release (pointer or key) outside the card: a selection they made. */
  const onGesture = (event: Event) => {
    if (!trusted(event) || (host && event.composedPath().includes(host))) return;
    gestureAt = now();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Only closes; the page still sees the key (no preventDefault).
    if (event.key !== 'Escape' || !trusted(event) || view === 'gone' || closing) return;
    if (listOpen) setList(false);
    else close();
  };
  const onScroll = () => {
    if (!followFrame && view !== 'gone') followFrame = raf(follow);
  };
  const onParkedScroll = () => {
    if (!parkFrame && parked) parkFrame = raf(checkParked);
  };
  const onResize = () => {
    viewport = readViewport();
    if (view !== 'card' || closing) return;
    if (pin && placement) {
      const kept = clampPinned(pin.x, pin.y, placement.w, viewport);
      pin = { x: kept.x, y: kept.y };
      placement = { ...placement, maxH: kept.maxH };
    } else if (current && !current.detached) {
      const box = current.range ? unionOf(current.range.getClientRects?.() ?? []) : undefined;
      if (box) track(current, box);
      placement = placeFor(current.rect);
    } else placement = placeDetached(natural, viewport);
    renderAll();
    aim(GROW);
  };
  const onMotion = () => {
    reduce = !!motionQuery?.matches;
    els?.root.toggleAttribute('data-rm', reduce);
  };
  const onPageHide = () => {
    speech.stop();
  };
  const onHeaderDown = (event: PointerEvent) => {
    if (!pinned || !pin || event.button !== 0 || !trusted(event)) return;
    if ((event.target as Element | null)?.closest?.('button')) return;
    event.preventDefault();
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety: moves over the header still drag.
    }
    hideTip();
    drag = { sx: event.clientX, sy: event.clientY, x0: pin.x, y0: pin.y, id: event.pointerId };
    els?.root.setAttribute('data-drag', '');
  };
  const onHeaderMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    // Merged per frame (plan 4.3 rule 9).
    dragTo = { x: event.clientX, y: event.clientY };
    if (!dragFrame) dragFrame = raf(applyDrag);
  };
  const onHeaderUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = undefined;
    els?.root.removeAttribute('data-drag');
  };
  const onBodyScroll = () => {
    if (!els) return;
    const { body } = els;
    els.body.toggleAttribute(
      'data-more',
      body.scrollHeight - body.scrollTop - body.clientHeight > 4,
    );
  };
  const onTipIn = (event: Event) => tipIn(event.currentTarget as HTMLElement);
  const onTipOut = () => tipOut();
  const onTipPress = () => hideTip();

  function listen() {
    win.addEventListener('pointermove', onPointerMove, { passive: true });
    win.addEventListener('pointerdown', onPointerDownOutside, { capture: true, passive: true });
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('pointerup', onGesture, { capture: true, passive: true });
    win.addEventListener('keyup', onGesture, { capture: true, passive: true });
    win.addEventListener('scroll', onScroll, { capture: true, passive: true });
    win.addEventListener('resize', onResize, { passive: true });
    win.addEventListener('pagehide', onPageHide);
    motionQuery?.addEventListener?.('change', onMotion);
    if (!els) return;
    for (const target of [els.shell, els.zone]) {
      target.addEventListener('pointerdown', keep);
      target.addEventListener('mousedown', keep);
    }
    els.shell.addEventListener('click', onClick);
    els.zone.addEventListener('click', onZoneClick);
    els.zone.addEventListener('pointerenter', onZoneEnter);
    els.zone.addEventListener('pointerleave', onZoneLeave);
    els.header.addEventListener('pointerdown', onHeaderDown);
    els.header.addEventListener('pointermove', onHeaderMove);
    els.header.addEventListener('pointerup', onHeaderUp);
    els.header.addEventListener('pointercancel', onHeaderUp);
    els.body.addEventListener('scroll', onBodyScroll, { passive: true });
    for (const target of [els.engine, els.copy, els.speak, els.pin, els.close]) {
      target.addEventListener('pointerenter', onTipIn);
      target.addEventListener('pointerleave', onTipOut);
      target.addEventListener('pointerdown', onTipPress);
    }
  }

  function unlisten() {
    clearTimeout(hoverTimer);
    clearTimeout(foldTimer);
    clearTimeout(copiedTimer);
    clearSpeechFailed();
    if (followFrame) cancelRaf(followFrame);
    followFrame = 0;
    if (dragFrame) cancelRaf(dragFrame);
    dragFrame = 0;
    drag = undefined;
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerdown', onPointerDownOutside, true);
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('pointerup', onGesture, true);
    win.removeEventListener('keyup', onGesture, true);
    win.removeEventListener('scroll', onScroll, true);
    win.removeEventListener('resize', onResize);
    win.removeEventListener('pagehide', onPageHide);
    motionQuery?.removeEventListener?.('change', onMotion);
  }

  // ---- Runtime API ----------------------------------------------------------------------------

  const quiet = () => now() < quietUntil;

  return {
    showDot(snapshot) {
      if (disposed || quiet() || isOwn(snapshot.range)) return;
      // Judged now: `selectionchange` also fires for a page script moving the selection.
      const gesture = now() - gestureAt <= GESTURE_MS;
      const source = sourceOf(snapshot);
      // Every turn-away below also ends a parked dot: the old selection is gone, and
      // scrolling back must not bring its dot back.
      if (source.length < MIN_SOURCE_LENGTH || source.length > MAX_SOURCE_LENGTH) {
        // What the user sees is not worth a dot after all (hidden text made it look so).
        unpark();
        if (view === 'dot' && !closing) hideDotView();
        return;
      }
      if (same(dismissed, source, snapshot.range)) {
        unpark();
        return;
      }
      if (view === 'card' && !closing && same(current, source, snapshot.range)) return;
      // A pinned card takes only a selection the user made (below); a script's selection
      // must not even cancel a pending one of the user's.
      if (view === 'card' && pinned && !closing && !gesture) return;
      const token = ++detectToken;
      void (async () => {
        await configRead;
        const result = await detect(source);
        if (token !== detectToken || disposed) return;
        const to = targetLanguage();
        // Plan 4.4 rule 2: already the target language, no dot.
        if (to && isTargetLanguage(source, result, to)) {
          unpark();
          if (view === 'dot' && !closing) hideDotView();
          return;
        }
        // A pinned card translates the new selection in place, no dot (plan 1.3 rule 1),
        // but only one the user made: a script's selection is never sent anywhere.
        if (view === 'card' && pinned && !closing) {
          if (!gesture) return;
          current = take(snapshot, source);
          current.detected = result;
          force = false;
          sourceOpen = false;
          renderAll();
          translate();
          return;
        }
        current = take(snapshot, source);
        current.detected = result;
        showDotView();
      })();
    },
    hideDot() {
      if (disposed || quiet()) return;
      // The selection is really gone: selecting it again may show the dot again.
      dismissed = undefined;
      unpark();
      detectToken += 1;
      hideDotView();
    },
    open({ source: given, selection }) {
      // The card's own text (its translation is selectable): never translated again.
      if (disposed || isOwn(selection?.range)) return;
      detectToken += 1;
      const source = selection ? sourceOf(selection) : given;
      dismissed = undefined;
      const range = selection?.range;
      // Menu and shortcut: the user asked, no language gate (plan 4.4 rule 3).
      if (view === 'card' && !closing) {
        if (!pinned && same(current, source, range) && force) return;
        if (pinned) {
          current = take(selection, source);
          force = true;
          sourceOpen = false;
          detectFor(current);
          renderAll();
          translate();
          return;
        }
      }
      current = take(selection, source);
      force = true;
      detectFor(current);
      openCard();
    },
    close() {
      if (disposed) return;
      close();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detectToken += 1;
      unpark();
      requests.dispose();
      speech.stop();
      stopWatching();
      unmount();
    },
  };
}
