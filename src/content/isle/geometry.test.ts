import { describe, expect, it } from 'vitest';
import {
  alignedCenter,
  catchZone,
  clampOffset,
  clipPath,
  contains,
  contentRects,
  DOT_SIZE,
  dotCenter,
  homeOffset,
  liftOf,
  listFits,
  listHeight,
  MARGIN,
  rectOf,
  reservedLength,
  shapesFor,
  spanOf,
} from './geometry';

const VP = { w: 1280, h: 800 };

describe('shapesFor', () => {
  it('gives the dot, isle and list targets for the side docks', () => {
    for (const dock of ['right', 'left'] as const) {
      const shapes = shapesFor(dock, VP, { retry: false, options: 4 });
      expect(shapes.gone).toEqual({ L: 0, D: 0, R: 0 });
      // The shell under the 10px dot is one ring smaller (no dark edge around the dot).
      expect(shapes.dot).toEqual({ L: 8, D: 8, R: 4 });
      expect(shapes.isle).toEqual({ L: 186, D: 40, R: 20 });
      // Four rows: the prototype's 204px list, 200px wide beside the 40px isle.
      expect(shapes.list).toEqual({ L: 204, D: 240, R: 16 });
    }
  });

  it('lays the bottom dock out horizontally, the 240px list growing upward', () => {
    const shapes = shapesFor('bottom', VP, { retry: false, options: 4 });
    expect(shapes.dot).toEqual({ L: 8, D: 8, R: 4 });
    expect(shapes.isle).toEqual({ L: 186, D: 40, R: 20 });
    expect(shapes.list).toEqual({ L: 240, D: 244, R: 16 });
  });

  it('lengthens the isle for the retry button', () => {
    expect(shapesFor('right', VP, { retry: true, options: 4 }).isle.L).toBe(224);
    expect(shapesFor('bottom', VP, { retry: true, options: 4 }).list.L).toBe(240);
  });

  it('caps the list at 60% of the viewport height and keeps it inside the viewport', () => {
    expect(listHeight(4, VP)).toBe(204);
    expect(listHeight(40, VP)).toBe(480);
    const small = { w: 240, h: 260 };
    // Side docks: 60% of a 400px viewport is still longer than the 186px isle.
    const side = shapesFor('right', { w: 240, h: 400 }, { retry: false, options: 40 });
    expect(side.list.L).toBe(Math.floor(400 * 0.6));
    expect(side.list.D).toBe(240 - 2 * MARGIN);
    // Shorter than the isle, the list keeps the isle's length.
    expect(shapesFor('right', small, { retry: false, options: 40 }).list.L).toBe(186);
    // Bottom dock, right-anchored: the list is right-aligned and stays inside the
    // viewport on every side (narrower than 240 when the viewport is).
    const bottom = shapesFor('bottom', small, { retry: false, options: 40 });
    expect(bottom.list.L).toBe(240 - 2 * MARGIN);
    expect(bottom.list.D).toBe(40 + Math.floor(260 * 0.6));
    const anchor = clampOffset(homeOffset('bottom', small), bottom.list.L, 'bottom', small);
    const rect = rectOf('bottom', small, bottom.list.L, bottom.list.D, anchor);
    expect(rect.x).toBe(MARGIN);
    expect(rect.x + rect.w).toBe(240 - MARGIN);
    expect(rect.y).toBeGreaterThanOrEqual(MARGIN);
    // Risen over a banner, the list gets shorter rather than leaving the top.
    const risen = shapesFor('bottom', small, { retry: false, options: 40 }, 100);
    expect(risen.list.D).toBe(260 - 100 - MARGIN);
    expect(rectOf('bottom', small, risen.list.L, risen.list.D, anchor, 100).y).toBe(MARGIN);
  });

  it('reserves the longest view along the edge', () => {
    expect(reservedLength(shapesFor('right', VP, { retry: true, options: 1 }))).toBe(224);
    expect(reservedLength(shapesFor('right', VP, { retry: false, options: 8 }))).toBe(340);
  });
});

