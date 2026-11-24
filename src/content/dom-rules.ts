// Which elements are translated, kept as-is, or treated as boundaries. Pure DOM
// reads (no writes); shared by discovery and segmentation.

/** Our own nodes: the translations… */
export const OWN_TAG = 'ET-TR';
/** …and the hosts of our interface (docs/dom-contract.md). */
export const ISLE_TAG = 'ET-ISLE';
export const SELECTION_TAG = 'ET-SELECTION';
export const PALETTE_TAG = 'ET-PALETTE';
export const PICK_TAG = 'ET-PICK';
/**
 * The page isle (M2b), the selection card (M3a), the palette and its region picker (M3c):
 * never page content, whatever node they end up under (the palette and the picker join an
 * open modal dialog).
 */
export const HOST_TAGS: readonly string[] = [ISLE_TAG, SELECTION_TAG, PALETTE_TAG, PICK_TAG];

/** Never descended into: their text is not prose, or not ours to touch. */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'MATH',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'BUTTON',
  // HOST_TAGS, written out: a spread would pull the list into the resident bundle for
  // nothing (dom-rules.test checks the two agree).
  'ET-ISLE',
  'ET-SELECTION',
  'ET-PALETTE',
  'ET-PICK',
  'PRE',
  'HEAD',
  // Ruby readings (furigana) are pronunciation, not text to translate.
  'RT',
  'RP',
  'OBJECT',
  'EMBED',
]);

/** Kept verbatim inside a unit (cloned whole), never translated. */
export const VERBATIM_TAGS: ReadonlySet<string> = new Set([
  'CODE',
  'KBD',
  'SAMP',
  'VAR',
  'IMG',
  'BR',
  'WBR',
  'PICTURE',
]);

/** Block boundaries regardless of CSS. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'DD',
  'DT',
  'TD',
  'TH',
  'FIGCAPTION',
  'CAPTION',
  'SUMMARY',
  'ARTICLE',
  'SECTION',
  'HEADER',
  'FOOTER',
  'MAIN',
  'ASIDE',
  'UL',
  'OL',
  'DL',
  'TABLE',
  'TBODY',
  'THEAD',
  'TFOOT',
  'TR',
  'FIGURE',
  'FORM',
  'FIELDSET',
  'DETAILS',
  'HR',
  'ADDRESS',
]);

/** Inline regardless of CSS (flex/grid parents blockify their display). */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'A',
  'SPAN',
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'MARK',
  'S',
  'DEL',
  'INS',
  'SMALL',
  'SUB',
  'SUP',
  'ABBR',
  'CITE',
  'Q',
  'TIME',
  'LABEL',
  'FONT',
  'BDI',
  'BDO',
  'DFN',
  'RUBY',
  ...VERBATIM_TAGS,
]);

const SKIP_ROLES = new Set([
  'navigation',
  'button',
  'menu',
  'menubar',
  'tab',
  'tablist',
  'toolbar',
  // Children of role=img are presentational (the label carries the text), so a
  // drawing made of DOM text is not prose.
  'img',
]);

export const OWN_ATTR = 'data-et';

/** Nodes other translators insert. */
const FOREIGN_CLASSES = ['immersive-translate-target-wrapper', 'fluent-read-bilingual-content'];

/**
 * Host-bound skips, built in only: [hostname, selector]. Interface mock-ups drawn
 * with DOM text (monospace rows, short labels, filled in lazily) look like prose
 * to every generic rule.
 */
const SITE_SKIPS: readonly (readonly [string, string])[] = [['claude.dev', '.efx-fig']];

let siteSkipHost: string | undefined;
let siteSkipSelector = '';

/** Selector of the site skips for the element's page, or '' (cached per host). */
function siteSelector(el: Element): string {
  const host = el.ownerDocument.defaultView?.location.hostname ?? '';
  if (host !== siteSkipHost) {
    siteSkipHost = host;
    siteSkipSelector = SITE_SKIPS.filter(([site]) => host === site || host.endsWith(`.${site}`))
      .map(([, selector]) => selector)
      .join(',');
  }
  return siteSkipSelector;
}

