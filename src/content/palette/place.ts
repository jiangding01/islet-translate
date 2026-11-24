import type { IsleDock } from '@/lib/config/types';

// Where the palette sits (docs/plans/m3c.md decision 6): beside the isle when it shows (its
// `data-et-rect`, PR6), otherwise pulled out of the edge the isle docks on. Pure, in
// viewport pixels.

/** Widest the palette gets; narrower viewports keep EDGE on both sides. */
export const PANEL_WIDTH = 420;
export const EDGE = 16;
/** Side docks: the panel's top at this share of the viewport height. */
export const TOP_SHARE = 0.3;
/** Between the isle and the panel beside it. */
export const GAP = 8;

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `n` kept within [lo, hi]; `lo` wins when the range is empty. */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The panel's rectangle for a content `height`. Beside the isle (`anchor`, its rectangle):
 * right dock GAP to its left, left dock GAP to its right, both top-aligned with it; bottom
 * dock GAP above it, right ends aligned; then kept EDGE inside the viewport. Without one:
 * side docks EDGE from that side, the top at 30% of the viewport, raised as needed to stay
 * EDGE above the bottom (never above EDGE from the top); bottom dock EDGE from the right and
 * the bottom, growing upward from the corner.
 */
export function placePanel(
  dock: IsleDock,
  viewport: { w: number; h: number },
  height: number,
  anchor?: PanelRect,
): PanelRect {
  const w = Math.max(0, Math.min(PANEL_WIDTH, viewport.w - 2 * EDGE));
  const h = Math.max(0, Math.min(height, viewport.h - 2 * EDGE));
  const maxX = viewport.w - EDGE - w;
  const maxY = viewport.h - EDGE - h;
  if (anchor) {
    const x =
      dock === 'left'
        ? anchor.x + anchor.w + GAP
        : dock === 'bottom'
          ? anchor.x + anchor.w - w
          : anchor.x - GAP - w;
    const y = dock === 'bottom' ? anchor.y - GAP - h : anchor.y;
    return { x: clamp(x, EDGE, maxX), y: clamp(y, EDGE, maxY), w, h };
  }
  const x = dock === 'left' ? EDGE : Math.max(EDGE, maxX);
  const y = dock === 'bottom' ? maxY : clamp(Math.round(viewport.h * TOP_SHARE), EDGE, maxY);
  return { x, y, w, h };
}
