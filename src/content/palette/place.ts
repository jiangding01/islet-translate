import type { IsleDock } from '@/lib/config/types';

// Where the palette sits (docs/plans/m3c.md decision 6) while the isle does not show: pulled
// out of the edge the isle docks on. Pure, in viewport pixels.

/** Widest the palette gets; narrower viewports keep EDGE on both sides. */
export const PANEL_WIDTH = 420;
export const EDGE = 16;
/** Side docks: the panel's top at this share of the viewport height. */
export const TOP_SHARE = 0.3;

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The panel's rectangle for a content `height`. Side docks: EDGE from that side, the top at
 * 30% of the viewport, raised as needed to stay EDGE above the bottom (never above EDGE from
 * the top). Bottom dock: EDGE from the right and the bottom, growing upward from the corner.
 */
export function placePanel(
  dock: IsleDock,
  viewport: { w: number; h: number },
  height: number,
): PanelRect {
  const w = Math.max(0, Math.min(PANEL_WIDTH, viewport.w - 2 * EDGE));
  const h = Math.max(0, Math.min(height, viewport.h - 2 * EDGE));
  const x = dock === 'left' ? EDGE : Math.max(EDGE, viewport.w - EDGE - w);
  const y =
    dock === 'bottom'
      ? viewport.h - EDGE - h
      : Math.max(EDGE, Math.min(Math.round(viewport.h * TOP_SHARE), viewport.h - EDGE - h));
  return { x, y, w, h };
}
