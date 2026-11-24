import type { PageMode, PageStyle } from '@/lib/config/types';
import type { LanguageCode } from '@/lib/languages';
import { captureAnchor, restoreAnchor } from './anchor';
import type { Unit } from './discover';
import { isFlexOrGrid, isSkipped, OWN_TAG, type StyleReader, VERBATIM_TAGS } from './dom-rules';
import { message, uiLocale } from './i18n';
import { plainTranslation, restoreTranslation, segment } from './segment';

// Puts translations into the page and takes them out again. Never rewrites or
// moves host nodes: only inserts <et-tr> and sets a few attributes, all undone
// on restore. Reads layout first, writes in one animation frame, animates with
// interruptible Web Animations on opacity/filter only.
// The <et-tr> element, `lang`, `data-et-inline`, `data-et-only` and `data-et-state` are a
// public contract (docs/dom-contract.md): export tools read them. Changing one is a
// breaking change, noted in CHANGELOG.md.

export interface RenderOptions {
  win: Window;
  style: PageStyle;
  target: LanguageCode;
  readStyle: StyleReader;
}

interface Rendered {
  unit: Unit;
  el: HTMLElement;
  inline: boolean;
  failed: boolean;
  /** A "too long" note: not a translation, not a failure (nothing to retry). */
  skipped?: boolean;
  /** Translation-only patch: the root's style attribute before, and right after, the pins. */
  only?: { original: string | null; applied: string | null };
  unclamped?: Element;
  animation?: Animation;
}

export interface Result {
  unit: Unit;
  translation: string;
}

export interface Renderer {
  /** Inserts translations; units that changed or left the page are skipped and returned. */
  insert(results: readonly Result[]): Promise<Unit[]>;
  /** Shows "Not translated · Retry" where the translation would go. */
  fail(unit: Unit, onRetry: () => void, detail?: string): Promise<void>;
  /** Shows "Too long to translate" where the translation would go. No button, no animation. */
  skip(unit: Unit): Promise<void>;
  /**
   * Puts a small loading dot where the translation will go. Written on the next frame, and
   * only if nothing else (a translation, a failure, hideLoading) claimed the unit meanwhile.
   */
  showLoading(unit: Unit): Promise<void>;
  /** Removes the unit's loading dot, or cancels one not written yet. */
  hideLoading(unit: Unit): void;
  /** Removes every loading dot, whoever asked for it. */
  hideAllLoading(): void;
  /** Removes one unit's translation and loading dot at once (source changed). */
  drop(unit: Unit): void;
  setMode(mode: PageMode): Promise<void>;
  /** Restyles every translation in place (the setting changed while translating). */
  setStyle(style: PageStyle): void;
  /** Fades visible translations out, then removes everything in one frame. */
  restoreAll(): Promise<void>;
  has(unit: Unit): boolean;
  isFailed(unit: Unit): boolean;
  /** The unit's source is still in the page with the same text (it may be hidden for now). */
  isCurrent(unit: Unit): boolean;
  /** The unit whose translation or note `el` is. */
  unitOf(el: Element): Unit | undefined;
  /** Units whose translation is no longer in the page (framework re-render). */
  detached(): Unit[];
  /** A translation this renderer took out of the page itself: not a change to react to. */
  removedByUs(node: Node): boolean;
  readonly mode: PageMode;
}

const APPEAR_MS = 200;
const STAGGER_MS = 30;
const MAX_STAGGERED = 6;
const VANISH_MS = 140;
const SWAP_HALF_MS = 60;
const REDUCED_MS = 100;

/** Closest non-transparent background is dark (luminance < 0.4); checks up to 8 ancestors. */
function readHostDark(el: Element, win: Window): boolean {
  let current: Element | null = el;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const match = win.getComputedStyle(current).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (match?.[1]) {
      const [r = 255, g = 255, b = 255, a = 1] = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (a > 0.05) {
        const channel = (value: number) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) < 0.4;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function findClamp(root: Element, win: Window): Element | undefined {
  let current: Element | null = root;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const style = win.getComputedStyle(current) as CSSStyleDeclaration & {
      webkitLineClamp?: string;
    };
    const clamp = style.webkitLineClamp ?? style.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') return current;
    current = current.parentElement;
  }
  return undefined;
}

export function inViewport(el: Element, win: Window): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > 0 && rect.top < win.innerHeight && rect.right > 0 && rect.left < win.innerWidth
  );
}