const TOOLBAR_CLASS = /lang|filename|title|header|toolbar|copy/i;

function isBlankText(node: Node | null): boolean {
  return !node || node.nodeType !== Node.TEXT_NODE || !(node.nodeValue ?? '').trim();
}

/**
 * The label bar above a code block (language, file name, copy button): UI chrome
 * that would otherwise be translated and end up in the exported text. Deliberately
 * narrow, since a miss only leaves a short label untranslated while a false hit
 * silently drops real text: a plain DIV/SPAN right before the block (or before its
 * wrapper), with nothing but whitespace text beside it, that either holds a button
 * or is a single word-like token under a toolbar-ish class.
 */
function isCodeToolbar(el: Element): boolean {
  if (el.tagName !== 'DIV' && el.tagName !== 'SPAN') return false;
  const next = el.nextElementSibling;
  if (!next || (next.tagName !== 'PRE' && next.firstElementChild?.tagName !== 'PRE')) return false;
  if (!isBlankText(el.previousSibling) || !isBlankText(el.nextSibling)) return false;
  const text = el.textContent ?? '';
  if (el.querySelector('button')) return text.replace(/\s+/g, '').length <= 40;
  // getAttribute: an SVG's className is not a string.
  if (!TOOLBAR_CLASS.test(el.getAttribute('class') ?? '')) return false;
  const token = text.trim();
  return token.length <= 80 && !/\s/.test(token);
}

/**
 * Content that is never ours to translate or touch, whatever the layout: every skip
 * rule except the temporary-hiding ones (`hidden`, `inert`, `aria-hidden`), which only
 * say the page is not showing something for now (see `isSkipped`).
 */
export function isProtected(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName) || el.tagName === OWN_TAG || el.tagName === 'NAV') return true;
  if (el.hasAttribute(OWN_ATTR)) return true;
  const translate = el.getAttribute('translate');
  if (translate === 'no' || translate === 'false') return true;
  if (el.classList.contains('notranslate')) return true;
  if (FOREIGN_CLASSES.some((name) => el.classList.contains(name))) return true;
  const editable = el.getAttribute('contenteditable');
  if (editable !== null && editable !== 'false') return true;
  const role = el.getAttribute('role');
  if (role && SKIP_ROLES.has(role)) return true;
  if (isCodeToolbar(el)) return true;
  const selector = siteSelector(el);
  return selector !== '' && el.matches(selector);
}

/** A held paragraph's block, and a picked region, are never scanned past this much source text. */
export const HOLD_BLOCK_CHARS = 20_000;

/**
 * The element's source text length: our translations (`et-tr`) inside do not count, so a
 * translated block is not taken for twice its size.
 */
export function sourceLength(el: Element): number {
  let size = el.textContent?.length ?? 0;
  for (const tr of el.querySelectorAll(OWN_TAG)) size -= tr.textContent?.length ?? 0;
  return size;
}

/** Skipped together with its whole subtree (cheap attribute checks only, no layout). */
export function isSkipped(el: Element): boolean {
  if (isProtected(el)) return true;
  if (el.hasAttribute('hidden') || el.hasAttribute('inert')) return true;
  return el.getAttribute('aria-hidden') === 'true';
}

/**
 * The first protected element from `el` itself up to, but not including, `stop`
 * (normally the body), or null. Temporary hiding does not count.
 */
export function protectedAncestor(el: Element, stop: Element): Element | null {
  let node: Element | null = el;
  while (node && node !== stop) {
    if (isProtected(node)) return node;
    node = node.parentElement;
  }
  return null;
}

export interface LayoutStyle {
  display: string;
  position?: string;
  float?: string;
  whiteSpace?: string;
  textOverflow?: string;
}

