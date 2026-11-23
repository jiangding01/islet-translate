import type { IsleDock } from '@/lib/config/types';
import { PALETTE_TAG, SELECTION_TAG } from '../dom-rules';
import {
  DOT_SIZE,
  edgeLength,
  isVertical,
  MARGIN,
  offsetRange,
  spanOf,
  type Viewport,
} from './geometry';

// Layout reads, done only before an animation starts (mount, resize, about to open):
// the page's own fixed or sticky widgets the isle should step around, a banner along
// the bottom it should rise above, and whether the page under the dot is light or dark.

export interface ProbeEnv {
  /** `document.elementsFromPoint`, top-most first. */
  elementsFromPoint(x: number, y: number): Element[];
  getComputedStyle(
    element: Element,
  ): Pick<CSSStyleDeclaration, 'position' | 'bottom' | 'backgroundColor' | 'colorScheme'>;
  /** The isle's host: never an obstacle nor a background. */
  host: Element;
  /** `prefers-color-scheme: dark`, for a page that only declares `color-scheme: light dark`. */
  prefersDark(): boolean;
}

/** Room left between the isle and a widget it steps around. */
export const AVOID_GAP = 8;
/** Widgets longer than this share of the edge (full-width banners) are not avoided. */
const MAX_OBSTACLE_SHARE = 0.5;
/** Spacing of the sample points along the reserved band. */
const SAMPLE_STEP = 24;
/** A bottom banner spans more than this share of the viewport width… */
const BANNER_MIN_SPAN = 0.5;
/** …and is at most this share of its height; taller ones are ignored, not risen over. */
const BANNER_MAX_SHARE = 0.3;

function topmost(env: ProbeEnv, x: number, y: number): Element | undefined {
  for (const element of env.elementsFromPoint(x, y)) {
    // Neither the isle, the selection card nor the palette is an obstacle or a background.
    const name = element.nodeName;
    if (element !== env.host && name !== SELECTION_TAG && name !== PALETTE_TAG) return element;
  }
  return undefined;
}

/** The nearest fixed or sticky element on the ancestor chain (the element itself included). */
export function pinnedAncestor(env: ProbeEnv, start: Element): Element | undefined {
  for (let node: Element | null = start; node; node = node.parentElement) {
    if (node === env.host) return undefined;
    const position = env.getComputedStyle(node).position;
    if (position === 'fixed' || position === 'sticky') return node;
  }
  return undefined;
}

export interface Band {
  /** Depths (px from the edge) of the sample columns. */
  depths: number[];
  /** Offset (as the dock anchors it) and length along the edge. */
  offset: number;
  length: number;
}

export interface Obstacle {
  /** The interval [lo, hi] the widget occupies along the edge. */
  lo: number;
  hi: number;
  /** Distance from the docked edge to the widget's middle. */
  center: number;
  /** The widget's own extent away from the edge (its height on the bottom dock). */
  depth: number;
}

/**
 * The page's fixed or sticky widgets inside the band. Widgets spanning more than half
 * of the edge are ignored: there is nowhere along the edge to step around them.
 */
export function findObstacles(
  env: ProbeEnv,
  dock: IsleDock,
  viewport: Viewport,
  band: Band,
): Obstacle[] {
  const vertical = isVertical(dock);
  const edge = edgeLength(dock, viewport);
  const [from, to] = spanOf(dock, band.offset, band.length);
  const start = Math.max(0, from);
  const end = Math.min(edge, to);
  const seen = new Set<Element>();
  const found: Obstacle[] = [];
  for (const depth of band.depths) {
    for (let along = start; along <= end + 0.5; along += SAMPLE_STEP) {
      const a = Math.min(along, end);
      const x = vertical ? (dock === 'left' ? depth : viewport.w - depth) : a;
      const y = vertical ? a : viewport.h - depth;
      const hit = topmost(env, x, y);
      const pinned = hit && pinnedAncestor(env, hit);
      if (!pinned || seen.has(pinned)) continue;
      seen.add(pinned);
      const rect = pinned.getBoundingClientRect();
      const lo = vertical ? rect.top : rect.left;
      const hi = vertical ? rect.bottom : rect.right;
      if (hi - lo > edge * MAX_OBSTACLE_SHARE || hi <= lo) continue;
      const middle = vertical ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2;
      const center =
        dock === 'left' ? middle : dock === 'right' ? viewport.w - middle : viewport.h - middle;
      const extent = vertical ? rect.right - rect.left : rect.bottom - rect.top;
      found.push({ lo, hi, center, depth: extent });
    }
  }
  return found;
}

/** Fixed, or sticky and stuck to the bottom (a `top: 0` header scrolled in from below is not). */
function heldToBottom(env: ProbeEnv, element: Element): boolean {
  const { position, bottom } = env.getComputedStyle(element);
  return position === 'fixed' || (position === 'sticky' && !!bottom && bottom !== 'auto');
}

/**
 * Bottom dock: the height of a banner pinned along the bottom, so the isle can rise
 * above it; 0 without one, and always 0 on the side docks. A banner is fixed (or
 * sticky with a `bottom`), sits on the bottom edge (within 1px) without reaching above
 * the viewport, is at most 30% of the viewport tall (its own height, not the part
 * showing), wider than half the viewport and across the dot's column: a centered bar
 * that leaves the corner free is not risen over. The middle is sampled too, for a
 * banner that something else covers at the dot's column.
 */