describe('edge coordinates', () => {
  it('maps L/D/O to a rectangle 16px off each edge', () => {
    expect(rectOf('right', VP, 148, 40, 480)).toEqual({ x: 1224, y: 406, w: 40, h: 148 });
    expect(rectOf('left', VP, 148, 40, 480)).toEqual({ x: 16, y: 406, w: 40, h: 148 });
    // Bottom dock: the offset is the right end, and the shape grows leftward from it.
    expect(rectOf('bottom', VP, 148, 40, 1264)).toEqual({ x: 1116, y: 744, w: 148, h: 40 });
    expect(rectOf('bottom', VP, 186, 40, 1264)).toEqual({ x: 1078, y: 744, w: 186, h: 40 });
    // A raised base lifts the lower edge.
    expect(rectOf('bottom', VP, 148, 40, 1264, 64)).toEqual({ x: 1116, y: 696, w: 148, h: 40 });
    expect(spanOf('bottom', 1264, 148)).toEqual([1116, 1264]);
    expect(spanOf('right', 480, 148)).toEqual([406, 554]);
  });

  it('keeps the dot shell concentric with the dot, and inside it', () => {
    for (const dock of ['right', 'left', 'bottom'] as const) {
      const offset = homeOffset(dock, VP);
      const shell = rectOf(dock, VP, 8, 8, offset);
      const dot = rectOf(dock, VP, DOT_SIZE, DOT_SIZE, offset);
      expect(shell.x + 4).toBe(dot.x + 5);
      expect(shell.y + 4).toBe(dot.y + 5);
      expect(shell.x).toBeGreaterThan(dot.x);
      expect(shell.x + shell.w).toBeLessThan(dot.x + dot.w);
      expect(dotCenter(dock, VP, offset)).toEqual([dot.x + 5, dot.y + 5]);
    }
    expect(dotCenter('bottom', VP, 1264)).toEqual([1259, 779]);
  });

  it('rests at 60% down the sides and in the bottom-right corner', () => {
    expect(homeOffset('right', VP)).toBe(480);
    expect(homeOffset('left', VP)).toBe(480);
    expect(homeOffset('bottom', VP)).toBe(VP.w - MARGIN);
  });

  it('clamps the offset so the whole shape stays inside the edge', () => {
    expect(clampOffset(20, 200, 'right', VP)).toBe(116);
    expect(clampOffset(790, 200, 'right', VP)).toBe(684);
    expect(clampOffset(400, 900, 'right', VP)).toBe(400);
    // Right-anchored: the right end stays 16px in, the left end too.
    expect(clampOffset(1300, 240, 'bottom', VP)).toBe(1264);
    expect(clampOffset(100, 240, 'bottom', VP)).toBe(256);
  });

  it('lifts the bottom dock over its floor, centering on a widget it steps around', () => {
    // Not stepping around anything: center = floor + 5 keeps every shape on the floor.
    expect(liftOf(16, 21, 5)).toBe(16);
    expect(liftOf(16, 21, 20)).toBe(16);
    expect(liftOf(64, 69, 4)).toBe(64);
    // Centered on a widget 46px up: the dot and the toolbar share its middle…
    expect(liftOf(16, 46, 5)).toBe(41);
    expect(liftOf(16, 46, 20)).toBe(26);
    // …the list's bottom row lines up with the toolbar…
    expect(liftOf(16, 46, 122)).toBe(26);
    // …and nothing sinks below the floor (16, or 8 above a banner).
    expect(liftOf(16, 30, 20)).toBe(16);
    expect(liftOf(64, 50, 20)).toBe(64);
  });

  it('writes clip-path insets, clamping the radius and growing for the outline', () => {
    const rect = { x: 1224, y: 406, w: 40, h: 148 };
    expect(clipPath(rect, VP, 20)).toBe('inset(406px 16px 246px 1224px round 20px)');
    expect(clipPath(rect, VP, 50)).toBe('inset(406px 16px 246px 1224px round 20px)');
    expect(clipPath(rect, VP, 20, 1)).toBe('inset(405px 15px 245px 1223px round 21px)');
    expect(clipPath({ x: 10, y: 10, w: 0, h: 0 }, VP, 0)).toBe('inset(50%)');
  });

  it('anchors the toolbar to the isle and the list on the page side of it', () => {
    const shapes = shapesFor('right', VP, { retry: false, options: 4 });
    const right = contentRects('right', VP, shapes, 480);
    expect(right.bar).toEqual({ x: 1224, y: 387, w: 40, h: 186 });
    expect(right.list).toEqual({ x: 1024, y: 378, w: 200, h: 204 });
    const left = contentRects('left', VP, shapes, 480);
    expect(left.list).toEqual({ x: 56, y: 378, w: 200, h: 204 });
    const bottomShapes = shapesFor('bottom', VP, { retry: false, options: 4 });
    const bottom = contentRects('bottom', VP, bottomShapes, 1264);
    expect(bottom.bar).toEqual({ x: 1078, y: 744, w: 186, h: 40 });
    // Right-aligned with the toolbar, the extra width reaching left.
    expect(bottom.list).toEqual({ x: 1024, y: 540, w: 240, h: 204 });
    const lifted = contentRects('bottom', VP, bottomShapes, 1264, 26);
    expect(lifted.bar.y).toBe(800 - 26 - 40);
    expect(lifted.list.y + lifted.list.h).toBe(lifted.bar.y);
  });

  it('puts the catch zone between the dot and its edge', () => {
    const zone = catchZone('right', VP, 480);
    const [x, y] = dotCenter('right', VP, 480);
    expect(contains(zone, x, y)).toBe(true);
    expect(contains(zone, VP.w - 100, 480)).toBe(false);
    // The scrollbar lies beyond the viewport width: not part of the zone.
    expect(contains(zone, VP.w + 6, 480)).toBe(false);
    expect(contains(catchZone('left', VP, 480), 4, 480)).toBe(true);
    const bottom = catchZone('bottom', VP, 1264);
    expect(contains(bottom, 1259, 779)).toBe(true);
    expect(contains(bottom, 1259, VP.h - 2)).toBe(true);
    expect(contains(bottom, 1100, 779)).toBe(false);
    expect(bottom.x + bottom.w).toBeLessThanOrEqual(VP.w);
    // Risen over a 56px banner: around the lifted dot, down to the banner's top only.
    const risen = catchZone('bottom', VP, 1264, 64, 56);
    expect(contains(risen, 1259, VP.h - 64 - 5)).toBe(true);
    expect(contains(risen, 1259, VP.h - 50)).toBe(false);
  });

  it('keeps the bottom catch zone a fixed size around a lifted dot, not a tall strip', () => {
    const resting = catchZone('bottom', VP, 1264);
    const lifted = catchZone('bottom', VP, 1264, 400);
    const [, cy] = dotCenter('bottom', VP, 1264, 400);
    expect(lifted.h).toBe(70);
    expect(lifted.y + lifted.h / 2).toBe(cy);
    expect(contains(lifted, 1259, VP.h - 2)).toBe(false);
    expect(lifted.w).toBe(resting.w);
  });
});

