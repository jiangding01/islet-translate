import type { ConfigV1 } from '@/lib/config/types';
import { isObviouslyTargetScript } from '@/lib/languages';
import { HOST_TAGS } from '../dom-rules';
import type { SelectionSnapshot } from '../runtime-contract';
import { composedRange } from './extract';
import { normalizeSelectionText } from './open';

// The always-loaded half of selection translation: watches for a selection worth a dot,
// with only cheap, synchronous checks. Nothing here loads the on-demand runtime or
// touches the page; the bootstrap does that when `onCandidate` fires.

/** Shorter selections (after normalization) are not worth a dot. */
export const MIN_LENGTH = 2;
/** Longer ones are never translated (plan 1.2 rule 5): no dot, and no truncation. */
export const MAX_LENGTH = 2000;
/** A selection settles shortly after the button is released… */
export const POINTER_DELAY_MS = 100;
/** …or after a keyboard selection (Shift+arrows). */
export const KEY_DELAY_MS = 50;
/** `selectionchange` fires per caret move: wait for it to stop. */
export const CHANGE_DEBOUNCE_MS = 200;
/** A vanished selection must stay gone this long before the dot is removed. */
export const CLEAR_GRACE_MS = 160;
/**
 * The raw text length (before whitespace collapses) beyond which the selection is dropped
 * without reading its text. Slack over MAX_LENGTH: runs of source whitespace shrink.
 */
const ESTIMATE_LIMIT = MAX_LENGTH * 4;

export interface SelectionWatchDeps {
  doc: Document;
  getConfig(): Promise<ConfigV1>;
  watchConfig(callback: (config: ConfigV1) => void): () => void;
  /** A selection passed every cheap filter; the dot should show for it. */
  onCandidate(selection: SelectionSnapshot): void;
  /** The selection the dot was shown for is gone or no longer qualifies. */
  onClear(): void;
}

/**
 * Inside the page isle, the selection card, the palette or its region picker (shared with the
 * hold watch).
 */
export function isOwnNode(node: Node | null): boolean {
  for (let current = node; current; current = current.parentNode) {
    if (HOST_TAGS.includes(current.nodeName)) return true;
  }
  return false;
}

/** The focused element, looked for inside open shadow roots (closed ones stop at the host). */
export function deepActiveElement(doc: Document): Element | null {
  let active = doc.activeElement;
  for (
    let inner = active?.shadowRoot?.activeElement;
    inner;
    inner = inner.shadowRoot?.activeElement
  ) {
    active = inner;
  }
  return active;
}

/**
 * Plan 4.3 rule 2: a focused input, textarea or editable element (inside open shadow roots
 * too), or a selection starting in editable content. `range` is the composed range when
 * the browser gives one, so its start is the real one inside a shadow root.
 */
function isEditableContext(doc: Document, range: Range): boolean {
  const active = deepActiveElement(doc);
  if (
    active &&
    (active.nodeName === 'INPUT' ||
      active.nodeName === 'TEXTAREA' ||
      (active as HTMLElement).isContentEditable === true)
  ) {
    return true;
  }
  const start = range.startContainer;
  const element = start.nodeType === 1 ? (start as Element) : start.parentElement;
  return (element as HTMLElement | null)?.isContentEditable === true;
}

/**
 * Sums the text-node lengths inside the range without building its string, giving up as
 * soon as the total passes `limit`. Partial first and last nodes are counted exactly.
 */
export function estimateLength(doc: Document, range: Range, limit: number): number {
  const { startContainer: start, startOffset, endContainer: end, endOffset } = range;
  if (start === end && start.nodeType === 3) return endOffset - startOffset;
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const first = start.nodeType === 3 ? start : (start.childNodes[startOffset] ?? null);
  if (!first) return 0;
  walker.currentNode = first;
  let total = 0;
  for (
    let node: Node | null = first.nodeType === 3 ? first : walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    // Past the end boundary: done.
    if (range.comparePoint(node, 0) > 0) break;
    const length = (node as Text).data.length;
    total += node === start ? length - startOffset : node === end ? endOffset : length;
    if (total > limit) break;
  }
  return total;
}

function sameBoundaries(a: Range, b: Range): boolean {
  // START_TO_START = 0, END_TO_END = 2.
  return a.compareBoundaryPoints(0, b) === 0 && a.compareBoundaryPoints(2, b) === 0;
}

function unionOf(rects: readonly DOMRect[]): SelectionSnapshot['rect'] {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { left, top, right, bottom };
}

/**
 * The selection's text and geometry, or undefined when it is empty or has no box.
 * `source` is the rendered text, normalized; the runtime refines it with the full
 * extraction (content/selection/extract) before it shows or sends anything.
 * `pointer` anchors the dot when the range only knows a shadow host.
 */
function snapshotOf(
  selection: Selection,
  selected: Range,
  pointer?: { x: number; y: number },
  // Inside a page's shadow root the range may point at the host (see composedRange).
  composed = composedRange(selection, selected),
): SelectionSnapshot | undefined {
  const source = normalizeSelectionText(selection.toString());
  if (!source) return undefined;
  const range = composed ?? selected;
  let rects = [...(range.getClientRects?.() ?? [])].filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length === 0) {
    const box = range.getBoundingClientRect?.();
    if (box && (box.width > 0 || box.height > 0)) rects = [box];
  }
  const last = rects.at(-1);
  if (!last) return undefined;
  // The dot sits at the bottom right of the last character (plan 1.3 rule 5).
  const anchor = composed === null && pointer ? pointer : { x: last.right, y: last.bottom };
  return { source, rect: unionOf(rects), anchor, range: range.cloneRange(), pointer };
}