export function findBanner(env: ProbeEnv, dock: IsleDock, viewport: Viewport): number {
  if (isVertical(dock)) return 0;
  let top = viewport.h;
  const y = viewport.h - 1;
  const column = viewport.w - MARGIN - DOT_SIZE / 2;
  for (const x of [viewport.w / 2, column]) {
    const hit = topmost(env, x, y);
    const pinned = hit && pinnedAncestor(env, hit);
    if (!pinned || !heldToBottom(env, pinned)) continue;
    const rect = pinned.getBoundingClientRect();
    if (
      Math.abs(rect.bottom - viewport.h) <= 1 &&
      rect.top >= 0 &&
      rect.bottom - rect.top <= viewport.h * BANNER_MAX_SHARE &&
      rect.right - rect.left > viewport.w * BANNER_MIN_SPAN &&
      rect.left <= column &&
      rect.right >= column
    ) {
      top = Math.min(top, rect.top);
    }
  }
  return Math.max(0, viewport.h - top);
}

export interface Avoided {
  offset: number;
  /** The widget stepped around (undefined when nothing was in the way or nothing fits). */
  obstacle?: Obstacle;
}

/**
 * The offset nearest to `preferred` where a shape of `length` clears every obstacle
 * by AVOID_GAP and stays inside the edge; `preferred` (clamped) when nothing fits.
 */
export function avoid(
  preferred: number,
  length: number,
  obstacles: Obstacle[],
  dock: IsleDock,
  viewport: Viewport,
): Avoided {
  const edge = edgeLength(dock, viewport);
  const [min, max] = offsetRange(dock, viewport, length);
  const middle = isVertical(dock) ? edge / 2 : (edge + length) / 2;
  const clamp = (n: number) => (min > max ? middle : Math.min(max, Math.max(min, n)));
  const clear = (offset: number) => {
    const [start, end] = spanOf(dock, offset, length);
    return obstacles.every(({ lo, hi }) => end <= lo - AVOID_GAP || start >= hi + AVOID_GAP);
  };
  const home = clamp(preferred);
  if (clear(home)) return { offset: home };
  const ahead = isVertical(dock) ? length / 2 : 0;
  const behind = isVertical(dock) ? length / 2 : length;
  const candidates = obstacles
    .flatMap((obstacle) => [
      { offset: obstacle.lo - AVOID_GAP - ahead, obstacle },
      { offset: obstacle.hi + AVOID_GAP + behind, obstacle },
    ])
    .filter(({ offset }) => offset >= min && offset <= max && clear(offset))
    .sort((a, b) => Math.abs(a.offset - preferred) - Math.abs(b.offset - preferred));
  return candidates[0] ?? { offset: home };
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function numberOf(token: string | undefined, scale: number): number {
  if (!token || token === 'none') return 0;
  if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * scale;
  return Number.parseFloat(token);
}

/**
 * Relative luminance (0–1) and alpha of a computed color, or undefined when the
 * format is unknown. Computed styles serialize as rgb()/rgba(), or keep modern
 * spaces (oklch, oklab, lab, lch, color()) as authored.
 */
export function parseColor(value: string): { luminance: number; alpha: number } | undefined {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { luminance: 0, alpha: 0 };
  const match = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (!match) return undefined;
  const [, fn = '', body = ''] = match;
  const [main = '', alphaPart] = body.split('/');
  let parts = main
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  let alphaToken = alphaPart?.trim();
  if (alphaToken === undefined && (fn === 'rgba' || fn === 'rgb') && parts.length === 4) {
    alphaToken = parts[3];
    parts = parts.slice(0, 3);
  }
  const alpha = alphaToken === undefined ? 1 : numberOf(alphaToken, 1);
  let rgb: Rgba | undefined;
  if (fn === 'rgb' || fn === 'rgba') {
    rgb = {
      r: numberOf(parts[0], 255) / 255,
      g: numberOf(parts[1], 255) / 255,
      b: numberOf(parts[2], 255) / 255,
      a: alpha,
    };
  } else if (fn === 'color') {
    // color(srgb r g b): other spaces are close enough for a light/dark split.
    rgb = {
      r: numberOf(parts[1], 1),
      g: numberOf(parts[2], 1),
      b: numberOf(parts[3], 1),
      a: alpha,
    };
  } else if (fn === 'oklch' || fn === 'oklab') {
    // OKLab lightness cubed approximates luminance for the neutral backgrounds pages use.
    const l = numberOf(parts[0], 1);
    return { luminance: Math.max(0, Math.min(1, l)) ** 3, alpha };
  } else if (fn === 'lab' || fn === 'lch') {
    const l = numberOf(parts[0], 100) / 100;
    const f = (l * 100 + 16) / 116;
    return { luminance: l > 0.08 ? f ** 3 : (l * 100) / 903.3, alpha };
  }
  if (!rgb) return undefined;
  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return { luminance, alpha: rgb.a };
}

/** Under this relative luminance a background reads as dark (about L* 50). */
const DARK_LUMINANCE = 0.18;
/** A background at least this opaque decides; fainter ones let the parent show. */
const OPAQUE_ALPHA = 0.5;

/**
 * Light or dark host, judged by the page's background under (x, y), not the system
 * theme: the first opaque background up the ancestor chain of the top-most element
 * (pages often paint on a wrapper and leave html and body transparent); with none,
 * the root's `color-scheme`; otherwise light.
 */
export function probeTheme(env: ProbeEnv, x: number, y: number, root: Element): 'light' | 'dark' {
  const start = topmost(env, x, y) ?? root;
  for (let node: Element | null = start; node; node = node.parentElement) {
    const color = parseColor(env.getComputedStyle(node).backgroundColor ?? '');
    if (color && color.alpha >= OPAQUE_ALPHA) {
      return color.luminance < DARK_LUMINANCE ? 'dark' : 'light';
    }
  }
  const scheme = (env.getComputedStyle(root).colorScheme ?? '').split(/\s+/);
  if (scheme.includes('dark')) {
    if (!scheme.includes('light')) return 'dark';
    return env.prefersDark() ? 'dark' : 'light';
  }
  return 'light';
}