describe('lining up with a widget (bottom dock)', () => {
  const widget = (center: number, depth: number) => ({ center, depth });

  it('centers on a short widget that does not lift the dot past 30% of the viewport', () => {
    expect(alignedCenter(16, widget(46, 52), VP)).toBe(46);
    // 30% of 800 = 240: the dot's lower edge may sit at most 240px up.
    expect(alignedCenter(16, widget(245, 60), VP)).toBe(245);
    expect(alignedCenter(16, widget(246, 60), VP)).toBe(21);
  });

  it('stays on the floor beside a widget taller than 30% of the viewport', () => {
    // A full-height AI sidebar: step aside, do not float to the middle.
    expect(alignedCenter(16, widget(400, 800), VP)).toBe(21);
    expect(alignedCenter(64, widget(100, 241), VP)).toBe(69);
  });

  it('fits the engine list above the toolbar only with its header, footer and 3 rows', () => {
    // 68px of header, footer and padding plus 3 × 34px rows = 170px above the toolbar.
    expect(listFits({ w: 1024, h: 300 }, 16, 4)).toBe(true);
    expect(listFits({ w: 1024, h: 300 }, 74, 4)).toBe(true);
    expect(listFits({ w: 1024, h: 300 }, 75, 4)).toBe(false);
    // Fewer rows need less room; the 60% cap never asks for more than it shows.
    expect(listFits({ w: 1024, h: 300 }, 100, 1)).toBe(true);
    expect(listFits({ w: 1024, h: 280 }, 60, 3)).toBe(false);
    expect(listFits({ w: 1024, h: 280 }, 56, 3)).toBe(true);
  });
});