export type StyleReader = (el: Element) => LayoutStyle | undefined;

const FLEX_OR_GRID = /^(inline-)?(flex|grid)$/;

/** Tag-only guess when no usable style is known. */
function inlineByTag(el: Element): boolean {
  if (INLINE_TAGS.has(el.tagName) || el.tagName.includes('-')) return true;
  return el.tagName !== 'DIV';
}

/**
 * Block or inline for unit boundaries, by how the element is actually laid out
 * (as FluentRead's `isBlockBoundary` does): sites style `<a>` and `<span>` as
 * rows and cards, so the tag alone is not enough. Semantic block tags are always
 * boundaries; images, code and breaks are always inline content. Everything else
 * follows its computed display, so flex and grid items, which the browser
 * blockifies, are each their own unit: merging them would also glue their text
 * together, since the gaps between items are drawn by CSS, not written in text.
 *
 * Three blockified cases stay inside their sentence:
 * - out-of-flow boxes (screen-reader-only text, floated badges) are not lines
 *   of their own, so the tag decides, as before;
 * - items of an `inline-flex` / `inline-grid` chip belong to that one inline box;
 * - ruby (`display: ruby*`) is inline text with annotations.
 */
export function isInlineElement(el: Element, readStyle: StyleReader): boolean {
  if (BLOCK_TAGS.has(el.tagName)) return false;
  if (VERBATIM_TAGS.has(el.tagName)) return true;
  const style = readStyle(el);
  const display = style?.display;
  // 'none' says nothing about the box it would have (and translation-only mode
  // hides children itself): fall back to the tag, as when no style is known.
  if (!style || !display || display === 'none') return inlineByTag(el);
  const outOfFlow =
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    (style.float !== undefined && style.float !== 'none');
  if (outOfFlow) return inlineByTag(el);
  const parent = el.parentElement;
  const parentDisplay = parent ? readStyle(parent)?.display : undefined;
  if (parentDisplay === 'inline-flex' || parentDisplay === 'inline-grid') return true;
  return display.startsWith('inline') || display.startsWith('ruby') || display === 'contents';
}

/** Whether the element lays its children out as flex or grid items. */
export function isFlexOrGrid(el: Element, readStyle: StyleReader): boolean {
  const display = readStyle(el)?.display;
  return !!display && FLEX_OR_GRID.test(display);
}

const NO_WRAP = /^(nowrap|pre)$/;

/**
 * Whether the author pinned the unit's root to one line, so a translation must not be
 * added to it (it would push the layout or be cut off). Reads only the root's own computed
 * style: `white-space` is inherited, so it is already resolved there.
 * - Appended inline (a run, or a flex / grid root, matching how render decides): `nowrap`
 *   or `pre` locks it.
 * - Any unit: `text-overflow: ellipsis` together with `nowrap` or `pre` (Tailwind `truncate`).
 * A line-clamp does not count (render lifts it), nor does `ellipsis` alone.
 */
export function isSingleLineLocked(
  unit: { kind: 'block' | 'run'; root: Element },
  readStyle: StyleReader,
): boolean {
  const style = readStyle(unit.root);
  if (!style?.whiteSpace || !NO_WRAP.test(style.whiteSpace)) return false;
  const appendedInline = unit.kind === 'run' || isFlexOrGrid(unit.root, readStyle);
  return appendedInline || style.textOverflow === 'ellipsis';
}

/** A cached getComputedStyle: one read per element per pass. */
export function createStyleReader(view: Window = window): StyleReader {
  const cache = new WeakMap<Element, LayoutStyle>();
  return (el) => {
    let style = cache.get(el);
    if (!style) {
      const computed = view.getComputedStyle(el);
      style = {
        display: computed.display,
        position: computed.position,
        float: computed.cssFloat,
        whiteSpace: computed.whiteSpace,
        textOverflow: computed.textOverflow,
      };
      cache.set(el, style);
    }
    return style;
  };
}