/** Where an inline translation goes in a flex/grid root: after the last piece of text. */
function inlineSpot(root: Element): { parent: Node; before: Node | null } {
  for (let index = root.childNodes.length - 1; index >= 0; index -= 1) {
    const child = root.childNodes[index] as Node;
    if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim()) {
      return { parent: root, before: child.nextSibling };
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (isSkipped(el) || !(el.textContent ?? '').trim()) continue;
      if (VERBATIM_TAGS.has(el.tagName)) return { parent: root, before: el.nextSibling };
      return { parent: el, before: null };
    }
  }
  return { parent: root, before: null };
}

export function createRenderer(options: RenderOptions): Renderer {
  const { win, readStyle } = options;
  const doc = win.document;
  const rendered = new Map<Unit, Rendered>();
  /** Translations detach() removed from the live page; the mutation watch skips their removal. */
  const removedOurselves = new WeakSet<Node>();
  /**
   * Loading dots live apart from `rendered`: they are not translations, so has / canBeOnly /
   * detached / setMode never see them. `token` is the registration of the latest showLoading;
   * 0 means cancelled (a dot already in the page then waits to be replaced or removed).
   */
  const loadings = new Map<Unit, { el?: HTMLElement; token: number }>();
  let loadingToken = 0;
  const hostDark = new WeakMap<Element, boolean>();
  let mode: PageMode = 'bilingual';
  let style = options.style;
  /**
   * Set when the restore begins. Writes still waiting for their frame (insert,
   * fail, a mode switch) must not land after it, or they would outlive the session.
   */
  let disposed = false;
  /**
   * How many times each unit was dropped. A write that waits for its frame (insert, fail,
   * skip) notes the count first and gives up if a drop came meanwhile: the unit was
   * forgotten, and writing would leave an orphan, or a second copy once its successor is in.
   * A count, not a set of units in flight: two writes of one unit may wait for the same frame.
   */
  const drops = new WeakMap<Unit, number>();
  const dropsOf = (unit: Unit) => drops.get(unit) ?? 0;
  /** The mode switch in flight, and the mode the last request asked for. */
  let switching: Promise<void> | undefined;
  let wanted: PageMode = mode;

  const reduced = () => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const frame = () =>
    new Promise<void>((resolve) => {
      if (win.requestAnimationFrame) win.requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  const isDark = (root: Element) => {
    let dark = hostDark.get(root);
    if (dark === undefined) {
      dark = readHostDark(root, win);
      hostDark.set(root, dark);
    }
    return dark;
  };

  // Contract (docs/dom-contract.md): tag, `lang`, `data-et-inline`.
  function makeElement(dark: boolean, inline: boolean): HTMLElement {
    const el = doc.createElement('et-tr');
    el.setAttribute('data-et-s', style);
    el.setAttribute('lang', options.target);
    el.setAttribute('translate', 'no');
    el.setAttribute('dir', 'auto');
    if (dark) el.setAttribute('data-et-host', 'dark');
    if (inline) el.setAttribute('data-et-inline', '');
    return el;
  }

  /** Cancels a pending showLoading; a dot already written stays until the write phase removes it. */
  function cancelLoading(unit: Unit) {
    const entry = loadings.get(unit);
    if (!entry) return;
    if (entry.el) entry.token = 0;
    else loadings.delete(unit);
  }

  function clearLoading(unit: Unit) {
    loadings.get(unit)?.el?.remove();
    loadings.delete(unit);
  }

  function appear(record: Rendered, delay: number) {
    if (typeof record.el.animate !== 'function') return;
    const soft = reduced();
    record.el.style.willChange = soft ? 'opacity' : 'opacity, filter';
    const animation = record.el.animate(
      soft ? [{ opacity: 0 }, {}] : [{ opacity: 0, filter: 'blur(2px)' }, { filter: 'blur(0px)' }],
      {
        duration: soft ? REDUCED_MS : APPEAR_MS,
        delay,
        easing: 'cubic-bezier(.2,0,0,1)',
        fill: 'backwards',
      },
    );
    record.animation = animation;
    const done = () => {
      if (record.animation === animation) record.animation = undefined;
      record.el.style.removeProperty('will-change');
    };
    animation.finished.then(done, done);
  }

  function place(record: Rendered, flexRoot: boolean) {
    const { unit, el } = record;
    if (unit.kind === 'run') {
      const last = unit.nodes[unit.nodes.length - 1];
      if (last?.parentNode) last.parentNode.insertBefore(el, last.nextSibling);
      return;
    }
    if (flexRoot) {
      const spot = inlineSpot(unit.root);
      spot.parent.insertBefore(el, spot.before);
      return;
    }
    unit.root.append(el);
  }

  // A paragraph whose link tags did not survive is hidden too: in translation-only
  // its links are unreachable until the reader switches back to bilingual.
  function canBeOnly(record: Rendered): boolean {
    return record.unit.kind === 'block' && !record.inline && !record.failed && !record.skipped;
  }

  type OnlyReading = {
    record: Rendered;
    fontSize: string;
    lineHeight: string;
    letterSpacing: string;
    wordSpacing: string;
    pins: [string, string][];
  };
  // font-size:0 also zeroes the root's own em/ch lengths (`max-width: 80ch` would
  // stack the translation one character per line), so these are pinned in pixels.
  // getComputedStyle gives computed values here: em/ch resolved, keywords and % kept.
  const PINNED = [
    'min-width',
    'max-width',
    'min-height',
    'max-height',
    'flex-basis',
    'text-indent',
  ];
  // getComputedStyle reports used pixels for these even when they are `auto` or a
  // percentage; the Typed OM keeps the keyword and the percentage (so `margin: 0 auto`
  // stays centred and `padding: 5%` follows the window), and resolves em to pixels.
  const PINNED_TYPED = [
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'width',
    'height',
  ];
  const KEYWORD = /^[a-z-]+$/;
  function readOnly(record: Rendered): OnlyReading {
    const root = record.unit.root;
    const style = win.getComputedStyle(root);
    const typed = typeof root.computedStyleMap === 'function' ? root.computedStyleMap() : null;
    const pins: [string, string][] = PINNED.map((name) => [name, style.getPropertyValue(name)]);
    // computedStyleMap is in every Chrome this extension supports (130+); the guard only
    // keeps environments without it (tests) from pinning used pixels.
    for (const name of PINNED_TYPED) pins.push([name, String(typed?.get(name) ?? '')]);
    return {
      record,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      // Inherited from the root as computed lengths: zeroed with its font-size, so the
      // translation gets the values from before.
      letterSpacing: style.getPropertyValue('letter-spacing'),
      wordSpacing: style.getPropertyValue('word-spacing'),
      pins,
    };
  }
  function applyOnly({
    record,
    fontSize,
    lineHeight,
    letterSpacing,
    wordSpacing,
    pins,
  }: OnlyReading) {
    if (record.only) return;
    const root = record.unit.root as HTMLElement;
    const original = root.getAttribute('style');
    // Keywords (auto, none) are left to the host so its own rules keep applying.
    for (const [name, value] of pins) {
      if (value && !KEYWORD.test(value)) root.style.setProperty(name, value);
    }
    // Reading the attribute also syncs it: Chrome syncs the style attribute lazily, and a
    // later removeAttribute would leave a pending sync that writes back an empty `style=""`.
    record.only = { original, applied: root.getAttribute('style') };
    // Contract: on the original, hides its direct children other than <et-tr>.
    root.setAttribute('data-et-only', '');
    record.el.style.setProperty('--et-fs', fontSize);
    record.el.style.setProperty('--et-lh', lineHeight);
    if (letterSpacing) record.el.style.setProperty('--et-ls', letterSpacing);
    if (wordSpacing) record.el.style.setProperty('--et-ws', wordSpacing);
  }
  // Puts the style attribute back, keeping what the page changed meanwhile. Untouched: the
  // original string verbatim. Otherwise the original is written back and the page's
  // differences from the pinned string are replayed on it. Properties are compared as
  // longhands: a shorthand with var() reads as '' in Chrome, so remembering per-property
  // originals would lose it.
  function restoreStyle(root: HTMLElement, { original, applied }: NonNullable<Rendered['only']>) {
    const current = root.getAttribute('style');
    if (current === applied) {
      if (original === null) root.removeAttribute('style');
      else root.setAttribute('style', original);
      return;
    }
    // The page removed the attribute itself: keep it removed.
    if (current === null) return;
    const pinned = doc.createElement('div').style;
    pinned.cssText = applied ?? '';
    const now = root.style;
    const names = new Set([...Array.from(pinned), ...Array.from(now)]);
    const changes: [string, string, string][] = [];
    for (const name of names) {
      const value = now.getPropertyValue(name);
      const priority = now.getPropertyPriority(name);
      if (value !== pinned.getPropertyValue(name) || priority !== pinned.getPropertyPriority(name))
        changes.push([name, value, priority]);
    }
    if (original === null) root.removeAttribute('style');
    else root.setAttribute('style', original);
    for (const [name, value, priority] of changes) {
      if (value) root.style.setProperty(name, value, priority);
      else root.style.removeProperty(name);
    }
    if (original === null && root.style.length === 0) {
      root.getAttribute('style');
      root.removeAttribute('style');
    }
  }
  function removeOnly(record: Rendered) {
    if (!record.only) return;
    const root = record.unit.root;
    root.removeAttribute('data-et-only');
    restoreStyle(root as HTMLElement, record.only);
    record.el.style.removeProperty('--et-fs');
    record.el.style.removeProperty('--et-lh');
    record.el.style.removeProperty('--et-ls');
    record.el.style.removeProperty('--et-ws');
    record.only = undefined;
  }

  function detach(record: Rendered) {
    record.animation?.cancel();
    removeOnly(record);
    if (record.el.isConnected) removedOurselves.add(record.el);
    record.el.remove();
    record.unclamped?.removeAttribute('data-et-unclamp');
  }

  function stillSame(unit: Unit): boolean {
    if (!unit.root.isConnected) return false;
    if (unit.kind === 'run' && unit.nodes.some((node) => node.parentNode !== unit.root))
      return false;
    const nodes =
      unit.kind === 'block'
        ? [...unit.root.childNodes].filter((n) => n.nodeName !== OWN_TAG)
        : unit.nodes;
    return segment(nodes).digest === unit.seg.digest;
  }

  const has = (unit: Unit) => {
    const record = rendered.get(unit);
    return !!record && !record.failed && !record.skipped;
  };

  async function swapMode(): Promise<void> {
    const switchable = () =>
      [...rendered.values()].filter((record) => record.el.isConnected && canBeOnly(record));
    const records = switchable();
    const anchor = captureAnchor(win);
    const visibleRoots = records.map((r) => r.unit.root).filter((root) => inViewport(root, win));
    const animated = typeof doc.body.animate === 'function' && !reduced();
    // First half: the visible paragraphs fade out together. Only our own
    // animations are tracked and cancelled: the host's stay untouched.
    const fades: Animation[] = [];
    if (animated && visibleRoots.length > 0) {
      for (const root of visibleRoots) {
        fades.push(
          root.animate([{}, { opacity: 0 }], {
            duration: SWAP_HALF_MS,
            easing: 'ease-in',
            fill: 'forwards',
          }),
        );
      }
      await Promise.all(fades.map((fade) => fade.finished.catch(() => undefined)));
      if (disposed) {
        for (const fade of fades) fade.cancel();
        return;
      }
    }
    // Requests that came in during the fade: only the last one counts, read once. When
    // it is the mode already on screen, nothing changes but the fade back in.
    const next = wanted;
    if (next !== mode) {
      // Re-read: translations inserted during the fade must switch too.
      const current = switchable();
      const readings = next === 'translation' ? current.map(readOnly) : [];
      mode = next;
      if (next === 'translation') for (const reading of readings) applyOnly(reading);
      else for (const record of current) removeOnly(record);
      restoreAnchor(anchor, win);
    }
    // Second half: fade back in, then drop our animations so host styles rule again.
    if (animated && visibleRoots.length > 0) {
      for (const fade of fades) fade.cancel();
      for (const root of visibleRoots) {
        root.animate([{ opacity: 0 }, {}], { duration: SWAP_HALF_MS, easing: 'ease-out' });
      }
    }
  }

  /**
   * A placeholder that is plugin UI, not translation: a failure (with a retry button, fades
   * in) or a "too long" note (plain text, no animation). Written on the next frame.
   */
  async function note(unit: Unit, skippedNote: boolean, fill: (el: HTMLElement) => void) {
    cancelLoading(unit);
    if (!unit.root.isConnected) {
      clearLoading(unit);
      return;
    }
    const dark = isDark(unit.root);
    const flexRoot = unit.kind === 'block' && isFlexOrGrid(unit.root, readStyle);
    if (disposed) return;
    const dropped = dropsOf(unit);
    await frame();
    // Forgotten while waiting (dropped): no orphan note.
    if (disposed || dropsOf(unit) !== dropped) return;
    if (skippedNote) {
      // Its place is gone: no orphan note.
      if (!unit.root.isConnected) return;
      const last = unit.nodes[unit.nodes.length - 1];
      if (unit.kind === 'run' && last?.parentNode !== unit.root) return;
    }
    const previous = rendered.get(unit);
    if (previous) detach(previous);
    clearLoading(unit);
    const inline = unit.kind === 'run' || flexRoot;
    const record: Rendered = {
      unit,
      el: makeElement(dark, inline),
      inline,
      failed: !skippedNote,
      skipped: skippedNote,
    };
    // Contract: an <et-tr> with data-et-state holds plugin UI, not translation. Any new
    // non-translation content must carry a state too (docs/dom-contract.md).
    record.el.setAttribute('data-et-state', skippedNote ? 'skipped' : 'error');
    // Plugin UI, not translation: the interface language, not makeElement's target one.
    record.el.setAttribute('lang', uiLocale());
    fill(record.el);
    place(record, flexRoot);
    rendered.set(unit, record);
    if (!skippedNote) appear(record, 0);
  }

  return {
    get mode() {
      return mode;
    },

    has,
    isFailed: (unit) => rendered.get(unit)?.failed === true,
    isCurrent: (unit) => stillSame(unit),
    unitOf: (el) => [...rendered.values()].find((record) => record.el === el)?.unit,

    removedByUs: (node) => removedOurselves.has(node),

    detached: () =>
      [...rendered.values()].filter((record) => !record.el.isConnected).map((r) => r.unit),

    async insert(results) {
      // Read phase: everything that touches layout, before any write.
      const stale: Unit[] = [];
      const plans: {
        result: Result;
        dropped: number;
        flexRoot: boolean;
        visible: boolean;
        dark: boolean;
        clamp?: Element;
      }[] = [];
      for (const result of results) {
        const { unit } = result;
        if (!stillSame(unit)) {
          stale.push(unit);
          continue;
        }
        cancelLoading(unit);
        const flexRoot = unit.kind === 'block' && isFlexOrGrid(unit.root, readStyle);
        plans.push({
          result,
          dropped: dropsOf(unit),
          flexRoot,
          visible: inViewport(unit.root, win),
          dark: isDark(unit.root),
          clamp: findClamp(unit.root, win),
        });
      }
      if (plans.length === 0 || disposed) return stale;
      await frame();
      if (disposed) return stale;

      // Write phase: one frame for the whole batch.
      const onlyReadings: OnlyReading[] = [];
      const fresh: Rendered[] = [];
      let staggered = 0;
      for (const { result, dropped, flexRoot, visible, dark, clamp } of plans) {
        const { unit, translation } = result;
        // Forgotten while waiting for the frame: its successor gets its own translation.
        if (dropsOf(unit) !== dropped) continue;
        const previous = rendered.get(unit);
        if (previous) detach(previous);
        clearLoading(unit);
        const inline = unit.kind === 'run' || flexRoot;
        const rebuilt = restoreTranslation(translation, unit.seg, doc);
        const content = rebuilt ?? plainTranslation(translation, unit.seg, doc);
        const record: Rendered = {
          unit,
          el: makeElement(dark, inline),
          inline,
          failed: false,
        };
        record.el.append(content);
        place(record, flexRoot);
        if (clamp) {
          clamp.setAttribute('data-et-unclamp', '');
          record.unclamped = clamp;
        }
        rendered.set(unit, record);
        fresh.push(record);
        if (visible) {
          appear(record, Math.min(staggered, MAX_STAGGERED) * STAGGER_MS);
          staggered += 1;
        }
      }
      if (mode === 'translation') {
        for (const record of fresh) if (canBeOnly(record)) onlyReadings.push(readOnly(record));
        for (const reading of onlyReadings) applyOnly(reading);
      }
      return stale;
    },

    fail: (unit, onRetry, detail) =>
      note(unit, false, (el) => {
        if (detail) el.title = detail;
        el.append(doc.createTextNode(message('render.failed')));
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = message('render.retry');
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onRetry();
        });
        el.append(doc.createTextNode(' ·'), button);
      }),

    skip: (unit) =>
      note(unit, true, (el) => {
        el.append(doc.createTextNode(message('render.skipped')));
      }),

    setStyle(next) {
      style = next;
      for (const record of rendered.values()) record.el.setAttribute('data-et-s', next);
    },

    async showLoading(unit) {
      if (disposed || !unit.root.isConnected) return;
      const existing = loadings.get(unit);
      if (existing?.el && existing.token !== 0) return;
      loadingToken += 1;
      const token = loadingToken;
      if (existing) existing.token = token;
      else loadings.set(unit, { token });
      const dark = isDark(unit.root);
      const flexRoot = unit.kind === 'block' && isFlexOrGrid(unit.root, readStyle);
      await frame();
      const entry = loadings.get(unit);
      if (!entry || entry.token !== token || has(unit) || disposed) return;
      if (!unit.root.isConnected) {
        if (!entry.el) loadings.delete(unit);
        return;
      }
      // A failure placeholder is replaced; removing only its element would leave a record
      // that detached() takes for a translation the page threw away.
      const previous = rendered.get(unit);
      if (previous) {
        detach(previous);
        rendered.delete(unit);
      }
      entry.el?.remove();
      // Contract: a state, no data-et-s (no translation styles), no text: the page's reader
      // gets nothing to read. Plugin UI, so the interface language.
      const el = doc.createElement('et-tr');
      el.setAttribute('data-et-state', 'loading');
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('translate', 'no');
      el.setAttribute('lang', uiLocale());
      if (dark) el.setAttribute('data-et-host', 'dark');
      entry.el = el;
      place({ unit, el, inline: true, failed: false }, flexRoot);
    },

    hideLoading(unit) {
      clearLoading(unit);
    },

    hideAllLoading() {
      for (const entry of loadings.values()) entry.el?.remove();
      loadings.clear();
    },

    drop(unit) {
      // Before the early return below: a write waiting for its frame has no record yet.
      drops.set(unit, dropsOf(unit) + 1);
      clearLoading(unit);
      const record = rendered.get(unit);
      if (!record) return;
      detach(record);
      rendered.delete(unit);
    },

    setMode(next) {
      if (disposed) return Promise.resolve();
      // A switch in flight takes every later request as "the last word": only the
      // target is updated, and the one Promise settles once that target is applied.
      if (switching) {
        wanted = next;
        return switching;
      }
      if (next === mode) return Promise.resolve();
      wanted = next;
      const run = swapMode().finally(() => {
        if (switching === run) switching = undefined;
      });
      switching = run;
      return run;
    },

    async restoreAll() {
      disposed = true;
      const records = [...rendered.values()];
      const anchor = captureAnchor(win);
      for (const entry of loadings.values()) entry.el?.remove();
      loadings.clear();
      const animated = typeof doc.body.animate === 'function';
      if (animated) {
        const soft = reduced();
        // Read every starting point first, then animate from where each one is now.
        const starts = records
          .filter((record) => record.el.isConnected && inViewport(record.el, win))
          .map((record) => {
            const style = win.getComputedStyle(record.el);
            return {
              record,
              opacity: style.opacity,
              filter: style.filter === 'none' ? 'blur(0px)' : style.filter,
            };
          });
        await Promise.all(
          starts.map(({ record, opacity, filter }) => {
            record.animation?.cancel();
            return record.el
              .animate(
                [
                  { opacity, filter },
                  { opacity: 0, filter: soft ? filter : 'blur(2px)' },
                ],
                {
                  duration: soft ? REDUCED_MS : VANISH_MS,
                  easing: 'cubic-bezier(.4,0,1,1)',
                  fill: 'forwards',
                },
              )
              .finished.catch(() => undefined);
          }),
        );
      }
      await frame();
      for (const record of records) detach(record);
      rendered.clear();
      mode = 'bilingual';
      restoreAnchor(anchor, win);
    },
  };
}
