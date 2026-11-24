import type { Engine, IsleDock } from '@/lib/config/types';
import {
  browserUiLanguage,
  type DetectedLanguages,
  isTargetScript,
  type LanguageCode,
  languageName,
  normalizeLanguage,
} from '@/lib/languages';
import type {
  EngineOption,
  EngineOptions,
  PageState,
  PaletteShortcuts,
} from '@/lib/messaging/protocol';
import isleTokens from '@/styles/tokens-isle.css?inline';
import { ISLE_TAG, PALETTE_TAG } from '../dom-rules';
import { errorText } from '../error-text';
import { message, type NoArgKey, uiLocale } from '../i18n';
import { type ProbeEnv, probeTheme } from '../isle/probe';
import { createSpring, LIST, retarget, SHRINK, snap, step } from '../isle/spring';
import { isActive } from '../page-state';
import { IDLE_PAGE_STATE, type PaletteRuntime, type PaletteRuntimeDeps } from '../runtime-contract';
import {
  type CardPort,
  createCardRequests,
  MAX_SOURCE_LENGTH,
  type RequestEvent,
  reliableLanguage,
} from '../selection/request';
import { engineMark, SVG_NS } from '../svg-icon';
import { restoreFocus, type SavedFocus, saveFocus } from './focus';
import { keyAction, moveActive } from './keys';
import { createPicker } from './pick';
import { type PanelRect, placePanel } from './place';
import {
  COMMAND_PREFIX,
  type CommandApi,
  listCommands,
  matchRange,
  normalizeQuery,
  type PaletteContext,
} from './registry';
import { adoptSheet, HOST_STYLE, PALETTE_CSS } from './styles';

// The command palette (docs/plans/m3c.md, PR1; Design prototype board PaletteM3c): its own
// host `ET-PALETTE`, pulled out of the isle's edge; beside the isle when it shows (PR6: its
// host's `data-et-rect`, read on opening and on every resize, the shape growing out of it).
// Keyboard first: the input keeps focus, the arrows move the highlight, Enter runs it. Keys
// typed here never reach the page's own shortcuts (decision 4), and closing hands focus and
// the selection back to the page. Every frame writes the shape's clip-path, the shadow
// layer's box and the content's opacity and transform; layout is read only after the content
// changed. Plain text typed (no leading `/`) is a quick translation (PR3): the list's first
// row, run by Enter, streams the result above the list through the palette's own Port.
// "选择要翻译的区域" (PR4) closes the palette and hands its saved focus to the region picker
// (pick.ts), which gives it back to the page when the pick ends.

type MediaQuery = Pick<MediaQueryList, 'matches'> &
  Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>>;

export interface PaletteEnv {
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
  /** `i18n.detectLanguage`; absent or rejecting: the detection failed. */
  detectLanguage?(text: string): Promise<DetectedLanguages>;
  /** The browser's interface language; defaults to `i18n.getUILanguage`. */
  uiLanguage?(): string;
  /** Defaults to `navigator.clipboard.writeText`. */
  writeClipboard?(text: string): Promise<void>;
}

export interface PaletteOptions {
  deps: PaletteRuntimeDeps;
  /** The quick translation's own Port (connects on its first request). */
  port: CardPort;
  env: PaletteEnv;
}

/**
 * Decision 7: where a quick translation goes. Text in the target language goes into English;
 * with an English target, into the browser's interface language; undefined when that is
 * English too (nothing to send). `from` is the reliably detected language, if any.
 */
export function quickDirection(
  from: LanguageCode | undefined,
  target: LanguageCode,
  ui: string,
): { to: LanguageCode; reversed: boolean } | undefined {
  if (from !== target) return { to: target, reversed: false };
  if (target !== 'en') return { to: 'en', reversed: true };
  const own = normalizeLanguage(ui);
  return own && own !== 'en' ? { to: own, reversed: true } : undefined;
}

/** What the quick translation shows. */
interface Quick {
  /** The trimmed text sent; frames for any other are dropped. */
  source: string;
  status: 'detecting' | 'loading' | 'partial' | 'done' | 'notice';
  /** The translation so far, or the notice (error, too long, already there, unchanged). */
  text: string;
  error?: boolean;
  /** The reliably detected language's tag. */
  from?: string;
  /** Where it goes, once a request was sent. */
  to?: LanguageCode;
}

/** One row of the list: a command, or an engine in the engine list. */
interface Row {
  /** Who the row is (command id, engine id, 'tr' for the translate row): the highlight follows it. */
  key: string;
  label: string;
  icon(): Node;
  /** Trailing text: an engine's note, the engine a command opens the list of. */
  trail?: string;
  /** Trailing count (retry). */
  count?: number;
  warn?: boolean;
  disabled?: boolean;
  /** The engine translating the page: a check mark at the end. */
  current?: boolean;
  /** Opens a second list: an arrow at the end. */
  more?: boolean;
  /** The key bound to the command, shown in the shortcut slot. */
  kb?: string;
  /** The translate row: the typed text, cut on its own between the quotes. */
  quoted?: string;
  run(): void;
}

/** Keys and text input stop at the shadow root: the page sees none of them (blocker B1). */
const ISOLATED = [
  'keydown',
  'keypress',
  'keyup',
  'beforeinput',
  'input',
  'paste',
  'copy',
  'cut',
  'compositionstart',
  'compositionupdate',
  'compositionend',
];
/** Focus taken away twice within this long: the page insists (a focus trap), so give up. */
const STEAL_MS = 100;
/** After a key closed the palette, its keyup is kept from the page at most this long. */
const KEYUP_GUARD_MS = 1000;
/** The input row (--et-h-strip): the shape starts as this strip, 0 wide, at the edge. */
const STRIP = 46;
const RADIUS = 14;
/** How long the copy row says "Copied" (as the card's button). */
const COPIED_MS = 1500;
/** Reduced motion: the closing fade (--et-dur-fast). */
const FADE_MS = 120;
/** Closing: the content fades over the first 35% and moves this far toward the edge. */
const NUDGE = 4;