/** The current top-document selection with no length limits; used when the card is asked for. */
export function readSelection(doc: Document): SelectionSnapshot | undefined {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  return snapshotOf(selection, selection.getRangeAt(0));
}

export interface SelectionWatch {
  start(): void;
  stop(): void;
}

export function createSelectionWatch(deps: SelectionWatchDeps): SelectionWatch {
  const { doc } = deps;
  const win = doc.defaultView;
  let pressed = false;
  /**
   * Where the last press ended (none after a key release): the card keeps its dot off it,
   * and it is the dot's anchor when the range only knows a shadow host.
   */
  let pointer: { x: number; y: number } | undefined;
  let shown = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let checks = 0;
  let last: { range: Range; text: string } | undefined;
  let config: ConfigV1 | undefined;
  let configRead: Promise<ConfigV1 | undefined> | undefined;
  let unwatchConfig: (() => void) | undefined;
  let running = false;

  const clearNow = () => {
    clearTimeout(clearTimer);
    clearTimer = undefined;
    last = undefined;
    if (!shown) return;
    shown = false;
    deps.onClear();
  };

  /** The selection is gone or unfit: remove the dot after the grace period. */
  const reject = () => {
    if (!shown || clearTimer) return;
    clearTimer = setTimeout(clearNow, CLEAR_GRACE_MS);
  };

  /** Read once on the first non-empty selection, then kept fresh by the watch. */
  const ensureConfig = (): Promise<ConfigV1 | undefined> => {
    configRead ??= (async () => {
      // Defer one tick so a synchronous failure cannot clear the cache before it is set.
      await Promise.resolve();
      try {
        // Subscribe first so a change between the read and the subscription is not lost.
        // Inside the try: once the extension is reloaded, even reading
        // `storage.onChanged` throws ("Extension context invalidated").
        unwatchConfig = deps.watchConfig((next) => {
          config = next;
          if (!next.selection.showDot) clearNow();
        });
        const read = await deps.getConfig();
        // A setting pushed while the read was out is newer than the read.
        config ??= read;
        return config;
      } catch {
        // Unsubscribed: what was pushed may go stale, so the next check reads again.
        try {
          unwatchConfig?.();
        } catch {
          // Extension reloaded: even unsubscribing throws.
        }
        unwatchConfig = undefined;
        configRead = undefined;
        config = undefined;
        return undefined;
      }
    })();
    return configRead;
  };

  const check = async () => {
    checkTimer = undefined;
    if (pressed) return;
    const token = ++checks;
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return reject();
    const range = selection.getRangeAt(0);
    const composed = composedRange(selection, range);
    if (isEditableContext(doc, composed ?? range)) return reject();
    if (isOwnNode(range.startContainer) || isOwnNode(range.endContainer)) return reject();
    if (estimateLength(doc, range, ESTIMATE_LIMIT) > ESTIMATE_LIMIT) return reject();
    const snapshot = snapshotOf(selection, range, pointer, composed);
    if (!snapshot || snapshot.source.length < MIN_LENGTH || snapshot.source.length > MAX_LENGTH) {
      return reject();
    }
    const current = config ?? (await ensureConfig());
    // A newer check (or stop) overtook this one while the config was read.
    if (token !== checks || !running) return;
    if (!current?.selection.showDot) return reject();
    if (isObviouslyTargetScript(snapshot.source, current.language.target)) return reject();
    clearTimeout(clearTimer);
    clearTimer = undefined;
    // The same selection again (a key release, a repeated event): the dot is already there.
    if (shown && last?.text === snapshot.source && sameBoundaries(last.range, range)) return;
    last = { range: range.cloneRange(), text: snapshot.source };
    shown = true;
    deps.onCandidate(snapshot);
  };

  const schedule = (delay: number) => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void check(), delay);
  };

  const onPointerDown = () => {
    pressed = true;
  };
  const onPointerUp = (event: PointerEvent) => {
    pressed = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(POINTER_DELAY_MS);
  };
  const onBlur = () => {
    pressed = false;
  };
  const onKeyUp = () => {
    // A keyboard selection: the last release says nothing about where it ends.
    pointer = undefined;
    schedule(KEY_DELAY_MS);
  };
  const onSelectionChange = () => schedule(CHANGE_DEBOUNCE_MS);

  const listen = { capture: true, passive: true } as const;
  return {
    start() {
      if (running) return;
      running = true;
      doc.addEventListener('pointerdown', onPointerDown, listen);
      doc.addEventListener('pointerup', onPointerUp, listen);
      doc.addEventListener('pointercancel', onPointerUp, listen);
      doc.addEventListener('keyup', onKeyUp, listen);
      doc.addEventListener('selectionchange', onSelectionChange, listen);
      win?.addEventListener('blur', onBlur);
    },
    stop() {
      if (!running) return;
      running = false;
      doc.removeEventListener('pointerdown', onPointerDown, listen);
      doc.removeEventListener('pointerup', onPointerUp, listen);
      doc.removeEventListener('pointercancel', onPointerUp, listen);
      doc.removeEventListener('keyup', onKeyUp, listen);
      doc.removeEventListener('selectionchange', onSelectionChange, listen);
      win?.removeEventListener('blur', onBlur);
      clearTimeout(checkTimer);
      clearTimeout(clearTimer);
      checkTimer = undefined;
      clearTimer = undefined;
      try {
        unwatchConfig?.();
      } catch {
        // Extension reloaded: even unsubscribing throws ("Extension context invalidated").
      }
      unwatchConfig = undefined;
      configRead = undefined;
      config = undefined;
      shown = false;
      last = undefined;
    },
  };
}
