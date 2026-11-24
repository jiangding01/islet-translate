import type { IsleDock } from '@/lib/config/types';

// Edge coordinates (ui-isle-direction section 3): every state of the one isle element
// is a length along the edge (L), a depth away from it (D), a corner radius (R) and
// an offset along the edge (O): the center on the side docks, the right end on the
// bottom dock (which sits in the bottom-right corner and grows leftward). The bottom
// dock also has a base: how far the shape's lower edge sits above the viewport's
// bottom (16px, or lifted over a banner or centered on a widget it steps around).
// Element geometry, not design tokens: these sizes come from the confirmed prototype
// (IsleM2) and drive the springs directly.

export type View = 'gone' | 'dot' | 'isle' | 'list';

export interface Shape {
  L: number;
  D: number;
  R: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/** Gap between the viewport edge and the isle (keeps the dot off the scrollbar). */
export const MARGIN = 16;
/** The amber dot. */
export const DOT_SIZE = 10;
/**
 * The dark shell (and its outline) at the dot: one ring smaller than the dot, so it
 * hides entirely under the amber and no dark edge antialiases out around it. Growth
 * starts from here.
 */
export const DOT_SHELL = 8;
export const ISLE_DEPTH = 40;
const ISLE_RADIUS = 20;
const LIST_RADIUS = 16;
/** Mode segment (3 × 28 + gaps + padding), separator, the engine and the palette buttons. */
const ISLE_LENGTH = 186;
/** Plus the retry button and its gap. */
const ISLE_LENGTH_RETRY = 224;
const LIST_WIDTH = 200;
/** The bottom dock's list: right-aligned to the isle, the extra width reaching left. */
const LIST_WIDTH_BOTTOM = 240;
/** One engine row. */
export const LIST_ROW = 34;
/** Header, footer and padding around the rows (the prototype's 204px for 4 rows). */
const LIST_CHROME = 68;
/** The list never takes more than this share of the viewport height; rows scroll inside. */
const LIST_MAX_SHARE = 0.6;
/** Bottom dock: the list needs room for its header, footer and this many rows above the toolbar. */
const LIST_MIN_ROWS = 3;
/**
 * Bottom dock: the isle lines up with a widget it steps around only when the widget is
 * at most this share of the viewport tall and lining up lifts the dot no higher.
 */
const ALIGN_MAX_SHARE = 0.3;
/** Where the dot rests by default: 60% down the side edges (the bottom dock: right corner). */
const HOME_SIDE = 0.6;
/** Pointer catch zone around the dot: reach from the edge and half-length along it. */
const CATCH_REACH = 56;
const CATCH_HALF = 36;
/** The bottom dock's catch zone: from this far left of the right end to this far past it. */
const CATCH_LEFT = 46;
const CATCH_RIGHT = 12;

export function isVertical(dock: IsleDock): boolean {
  return dock !== 'bottom';
}

export function edgeLength(dock: IsleDock, viewport: Viewport): number {
  return isVertical(dock) ? viewport.h : viewport.w;
}

/** Height of the engine list for `count` rows, capped at 60% of the viewport. */
export function listHeight(count: number, viewport: Viewport): number {
  return Math.min(
    LIST_CHROME + LIST_ROW * Math.max(1, count),
    Math.floor(viewport.h * LIST_MAX_SHARE),
  );
}

export interface ShapeInput {
  /** The retry button is showing. */
  retry: boolean;
  /** Engine rows in the list. */
  options: number;
}

/**
 * Target shapes of every view for one dock and viewport. `base` (bottom dock) is the
 * toolbar's lower edge above the viewport bottom: the list grows upward from there
 * and stays inside the viewport.
 */
export function shapesFor(
  dock: IsleDock,
  viewport: Viewport,
  input: ShapeInput,
  base = MARGIN,
): Record<View, Shape> {
  const isleL = input.retry ? ISLE_LENGTH_RETRY : ISLE_LENGTH;
  const rows = listHeight(input.options, viewport);
  const maxAlong = edgeLength(dock, viewport) - 2 * MARGIN;
  const list: Shape = isVertical(dock)
    ? {
        L: Math.min(Math.max(isleL, rows), maxAlong),
        D: Math.min(ISLE_DEPTH + LIST_WIDTH, viewport.w - 2 * MARGIN),
        R: LIST_RADIUS,
      }
    : {
        L: Math.min(Math.max(isleL, LIST_WIDTH_BOTTOM), maxAlong),
        D: Math.max(ISLE_DEPTH, Math.min(ISLE_DEPTH + rows, viewport.h - base - MARGIN)),
        R: LIST_RADIUS,
      };
  return {
    gone: { L: 0, D: 0, R: 0 },
    dot: { L: DOT_SHELL, D: DOT_SHELL, R: DOT_SHELL / 2 },
    isle: { L: Math.min(isleL, maxAlong), D: ISLE_DEPTH, R: ISLE_RADIUS },
    list,
  };
}

/** The longest any view gets along the edge: avoidance and clamping reserve this much. */
export function reservedLength(shapes: Record<View, Shape>): number {
  return Math.max(shapes.isle.L, shapes.list.L);
}

export function homeOffset(dock: IsleDock, viewport: Viewport): number {
  if (!isVertical(dock)) return viewport.w - MARGIN;
  return Math.round(viewport.h * HOME_SIDE);
}

/** The edge interval [start, end] a shape of `length` at `offset` covers. */
export function spanOf(dock: IsleDock, offset: number, length: number): [number, number] {
  return isVertical(dock) ? [offset - length / 2, offset + length / 2] : [offset - length, offset];
}

/** Offsets that keep a shape of `length` inside the edge (with the margin); min > max when it cannot fit. */
export function offsetRange(dock: IsleDock, viewport: Viewport, length: number): [number, number] {
  const edge = edgeLength(dock, viewport);
  if (!isVertical(dock)) return [length + MARGIN, edge - MARGIN];
  return [length / 2 + MARGIN, edge - length / 2 - MARGIN];
}

/** Keeps a shape of `length` at `offset` inside the edge (with the margin). */
export function clampOffset(
  offset: number,
  length: number,
  dock: IsleDock,
  viewport: Viewport,
): number {
  const [min, max] = offsetRange(dock, viewport, length);
  if (min > max) {
    const edge = edgeLength(dock, viewport);
    return isVertical(dock) ? edge / 2 : (edge + length) / 2;
  }
  return Math.min(max, Math.max(min, offset));
}

/**
 * Bottom dock: the lower edge of a shape whose half depth is `half`. Off a widget it
 * sits on the floor (`center` is then floor + 5); stepping around one, its middle
 * goes to `center`, never below the floor. The half depth is clamped to the dot's
 * and the toolbar's, so the list's bottom row lines up with the toolbar.
 */
export function liftOf(floor: number, center: number, half: number): number {
  const h = Math.max(DOT_SIZE / 2, Math.min(ISLE_DEPTH / 2, half));
  return floor + Math.max(0, center - h - floor);
}

/**
 * Bottom dock: the middle to line up with a widget the isle steps around (`center` and
 * `depth`, its own height, measured from the bottom edge), or the floor's own (floor
 * + 5) when the widget is taller than 30% of the viewport or lining up would lift the
 * dot's lower edge more than 30% of the viewport off the bottom: a full-height sidebar
 * is only stepped around, not followed up to the middle of the page.
 */
export function alignedCenter(
  floor: number,
  widget: { center: number; depth: number },
  viewport: Viewport,
): number {
  const cap = viewport.h * ALIGN_MAX_SHARE;
  if (widget.depth > cap || liftOf(floor, widget.center, DOT_SIZE / 2) > cap) {
    return floor + DOT_SIZE / 2;
  }
  return widget.center;
}

/**
 * Bottom dock: whether the engine list, grown up from a toolbar whose lower edge is
 * `base`, has room for its header, footer and 3 rows (all of them when it has fewer,
 * never more than its 60% cap).
 */
export function listFits(viewport: Viewport, base: number, count: number): boolean {
  const need = Math.min(listHeight(count, viewport), LIST_CHROME + LIST_ROW * LIST_MIN_ROWS);
  return viewport.h - base - ISLE_DEPTH - MARGIN >= need;
}

/** A shape thinner than the dot (its shell, or folding away) stays concentric with it. */
const inset = (size: number) => Math.max(0, (DOT_SIZE - size) / 2);

/** Edge coordinates → viewport rectangle; `base` is the bottom dock's lower edge. */
export function rectOf(
  dock: IsleDock,
  viewport: Viewport,
  length: number,
  depth: number,
  offset: number,
  base = MARGIN,
): Rect {
  const d = inset(depth);
  if (dock === 'left') return { x: MARGIN + d, y: offset - length / 2, w: depth, h: length };
  if (dock === 'bottom') {
    return {
      x: offset - inset(length) - length,
      y: viewport.h - base - d - depth,
      w: length,
      h: depth,
    };
  }
  return { x: viewport.w - MARGIN - d - depth, y: offset - length / 2, w: depth, h: length };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `clip-path` for a rectangle, optionally grown by `grow` px on every side. */
export function clipPath(rect: Rect, viewport: Viewport, radius: number, grow = 0): string {
  const w = Math.max(0, rect.w);
  const h = Math.max(0, rect.h);
  if (w === 0 || h === 0) return 'inset(50%)';
  const r = Math.max(0, Math.min(radius, w / 2, h / 2)) + grow;
  const top = rect.y - grow;
  const left = rect.x - grow;
  const right = viewport.w - rect.x - w - grow;
  const bottom = viewport.h - rect.y - h - grow;
  return `inset(${round2(top)}px ${round2(right)}px ${round2(bottom)}px ${round2(left)}px round ${round2(r)}px)`;
}

/**
 * Where the toolbar and the list sit once grown; content is anchored there, not to the
 * shape. `base` is the toolbar's lower edge on the bottom dock.
 */
export function contentRects(
  dock: IsleDock,
  viewport: Viewport,
  shapes: Record<View, Shape>,
  offset: number,
  base = MARGIN,
): { bar: Rect; list: Rect } {
  const bar = rectOf(dock, viewport, shapes.isle.L, ISLE_DEPTH, offset, base);
  const outer = rectOf(dock, viewport, shapes.list.L, shapes.list.D, offset, base);
  const inner = shapes.list.D - ISLE_DEPTH;
  let list: Rect;
  if (dock === 'right') list = { x: outer.x, y: outer.y, w: inner, h: outer.h };
  else if (dock === 'left') list = { x: outer.x + ISLE_DEPTH, y: outer.y, w: inner, h: outer.h };
  else list = { x: outer.x, y: outer.y, w: outer.w, h: inner };
  return { bar, list };
}

/** The dot's center; `base` is the dot's lower edge on the bottom dock. */
export function dotCenter(
  dock: IsleDock,
  viewport: Viewport,
  offset: number,
  base = MARGIN,
): [number, number] {
  const half = DOT_SIZE / 2;
  if (dock === 'left') return [MARGIN + half, offset];
  if (dock === 'bottom') return [offset - half, viewport.h - base - half];
  return [viewport.w - MARGIN - half, offset];
}

/**
 * Where a slow pointer counts as "at the dot": from the edge inward, around the
 * offset. On the bottom dock it is a fixed-size box around the (possibly lifted) dot,
 * cut off at the viewport edge, or at the top of the banner (`banner` px tall) it sits
 * over: resting on the floor it reaches the edge, lifted it never becomes a tall strip.
 */
export function catchZone(
  dock: IsleDock,
  viewport: Viewport,
  offset: number,
  base = MARGIN,
  banner = 0,
): Rect {
  if (dock === 'left') return { x: 0, y: offset - CATCH_HALF, w: CATCH_REACH, h: CATCH_HALF * 2 };
  if (dock === 'bottom') {
    const [, cy] = dotCenter(dock, viewport, offset, base);
    // 35px above and below the dot's center: on the floor that runs past the edge.
    const half = CATCH_REACH - MARGIN - DOT_SIZE / 2;
    const top = cy - half;
    const x = offset - CATCH_LEFT;
    return {
      x,
      y: top,
      w: Math.min(viewport.w, offset + CATCH_RIGHT) - x,
      h: Math.max(0, Math.min(cy + half, viewport.h - banner) - top),
    };
  }
  return {
    x: viewport.w - CATCH_REACH,
    y: offset - CATCH_HALF,
    w: CATCH_REACH,
    h: CATCH_HALF * 2,
  };
}

export function contains(rect: Rect, x: number, y: number, pad = 0): boolean {
  return (
    x >= rect.x - pad &&
    x <= rect.x + rect.w + pad &&
    y >= rect.y - pad &&
    y <= rect.y + rect.h + pad
  );
}

/** Unit vector pointing from the page toward the docked edge. */
export function outward(dock: IsleDock): [number, number] {
  if (dock === 'left') return [-1, 0];
  if (dock === 'bottom') return [0, 1];
  return [1, 0];
}