/** 16px line icons (stroke 1.5, currentColor), one path each. */
const PATH = {
  translate:
    'M2.5 4h7M6 2.5V4M4.2 4c.5 2.4 2.1 4.3 4.3 5.2M7.8 4C7.2 6.6 5.5 8.6 2.8 9.8M8.6 13.5l2.6-6.3 2.6 6.3M9.5 11.6h3.4',
  retry: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.6v3h-3',
  engine: 'M3 5.5h9.5M10.5 3.3l2.2 2.2-2.2 2.2M13 10.5H3.5M5.5 8.3l-2.2 2.2 2.2 2.2',
  settings: 'M3 5h10M3 11h10M6 3v4M10 9v4',
  back: 'M10 3.5 5.5 8l4.5 4.5',
  more: 'M6 3.5 10.5 8 6 12.5',
  check: 'M3.5 8.4l3 3 6-6.4',
  /** Four corners of a selection: the region picker. */
  region: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3',
  copy: 'M7.3 5.5h4.4a1.8 1.8 0 0 1 1.8 1.8v4.4a1.8 1.8 0 0 1-1.8 1.8H7.3a1.8 1.8 0 0 1-1.8-1.8V7.3a1.8 1.8 0 0 1 1.8-1.8zM10.5 5.5V4.3a1.8 1.8 0 0 0-1.8-1.8H4.3a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8h1.2',
  /** 12px grid: the result's direction line. */
  arrow: 'M2 6h8M7 3l3 3-3 3',
  /** The lead dot's ring (r 7.25): a faint track and a spinning arc (stylesheet dash). */
  ring: 'M8 .75a7.25 7.25 0 1 1 0 14.5a7.25 7.25 0 1 1 0-14.5',
};
/** The isle's mode glyphs: a character in a box in Chinese UIs, a line icon elsewhere. */
const GLYPHS: Record<string, NoArgKey> = {
  'page.restore': 'isle.glyphOriginal',
  'view.bilingual': 'isle.glyphBilingual',
  'view.translationOnly': 'isle.glyphTranslation',
};
/** isle.ts MODE_ICONS (14px grid): `[path, stroke-opacity?]`. */
const GLYPH_ICONS: Record<string, [string, string?][]> = {
  'isle.glyphBilingual': [['M2.5 4.5h9'], ['M2.5 9.5h6', '.55']],
  'isle.glyphTranslation': [['M2.5 7h9']],
  'isle.glyphOriginal': [['M5 4 2.5 6.5 5 9'], ['M2.5 6.5h6a3 3 0 0 1 0 6H7']],
};
const COMMAND_ICONS: Record<string, string> = {
  'page.translate': PATH.translate,
  'retry.failed': PATH.retry,
  'engine.switch': PATH.engine,
  'options.open': PATH.settings,
  'quick.copy': PATH.copy,
  'region.translate': PATH.region,
  'region.exclude': PATH.region,
};
/** The commands that show their bound key, and the manifest command each one reads. */
const SHORTCUT_OF: Record<string, keyof PaletteShortcuts> = {
  'page.translate': 'translate-page',
  'page.restore': 'translate-page',
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Plain text typed: what Enter translates ('' for a blank input or a `/` command search). */
const typedText = (value: string) => (COMMAND_PREFIX.test(value.trimStart()) ? '' : value.trim());

export function createPalette({ deps, port, env }: PaletteOptions): PaletteRuntime {
  const { win } = env;
  const doc = win.document;
  const raf = env.raf ?? ((callback: () => void) => win.requestAnimationFrame(callback));
  const cancelRaf = env.cancelRaf ?? ((handle: number) => win.cancelAnimationFrame(handle));
  const now = env.now ?? (() => win.performance.now());
  const trusted = env.isTrusted ?? ((event: Event) => event.isTrusted);
  const media = (query: string): MediaQuery | undefined =>
    env.matchMedia ? env.matchMedia(query) : win.matchMedia?.(query);
  const uiLanguage = env.uiLanguage ?? browserUiLanguage;
  const writeClipboard =
    env.writeClipboard ?? ((text: string) => win.navigator.clipboard.writeText(text));

  interface Els {
    shadowRoot: ShadowRoot;
    root: HTMLElement;
    shadow: HTMLElement;
    shape: HTMLElement;
    content: HTMLElement;
    head: HTMLElement;
    lead: HTMLElement;
    chip: HTMLElement;
    input: HTMLInputElement;
    halted: HTMLElement;
    result: HTMLElement;
    direction: HTMLElement;
    text: HTMLElement;
    list: HTMLElement;
    foot: HTMLElement;
    live: HTMLElement;
  }
  let host: HTMLElement | undefined;
  let els: Els | undefined;
  let open = false;
  let disposed = false;
  /** Bumped on every open and close: a late answer for an earlier opening is dropped. */
  let epoch = 0;
  let ctx: PaletteContext | undefined;
  let view: 'commands' | 'engines' = 'commands';
  /** The engine list: undefined while it loads, 'failed' when it could not be read. */
  let engines: EngineOptions | 'failed' | undefined;
  /** The keys in effect, read once per opening; all empty until the answer arrives or fails. */
  let shortcuts: Partial<PaletteShortcuts> = {};
  let rows: Row[] = [];
  let active = -1;
  let saved: SavedFocus = { element: null };
  let dock: IsleDock = 'right';
  let lastSteal = Number.NEGATIVE_INFINITY;
  /** Once the session halted: one status strip, focus handed back, no input. */
  let halted = false;
  let viewport = { w: 1, h: 1 };
  /** Where the shape is heading (open) or folds into (closed): the content sits here. */
  let rect: PanelRect = { x: 0, y: 0, w: 0, h: STRIP };
  /** The isle's rectangle, when it shows: the panel sits beside it and grows out of it. */
  let anchor: PanelRect | undefined;
  /** While open: the isle coming, going and moving (its `data-et-rect`) re-places the panel. */
  let isleWatch: MutationObserver | undefined;
  const springs = { W: createSpring(0), H: createSpring(STRIP) };
  let frame = 0;
  let lastT = 0;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The modal dialog the host joined, if any: its closing closes the palette. */
  let joined: Element | undefined;
  /** The key (its `code`) whose keydown is closing the palette right now, if any. */
  let closingKey: string | undefined;
  /** Removes the pending keyup guard (swallowKeyUp), if any. */
  let unguard = () => {};
  /** The configured target language, read on opening. */
  let target: LanguageCode | undefined;
  let quick: Quick | undefined;
  /** Bumped whenever the quick translation is replaced or dropped: late answers are ignored. */
  let quickSerial = 0;
  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The arrows moved the highlight since the last input: Enter runs it, not the translation. */
  let keyed = false;
  const requests = createCardRequests({ port, currentSource: () => quick?.source });
  /** "选择要翻译的区域" (PR4): its own host, started once the palette has closed. */
  const picker = createPicker({
    env: {
      win,
      raf,
      cancelRaf,
      matchMedia: media,
      elementsFromPoint: env.elementsFromPoint,
      getComputedStyle: env.getComputedStyle,
      shadowMode: env.shadowMode,
      isTrusted: trusted,
    },
    parent: () => modalDialog() ?? doc.documentElement,
    guardKeyUp: swallowKeyUp,
    region: (kind, root) => deps.page.region(kind, root),
  });
  /** The streamed translation's text node, and its caret (moved, never rebuilt). */
  let streamed: Text | undefined;
  const caret = doc.createElement('span');
  caret.className = 'cr';
  caret.setAttribute('aria-hidden', 'true');

  const reduced = () => !!media('(prefers-reduced-motion: reduce)')?.matches;

  // ---- DOM ---------------------------------------------------------------------------------

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

  /** A decorative line icon: `paths` as `[d, stroke-opacity?]`. */
  function icon(className: string, viewBox: string, ...paths: [string, string?][]): Element {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    for (const [d, opacity] of paths) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (opacity) path.setAttribute('stroke-opacity', opacity);
      svg.append(path);
    }
    return svg;
  }

  /**
   * The top-most modal dialog: everything outside it is inert, so the host goes inside it
   * (docs/plans/m3c.md, weakest assumption 2). Undefined when none is open.
   */
  function modalDialog(): Element | undefined {
    try {
      const dialogs = doc.querySelectorAll('dialog');
      for (let i = dialogs.length - 1; i >= 0; i -= 1) {
        const dialog = dialogs[i];
        if (dialog?.matches(':modal')) return dialog;
      }
    } catch {
      // `:modal` unsupported: no dialog to join.
    }
    return undefined;
  }

  function mount() {
    const element = doc.createElement(PALETTE_TAG.toLowerCase());
    for (const [prop, value] of HOST_STYLE) element.style.setProperty(prop, value, 'important');
    element.setAttribute('data-et-theme', 'light');
    // The page's own language must not leak in: it picks fonts and the screen reader's voice.
    element.setAttribute('lang', uiLocale());
    const shadowRoot = element.attachShadow({ mode: env.shadowMode ?? 'closed' });
    adoptSheet(win, shadowRoot, `${isleTokens}\n${PALETTE_CSS}`);
    const label = message('palette.label');
    const lead = node(
      'span',
      { class: 'ld', 'aria-hidden': 'true' },
      icon('arc', '0 0 16 16', [PATH.ring, '.22'], [PATH.ring]),
    );
    const chip = node('span', { class: 'cp', hidden: '' });
    const input = node('input', {
      class: 'in',
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'l',
      'aria-autocomplete': 'list',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const haltedText = node('span', { class: 'hs', hidden: '' });
    const head = node('div', { class: 'hd' }, lead, chip, input, haltedText);
    const direction = node('div', { class: 'dr' });
    // Focusable (not in any tab order) so the text can be selected without the focus leaving
    // the palette; keys there go back to the input (onTextKey).
    const text = node('div', { class: 'qt', tabindex: '-1' });
    const result = node('div', { class: 'qr', 'aria-live': 'polite', hidden: '' }, direction, text);
    const list = node('ul', { class: 'ls', id: 'l', role: 'listbox', 'aria-label': label });
    const foot = node('div', { class: 'ft', hidden: '' }, message('palette.slashHint'));
    const content = node(
      'div',
      { class: 'cn', role: 'dialog', 'aria-label': label },
      head,
      result,
      list,
      foot,
    );
    const shape = node('div', { class: 'sl' }, content);
    const shadow = node('div', { class: 'sh' });
    const live = node('span', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    const root = node('div', { class: 'r' }, shadow, shape, live);
    shadowRoot.append(root);
    for (const type of ISOLATED) shadowRoot.addEventListener(type, isolate);
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
    shape.addEventListener('pointerdown', keepFocus);
    shape.addEventListener('mousedown', keepFocus);
    head.addEventListener('click', onHeadClick);
    list.addEventListener('click', onRowClick);
    list.addEventListener('pointermove', onRowHover);
    text.addEventListener('scroll', onTextScroll);
    text.addEventListener('keydown', onTextKey);
    if (reduced()) root.setAttribute('data-rm', '');
    joined = modalDialog();
    (joined ?? doc.documentElement).append(element);
    joined?.addEventListener('close', onDialogClose);
    host = element;
    els = {
      shadowRoot,
      root,
      shadow,
      shape,
      content,
      head,
      lead,
      chip,
      input,
      halted: haltedText,
      result,
      direction,
      text,
      list,
      foot,
      live,
    };
  }

  function unmount() {
    if (frame) cancelRaf(frame);
    frame = 0;
    lastT = 0;
    clearTimeout(fadeTimer);
    joined?.removeEventListener('close', onDialogClose);
    joined = undefined;
    host?.remove();
    host = undefined;
    els = undefined;
  }

  // ---- Rows --------------------------------------------------------------------------------

  /** The engines, read once per opening (the engine command shows the current one's name). */
  function loadEngines() {
    const opened = epoch;
    engines = undefined;
    deps.send('engine.options').then(
      (value) => {
        if (opened !== epoch) return;
        engines = value;
        render(true);
      },
      () => {
        if (opened !== epoch) return;
        engines = 'failed';
        if (view === 'engines') render();
      },
    );
  }

  /** The shortcuts, read once per opening; a failed read shows no keys. */
  function loadShortcuts() {
    const opened = epoch;
    shortcuts = {};
    deps.send('shortcuts.get').then(
      (value) => {
        if (opened !== epoch) return;
        shortcuts = value;
        render(true);
      },
      () => {},
    );
  }

  const api: CommandApi = {
    page: deps.page,
    copy() {
      void copy();
    },
    pickRegion(kind) {
      // The page's focus goes to the picker, not back to the page (decision 2): the picker
      // hands it back when the pick ends.
      const focus = saved;
      close(false);
      picker.start(focus, kind);
    },
    openSettings() {
      close();
      deps.send('options.open').catch(() => {});
    },
    engines() {
      view = 'engines';
      if (!els) return;
      const state = ctx?.state ?? IDLE_PAGE_STATE;
      // The command's title without its trailing "…" (or the plain "Translate this page").
      els.chip.textContent = isActive(state)
        ? message('palette.switchEngine').replace(/…$/, '')
        : message('popup.translatePage');
      els.chip.hidden = false;
      els.input.value = '';
      clearQuick();
      els.input.placeholder = message('isle.listTitle');
      els.lead.replaceWith(backButton());
      if (engines === 'failed') loadEngines();
    },
  };

  function backButton(): HTMLElement {
    // Pointer only: the keyboard goes back with Escape, ← or Backspace.
    return node(
      'button',
      { class: 'bk', type: 'button', tabindex: '-1', 'aria-hidden': 'true', 'data-back': '' },
      icon('', '0 0 16 16', [PATH.back]),
    );
  }

  /** The engine the page uses: the session's, else the configured default. */
  function usingEngine(state: PageState): Engine | undefined {
    return state.engine ?? (engines && engines !== 'failed' ? engines.configured : undefined);
  }

  function engineOption(id: Engine | undefined): EngineOption | undefined {
    return engines && engines !== 'failed'
      ? engines.options.find((option) => option.id === id)
      : undefined;
  }

  /** The translate row, first for plain text typed (not for a `/` search, not once halted). */
  function translateRow(query: string): Row[] {
    const source = typedText(query);
    if (!source || !ctx || ctx.state.halted) return [];
    return [
      {
        key: 'tr',
        label: message('palette.translateText', source),
        quoted: source,
        icon: () => icon('', '0 0 16 16', [PATH.translate]),
        run: () => translateNow(source),
      },
    ];
  }

  /** A translation to copy: done, translated, not a notice. */
  const translation = () => (quick?.status === 'done' ? quick.text : '');

  function commandRows(query: string): Row[] {
    if (!ctx) return [];
    const current: PaletteContext = translation() ? { ...ctx, quick: { copied } } : ctx;
    const zh = uiLocale().startsWith('zh');
    return listCommands(current, query).map((command): Row => {
      const glyph = GLYPHS[command.id];
      const shortcutName = SHORTCUT_OF[command.id];
      return {
        key: command.id,
        label: command.title(current),
        icon: () => {
          if (command.id === 'quick.copy' && copied) return icon('cd', '0 0 16 16', [PATH.check]);
          if (!glyph) return icon('', '0 0 16 16', [COMMAND_ICONS[command.id] ?? '']);
          if (zh) return node('span', { class: 'pf' }, message(glyph));
          return icon('', '0 0 14 14', ...(GLYPH_ICONS[glyph] ?? []));
        },
        warn: command.id === 'retry.failed',
        count:
          command.id === 'retry.failed' && current.state.failed > 0
            ? current.state.failed
            : undefined,
        more: command.id === 'engine.switch',
        kb: shortcutName ? shortcuts[shortcutName] : undefined,
        trail:
          command.id === 'engine.switch'
            ? engineOption(usingEngine(current.state))?.name
            : undefined,
        run: () => {
          command.run(current, api);
          if (command.stays) return;
          // A command that opened the engine list keeps the palette open.
          if (view === 'commands') close();
          else render();
        },
      };
    });
  }

  function engineRows(query: string): Row[] {
    if (!engines || engines === 'failed') return [];
    const state = ctx?.state ?? IDLE_PAGE_STATE;
    const running = isActive(state);
    const using = usingEngine(state);
    const q = normalizeQuery(query);
    return engines.options
      .filter((option) => option.name.toLowerCase().includes(q))
      .map(
        (option): Row => ({
          key: option.id,
          label: option.name,
          icon: () => engineMark(doc, option),
          trail: option.ready ? undefined : option.note,
          disabled: !option.ready,
          current: running && option.id === using,
          run: () => {
            // Picking the engine already translating the page changes nothing.
            if (!(running && option.id === using)) {
              deps.page.start({ engine: option.id }).catch(() => {});
            }
            close();
          },
        }),
      );
  }

  /** `label` with the first match of `query` in the accent color. */
  function highlighted(label: string, query: string): (Node | string)[] {
    const range = matchRange(label, normalizeQuery(query));
    if (!range) return [label];
    const [start, end] = range;
    return [
      label.slice(0, start),
      node('span', { class: 'hl' }, label.slice(start, end)),
      label.slice(end),
    ];
  }

  /** 「翻译“…”」 with the text in its own span: it is cut, the closing quote stays. */
  function quotedTitle(quoted: string): HTMLElement {
    const [before = '', after = ''] = message('palette.translateText', '\n').split('\n');
    return node('span', { class: 'tt qq' }, before, node('span', { class: 'q' }, quoted), after);
  }

  function rowElement(row: Row, index: number, query: string): HTMLElement {
    const item = node(
      'li',
      { class: 'o', id: `o${index}`, role: 'option', 'data-i': String(index) },
      node('span', { class: 'ic', 'aria-hidden': 'true' }, row.icon()),
      row.quoted === undefined
        ? node('span', { class: 'tt' }, ...highlighted(row.label, query))
        : quotedTitle(row.quoted),
    );
    if (row.disabled) item.setAttribute('aria-disabled', 'true');
    if (row.current) item.setAttribute('aria-current', 'true');
    if (row.warn) item.setAttribute('data-warn', '');
    if (row.count !== undefined) item.append(node('span', { class: 'nm' }, String(row.count)));
    if (row.trail) item.append(node('span', { class: row.more ? 'tr' : 'nt' }, row.trail));
    if (row.current) item.append(icon('ok', '0 0 16 16', [PATH.check]));
    if (row.more) item.append(icon('ch', '0 0 16 16', [PATH.more]));
    // The shortcut slot: an empty one is hidden by the stylesheet.
    item.append(node('span', { class: 'kb' }, row.kb ?? ''));
    return item;
  }

  /**
   * Rebuilds the list; the highlight goes to the first row unless `keep` and the highlighted
   * row (the same command or engine, wherever it moved) is still there and enabled.
   */
  function render(keep = false) {
    if (!els) return;
    const { input, list, live } = els;
    const query = input.value;
    const before = rows[active]?.key;
    rows = view === 'engines' ? engineRows(query) : [...translateRow(query), ...commandRows(query)];
    const disabled = rows.map((row) => !!row.disabled);
    const kept = keep ? rows.findIndex((row) => row.key === before) : -1;
    active = kept >= 0 && !disabled[kept] ? kept : moveActive(disabled, -1, 1);
    const empty =
      (view === 'engines' && engines === 'failed') || (!!ctx && view === 'commands' && !rows.length)
        ? message(view === 'engines' ? 'isle.listFailed' : 'palette.empty')
        : '';
    list.replaceChildren(
      ...rows.map((row, index) => rowElement(row, index, query)),
      ...(empty ? [node('li', { class: 'em', role: 'presentation' }, empty)] : []),
    );
    list.hidden = list.childElementCount === 0;
    // The footnote: only over the full list of commands.
    els.foot.hidden = !(ctx && view === 'commands' && !query && !ctx.state.halted);
    if (live.textContent !== empty) live.textContent = empty;
    highlight();
    resize();
  }

  /**
   * Text typed and the arrows not used yet: Enter translates, so the pointer only hovers (a
   * fainter background, `.ls[data-hover]`) and leaves the highlight where Enter goes.
   */
  const hoverOnly = () => !keyed && rows[0]?.quoted !== undefined;

  // ---- Quick translation -------------------------------------------------------------------

  /** Drops the quick translation without drawing (closing): the request is cancelled. */
  function stopQuick() {
    quickSerial += 1;
    requests.cancel();
    quick = undefined;
    copied = false;
    clearTimeout(copiedTimer);
  }

  function clearQuick() {
    const had = !!quick;
    stopQuick();
    if (had) renderQuick();
  }

  /** Enter on the translate row: detect, pick the direction (decision 7), then stream. */
  function translateNow(source: string) {
    // Already shown or on its way; a failed one is tried again.
    if (quick?.source === source && !quick.error) return;
    stopQuick();
    const serial = quickSerial;
    if (source.length > MAX_SOURCE_LENGTH) {
      // Never sent (request.ts): no detection either.
      onQuick(source, { kind: 'too-long' });
      return;
    }
    quick = { source, status: 'detecting', text: '' };
    renderQuick();
    // A detector that throws at once is a failed detection too, not a stuck spinner.
    new Promise<DetectedLanguages>((resolve, reject) => {
      if (env.detectLanguage) resolve(env.detectLanguage(source));
      else reject(new Error('unavailable'));
    })
      .then(reliableLanguage, () => undefined)
      .then((from) => {
        if (serial !== quickSerial || !quick) return;
        quick.from = from;
        // Failed or unsure (short text, mostly): the script decides whether it is already in
        // the target language. A reliable other language (French…) is left as it is.
        const code = from
          ? normalizeLanguage(from)
          : target && isTargetScript(source, target)
            ? target
            : undefined;
        const goes = target ? quickDirection(code, target, uiLanguage()) : { reversed: false };
        if (!goes) {
          quick = { source, status: 'notice', text: message('palette.alreadyTarget') };
          renderQuick();
          render(true);
          return;
        }
        quick.to = 'to' in goes ? goes.to : undefined;
        requests.translate(
          { source, force: true, target: goes.reversed ? quick.to : undefined },
          (event) => {
            if (serial === quickSerial) onQuick(source, event);
          },
        );
      });
  }

  function onQuick(source: string, event: RequestEvent) {
    const shown = quick ?? { source, status: 'loading', text: '' };
    quick = shown;
    if (event.kind === 'phonetic') return;
    shown.error = false;
    if (event.kind === 'loading' || event.kind === 'partial') {
      shown.status = event.kind;
      shown.text = event.kind === 'partial' ? event.text : '';
      renderQuick();
      return;
    }
    if (event.kind === 'done') {
      const translated = event.disposition === 'translated' && !!event.text;
      shown.status = translated ? 'done' : 'notice';
      shown.text = translated ? event.text : message('card.unchanged');
    } else {
      shown.status = 'notice';
      shown.error = event.kind === 'error';
      shown.text =
        event.kind === 'error'
          ? errorText(event.error)
          : message(
              'palette.tooLong',
              MAX_SOURCE_LENGTH.toLocaleString(uiLocale(), { useGrouping: 'min2' }),
            );
    }
    renderQuick();
    // The copy row comes (or not) with the outcome; the highlight stays where it was.
    render(true);
  }

  function languageLabel(tag: string | undefined): string {
    const code = tag ? normalizeLanguage(tag) : undefined;
    return code ? languageName(code) : message('common.autoDetect');
  }

  /** The result area above the list, and the lead's spinning arc while it is on its way. */
  function renderQuick() {
    if (!els) return;
    const { root, result, direction, text } = els;
    const busy = !!quick && quick.status !== 'done' && quick.status !== 'notice';
    root.toggleAttribute('data-run', busy);
    result.setAttribute('aria-busy', String(busy));
    // Hidden until the direction is known: a detection is too quick to show.
    result.hidden = !quick || quick.status === 'detecting' || view !== 'commands';
    if (!quick || result.hidden) {
      text.replaceChildren();
      text.removeAttribute('data-more');
    } else {
      const { to, status } = quick;
      direction.hidden = !to;
      if (to) {
        direction.replaceChildren(
          languageLabel(quick.from),
          icon('', '0 0 12 12', [PATH.arrow]),
          node('span', { class: 'sr' }, '→'),
          languageName(to),
        );
      }
      if (status === 'notice') {
        text.removeAttribute('lang');
        const notice = node('p', { class: 'nc' }, quick.text);
        if (quick.error) notice.setAttribute('data-err', '');
        text.replaceChildren(notice);
        streamed = undefined;
      } else {
        // The translation is in its own language, whatever the palette's is.
        text.setAttribute('lang', to ?? '');
        const streaming = status !== 'done';
        // Whether the reader is at the end, judged before the new words grow the text.
        const atEnd = text.scrollHeight - text.scrollTop - text.clientHeight < 24;
        // One text node: increments are appended (a selection in it survives); a reset or a
        // final text that is not a continuation starts it over.
        if (streamed?.parentNode === text && quick.text.startsWith(streamed.data)) {
          streamed.appendData(quick.text.slice(streamed.data.length));
        } else {
          streamed = doc.createTextNode(quick.text);
          text.replaceChildren(streamed);
        }
        if (streaming) text.append(caret);
        else caret.remove();
        // Follow the end while it streams, unless the reader scrolled up.
        if (streaming && atEnd) text.scrollTop = text.scrollHeight;
      }
      fadeMore();
    }
    resize();
  }

  /** The 22px fade at the bottom while more text is below. */
  function fadeMore() {
    if (!els) return;
    const { text } = els;
    text.toggleAttribute('data-more', text.scrollHeight - text.scrollTop - text.clientHeight > 4);
  }

  async function copy() {
    const value = translation();
    if (!value) return;
    const serial = quickSerial;
    let ok = false;
    try {
      await writeClipboard(value);
      ok = true;
    } catch {
      // Not into a palette opened since, nor for a translation replaced meanwhile.
      if (serial !== quickSerial || !open) return;
      ok = fallbackCopy(value);
    }
    if (!ok || serial !== quickSerial || !open) return;
    copied = true;
    render(true);
    if (els) els.live.textContent = message('card.copied');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
      render(true);
    }, COPIED_MS);
  }

  /** `execCommand('copy')` from a textarea in the shadow root; the focus returns to the input. */
  function fallbackCopy(value: string): boolean {
    if (!els) return false;
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
    els.input.focus({ preventScroll: true });
    return ok;
  }

  function highlight() {
    if (!els) return;
    const { input, list } = els;
    list.toggleAttribute('data-hover', hoverOnly());
    for (const item of list.children) {
      if (item.getAttribute('role') === 'option') {
        item.setAttribute('aria-selected', String(item.id === `o${active}`));
      }
    }
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else {
      input.setAttribute('aria-activedescendant', `o${active}`);
      (list.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** Enter: plain text typed is translated unless the arrows picked another row. */
  function runEnter() {
    const first = rows[0];
    if (!keyed && first?.quoted !== undefined) first.run();
    else runActive();
  }

  function runActive() {
    const row = rows[active];
    if (row && !row.disabled) row.run();
  }

  function showCommands() {
    view = 'commands';
    if (!els) return;
    els.input.value = '';
    els.input.placeholder = message('palette.placeholder');
    els.chip.hidden = true;
    const back = els.head.querySelector('[data-back]');
    if (back) back.replaceWith(els.lead);
    keyed = false;
    clearQuick();
    render();
  }

  /**
   * The session halted (the extension was updated or reloaded): one status strip saying the
   * page needs a reload. Focus goes back to the page at once; Escape, a press elsewhere or
   * the shortcut closes it.
   */
  function showHalted() {
    if (!els || halted) return;
    halted = true;
    const { root, input, halted: text, list, content, live } = els;
    root.setAttribute('data-halted', '');
    content.setAttribute('role', 'status');
    content.removeAttribute('aria-label');
    input.blur();
    input.hidden = true;
    list.hidden = true;
    const copy = message('popup.reloadTitle');
    text.textContent = copy;
    text.hidden = false;
    live.textContent = copy;
    restoreFocus(doc, saved);
    resize();
  }

  // ---- Events ------------------------------------------------------------------------------

  const isolate = (event: Event) => {
    event.stopPropagation();
  };

  const onKey = (event: KeyboardEvent) => {
    const action = keyAction(event, view === 'engines' && !els?.input.value);
    if (!action) return;
    event.preventDefault();
    // Enter or Escape may close the palette: their keyup must not land on the page then.
    closingKey = event.code || event.key;
    try {
      act(action);
    } finally {
      closingKey = undefined;
    }
  };

  function act(action: NonNullable<ReturnType<typeof keyAction>>) {
    if (action === 'up' || action === 'down') {
      keyed = true;
      active = moveActive(
        rows.map((row) => !!row.disabled),
        active,
        action === 'up' ? -1 : 1,
      );
      highlight();
    } else if (action === 'run') runEnter();
    else if (action === 'parent') showCommands();
    else if (action === 'back') {
      // One Escape, one layer: the engine list goes back to the commands first.
      if (view === 'engines') showCommands();
      else close();
    }
  }

  /**
   * The keydown that closed the palette was the shadow root's, but focus is back on the page
   * by its keyup: that keyup is stopped once, in the window's capture phase (blocker B1), and
   * so are the key's auto-repeats until then (the key still held).
   */
  function swallowKeyUp(code: string) {
    unguard();
    const same = (event: KeyboardEvent) => (event.code || event.key) === code;
    const block = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    const stop = () => {
      win.removeEventListener('keyup', onUp, true);
      win.removeEventListener('keydown', onRepeat, true);
      clearTimeout(timer);
      unguard = () => {};
    };
    const onUp = (event: KeyboardEvent) => {
      if (!same(event)) return;
      block(event);
      stop();
    };
    const onRepeat = (event: KeyboardEvent) => {
      if (event.repeat && same(event)) block(event);
    };
    const timer = setTimeout(stop, KEYUP_GUARD_MS);
    win.addEventListener('keyup', onUp, true);
    win.addEventListener('keydown', onRepeat, true);
    unguard = stop;
  }

  const onInput = () => {
    keyed = false;
    // Another text: the old result goes, its request with it.
    if (quick && els && typedText(els.input.value) !== quick.source) clearQuick();
    render();
  };

  // Presses inside keep the focus in the input; the input itself takes the caret as usual,
  // and the translation takes the selection (it holds the focus, still inside the palette).
  const keepFocus = (event: Event) => {
    const target = event.target as Node | null;
    if (target !== els?.input && !(target && els?.text.contains(target))) event.preventDefault();
  };

  const onTextScroll = () => {
    fadeMore();
  };

  /**
   * A key while the translation has the focus (after selecting in it). Typing (a character,
   * with Option or AltGr too, a dead key, an input method starting), Enter, Escape, Tab and
   * ↑↓ go back to the input, which
   * handles them as its own; keys that extend the selection or scroll (Shift+arrows, Page
   * Up/Down, space, Home/End) and shortcuts (copy) stay. ⌘A / Ctrl+A selects the translation
   * only, not the page.
   */
  const onTextKey = (event: KeyboardEvent) => {
    const { key, shiftKey, altKey } = event;
    // AltGr (Windows: Ctrl+Alt) types characters; ⌘ / Ctrl make shortcuts.
    const command = !event.getModifierState?.('AltGraph') && (event.ctrlKey || event.metaKey);
    if (command && !altKey && !shiftKey && key.toLowerCase() === 'a') {
      event.preventDefault();
      if (els) win.getSelection()?.selectAllChildren(els.text);
      return;
    }
    // Option (macOS) and AltGr type characters too; a dead key starts one.
    const typing = (key.length === 1 && key !== ' ') || key === 'Process' || key === 'Dead';
    const moving =
      !altKey && (/^(Enter|Escape|Tab)$/.test(key) || (!shiftKey && /^Arrow(Up|Down)$/.test(key)));
    if (command || !(typing || moving)) return;
    els?.input.focus({ preventScroll: true });
    onKey(event);
  };

  const onHeadClick = (event: Event) => {
    if ((event.target as Element | null)?.closest?.('[data-back]')) showCommands();
  };

  const rowIndex = (event: Event) =>
    Number(
      (event.target as Element | null)?.closest?.('[data-i]')?.getAttribute('data-i') ?? Number.NaN,
    );

  const onRowClick = (event: Event) => {
    const index = rowIndex(event);
    if (!Number.isInteger(index) || rows[index]?.disabled) return;
    // Another row than the translation: Enter follows the click, as it follows the arrows.
    if (index > 0) keyed = true;
    active = index;
    highlight();
    runActive();
  };

  // The pointer moves the one highlight; disabled rows do not react. With text typed and the
  // arrows not used yet, Enter translates: the highlight (what a screen reader hears) stays on
  // the translate row, and the pointer only hovers (the stylesheet's :hover).
  const onRowHover = (event: Event) => {
    const index = rowIndex(event);
    if (!Number.isInteger(index) || index === active || rows[index]?.disabled) return;
    if (hoverOnly()) return;
    active = index;
    highlight();
  };

  // Window listeners, only while open.
  const onPointerDownOutside = (event: Event) => {
    if (!host || !trusted(event)) return;
    const path = event.composedPath();
    // The isle counts as inside: its ⌘ toggles the palette, its other buttons leave it open.
    if (path.includes(host) || path.some(isIsle)) return;
    // The user went elsewhere: focus goes where they pressed, not back.
    close(false);
  };

  const onFocusIn = (event: Event) => {
    if (!host || halted || event.composedPath().includes(host)) return;
    stolen(event.target);
  };

  /**
   * Focus went to `target` outside the palette. Into a frame: the user went there, close.
   * Otherwise take it back once; taken again within STEAL_MS, the page insists: close.
   */
  function stolen(target: EventTarget | null) {
    const name = (target as Element | null)?.nodeName;
    const t = now();
    if (name === 'IFRAME' || name === 'FRAME' || t - lastSteal < STEAL_MS) {
      close(false);
      return;
    }
    lastSteal = t;
    els?.input.focus({ preventScroll: true });
    // Focus that silently did not take (an inert host, a page that blocks it): give up too.
    if (open && els && els.shadowRoot.activeElement !== els.input) close(false);
  }

  const onDialogClose = () => {
    close(false);
  };

  // Full screen puts the page's top layer over the palette.
  const onFullscreen = () => {
    if (doc.fullscreenElement) close(false);
  };

  // The halted strip holds no focus: Escape is heard from the page.
  const onWindowKey = (event: KeyboardEvent) => {
    if (halted && event.key === 'Escape' && trusted(event)) close(false);
  };

  const onResize = () => {
    resize(true);
  };

  function listen(on: boolean) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    win[method]('pointerdown', onPointerDownOutside, true);
    win[method]('focusin', onFocusIn, true);
    win[method]('keydown', onWindowKey as EventListener, true);
    win[method]('resize', onResize);
    doc[method]('fullscreenchange', onFullscreen);
    watchIsle(on);
  }

  /**
   * The isle grows (the retry button), moves or leaves while the palette is open: placed
   * again, beside it, or at the edge once it is gone (as an opening without it would be).
   */
  function watchIsle(on: boolean) {
    isleWatch?.disconnect();
    isleWatch = undefined;
    const Observer = (win as Window & { MutationObserver?: typeof MutationObserver })
      .MutationObserver;
    if (!on || !Observer) return;
    const watch = new Observer(() => {
      observe();
      resize();
    });
    // <html>'s children for an isle coming or going, the current isle's rectangle and edge.
    const observe = () => {
      watch.disconnect();
      watch.observe(doc.documentElement, { childList: true });
      const isle = isleHost();
      if (isle) watch.observe(isle, { attributeFilter: ['data-et-rect', 'data-et-dock'] });
    };
    isleWatch = watch;
    observe();
  }

  // ---- Shape -------------------------------------------------------------------------------

  /** The page isle's host: a direct child of <html> only (a page can put an `et-isle` anywhere). */
  const isIsle = (target: EventTarget) =>
    (target as Node).nodeName === ISLE_TAG && (target as Node).parentNode === doc.documentElement;

  const isleHost = () => doc.documentElement.querySelector(`:scope > ${ISLE_TAG.toLowerCase()}`);

  /**
   * The isle host's `data-et-rect="x,y,w,h"`, when it has an area: four finite numbers, kept
   * within the viewport (a page can write anything there; huge values would overflow the
   * springs into NaN). Its `data-et-dock`, when one of the three, replaces the dock read at
   * opening: the isle regrows on another edge when the setting changes.
   */
  function readIsle(): PanelRect | undefined {
    const isle = isleHost();
    const edge = isle?.getAttribute('data-et-dock');
    if (edge === 'left' || edge === 'right' || edge === 'bottom') dock = edge;
    const parts = (isle?.getAttribute('data-et-rect') ?? '').split(',').map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
    const [x = 0, y = 0, w = 0, h = 0] = parts;
    const within = (n: number, max: number) => Math.max(0, Math.min(max, n));
    const rect = {
      x: within(x, viewport.w),
      y: within(y, viewport.h),
      w: within(w, viewport.w),
      h: within(h, viewport.h),
    };
    return rect.w > 0 && rect.h > 0 ? rect : undefined;
  }

  /**
   * The folded shape, W × H, the panel grows out of and folds back into: the edge strip, or
   * beside the isle a line along it (side docks: as tall as the isle; bottom: as wide).
   */
  function folded(): [number, number] {
    if (!anchor) return [0, STRIP];
    return dock === 'bottom' ? [anchor.w, 0] : [0, anchor.h];
  }

  function readViewport() {
    const root = doc.documentElement;
    viewport = {
      w: Math.min(root.clientWidth || win.innerWidth, win.innerWidth || root.clientWidth) || 1,
      h: Math.min(root.clientHeight || win.innerHeight, win.innerHeight || root.clientHeight) || 1,
    };
  }

  /**
   * Measures the content and moves the target rectangle there: the shape follows (springs),
   * the content jumps (it is invisible until the shape is mostly out, then the same size).
   */
  function resize(viewportChanged = false) {
    if (!els || !open) return;
    if (viewportChanged) readViewport();
    const measured = halted ? STRIP : els.content.offsetHeight || STRIP;
    anchor = readIsle();
    rect = placePanel(dock, viewport, measured, anchor);
    const { style } = els.content;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.w}px`;
    if (ctx) aim(rect.w, rect.h);
    else draw();
  }

  /** Light or dark, judged by the page under the panel's middle as the isle does. */
  function probe() {
    if (!host) return;
    const penv: ProbeEnv = {
      elementsFromPoint:
        env.elementsFromPoint ?? ((x: number, y: number) => doc.elementsFromPoint(x, y)),
      getComputedStyle:
        env.getComputedStyle ?? ((element: Element) => win.getComputedStyle(element)),
      host,
      prefersDark: () => !!media('(prefers-color-scheme: dark)')?.matches,
    };
    let theme: 'light' | 'dark' = 'light';
    try {
      theme = probeTheme(penv, rect.x + rect.w / 2, rect.y + rect.h / 2, doc.documentElement);
    } catch {
      // Hit testing broken by the page: light.
    }
    host.setAttribute('data-et-theme', theme);
  }

  function draw() {
    if (!els) return;
    const W = Math.max(0, springs.W.x);
    const H = Math.max(0, springs.H.x);
    // Anchored at the docked side's top; the bottom dock at the bottom right corner.
    const x = dock === 'left' ? rect.x : rect.x + rect.w - W;
    const y = dock === 'bottom' ? rect.y + rect.h - H : rect.y;
    els.shape.style.clipPath =
      W <= 0 || H <= 0
        ? 'inset(50%)'
        : `inset(${round2(y)}px ${round2(viewport.w - x - W)}px ${round2(viewport.h - y - H)}px ${round2(x)}px round ${RADIUS}px)`;
    const shadow = els.shadow.style;
    shadow.transform = `translate(${round2(x)}px,${round2(y)}px)`;
    shadow.width = `${round2(W)}px`;
    shadow.height = `${round2(H)}px`;
    shadow.opacity = W > 0 && H > 0 ? '1' : '0';
    // Opening: the content fades in over the last 40% of the shape's growth. Closing: out
    // over the first 35%, moving NUDGE px toward the edge. Above a bottom isle it grows
    // upward, so its height is the measure.
    const [size, full] = anchor && dock === 'bottom' ? [H, rect.h] : [W, rect.w];
    const grown = full > 0 ? clamp01(size / full) : 0;
    const gone = open ? 0 : clamp01((1 - grown) / 0.35);
    const content = els.content.style;
    content.opacity = String(round2(open ? clamp01((grown - 0.6) / 0.4) : 1 - gone));
    const nudge = round2(NUDGE * gone);
    content.transform =
      dock === 'bottom'
        ? `translateY(${nudge}px)`
        : `translateX(${dock === 'left' ? -nudge : nudge}px)`;
  }

  function tick() {
    frame = 0;
    const t = now();
    const dt = lastT ? Math.min(0.064, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    const restW = step(springs.W, dt);
    const resting = step(springs.H, dt) && restW;
    draw();
    if (!resting) {
      frame = raf(tick);
      return;
    }
    lastT = 0;
    els?.root.removeAttribute('data-anim');
    if (!open) unmount();
  }

  /** Points the shape at `w`×`h` (0 wide: folded into the edge); a retarget keeps velocity. */
  function aim(w: number, h: number) {
    if (!els) return;
    if (reduced()) {
      snap(springs.W, w);
      snap(springs.H, h);
      draw();
      return;
    }
    const params = open ? LIST : SHRINK;
    retarget(springs.W, w, params);
    retarget(springs.H, h, params);
    els.root.setAttribute('data-anim', '');
    if (!frame) {
      lastT = 0;
      frame = raf(tick);
    }
  }

  // ---- Open and close ----------------------------------------------------------------------

  function openPalette() {
    // Full screen: the page's top layer would cover it (the isle does not show either).
    if (disposed || open || doc.fullscreenElement) return;
    saved = saveFocus(doc);
    // A palette still folding away is replaced: a new one is placed for the current page.
    unmount();
    mount();
    if (!els) return;
    open = true;
    halted = false;
    epoch += 1;
    ctx = undefined;
    view = 'commands';
    lastSteal = Number.NEGATIVE_INFINITY;
    host?.setAttribute('data-open', '');
    snap(springs.W, 0);
    snap(springs.H, STRIP);
    readViewport();
    showCommands();
    // Listen first: a page focus trap answering this focus synchronously is then seen.
    listen(true);
    els.input.focus({ preventScroll: true });
    if (!open || !els) return;
    if (els.shadowRoot.activeElement !== els.input) {
      // Taken back once, checked again inside: still not ours closes.
      stolen(doc.activeElement);
      if (!open || !els || els.shadowRoot.activeElement !== els.input) {
        close(false);
        return;
      }
    }
    loadEngines();
    loadShortcuts();
    const opened = epoch;
    Promise.all([
      deps.page.getState().catch(() => ({ ...IDLE_PAGE_STATE })),
      deps.getConfig().catch(() => undefined),
    ]).then(([state, config]) => {
      if (opened !== epoch || !open) return;
      ctx = { state };
      dock = config?.page.isleDock ?? dock;
      target = config?.language.target;
      // Nothing has grown yet: start from the fold for this dock and isle.
      anchor = readIsle();
      const [w, h] = folded();
      snap(springs.W, w);
      snap(springs.H, h);
      if (state.halted) showHalted();
      else render();
      probe();
    });
  }

  function close(handBack = true) {
    if (!open) return;
    open = false;
    epoch += 1;
    listen(false);
    host?.removeAttribute('data-open');
    if (els) {
      // Nothing inside takes focus or input while it folds away.
      els.content.inert = true;
      els.input.blur();
    }
    if (handBack && !halted) restoreFocus(doc, saved);
    if (closingKey) swallowKeyUp(closingKey);
    stopQuick();
    saved = { element: null };
    if (!els) return;
    if (reduced()) {
      els.root.style.opacity = '0';
      fadeTimer = setTimeout(unmount, FADE_MS);
      return;
    }
    aim(...folded());
  }

  return {
    toggle() {
      // One floating layer at a time (decision 5): the shortcut ends a pick (the focus goes
      // back to the page), then opens the palette.
      picker.cancel();
      // A host the page removed, or hid with the dialog it sat in, is not open whatever the
      // flag says: the shortcut opens a new palette instead of closing an invisible one.
      if (open && host?.isConnected && host.checkVisibility?.() !== false) close();
      else {
        // Focus in the browser's own UI (address bar, devtools): keys would never reach the
        // palette, so it stays shut, like the selection card's shortcut.
        if (!doc.hasFocus()) return;
        close(false);
        openPalette();
      }
    },
    close() {
      picker.cancel();
      close();
    },
    dispose() {
      if (disposed) return;
      picker.dispose();
      close();
      disposed = true;
      unguard();
      requests.dispose();
      unmount();
    },
  };
}
