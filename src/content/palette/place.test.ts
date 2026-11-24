import { describe, expect, it } from 'vitest';
import { placePanel } from './place';

const vp = { w: 1280, h: 800 };

describe('placePanel', () => {
  it('pulls out of the right or left edge, the top at 30% of the viewport', () => {
    expect(placePanel('right', vp, 200)).toEqual({ x: 844, y: 240, w: 420, h: 200 });
    expect(placePanel('left', vp, 200)).toEqual({ x: 16, y: 240, w: 420, h: 200 });
  });

  it('rises to stay 16px above the bottom, but never above 16px from the top', () => {
    expect(placePanel('right', vp, 600)).toMatchObject({ y: 184 });
    expect(placePanel('left', { w: 1280, h: 300 }, 400)).toMatchObject({ y: 16, h: 268 });
  });

  it('grows upward from the bottom right corner on the bottom dock', () => {
    expect(placePanel('bottom', vp, 200)).toEqual({ x: 844, y: 584, w: 420, h: 200 });
  });

  it('keeps 16px on both sides of a narrow viewport', () => {
    expect(placePanel('right', { w: 360, h: 640 }, 100)).toMatchObject({ x: 16, w: 328 });
    expect(placePanel('bottom', { w: 360, h: 640 }, 100)).toMatchObject({ x: 16, w: 328 });
  });
});

describe('placePanel beside the isle', () => {
  const right = { x: 1224, y: 387, w: 40, h: 186 };

  it('right dock: 8px to the left of the isle, top-aligned with it', () => {
    expect(placePanel('right', vp, 200, right)).toEqual({ x: 796, y: 387, w: 420, h: 200 });
  });

  it('left dock: 8px to the right of the isle, top-aligned with it', () => {
    const left = { x: 16, y: 387, w: 40, h: 186 };
    expect(placePanel('left', vp, 200, left)).toEqual({ x: 64, y: 387, w: 420, h: 200 });
  });

  it('bottom dock: 8px above the isle, the right ends aligned', () => {
    const bottom = { x: 1078, y: 744, w: 186, h: 40 };
    expect(placePanel('bottom', vp, 200, bottom)).toEqual({ x: 844, y: 536, w: 420, h: 200 });
  });

  it('stays 16px inside the viewport', () => {
    // A tall panel beside an isle low on the edge rises to stay above the bottom.
    expect(placePanel('right', vp, 400, { ...right, y: 600 })).toMatchObject({ y: 384 });
    // An isle near the top: never above 16px.
    expect(placePanel('bottom', vp, 200, { x: 1078, y: 100, w: 186, h: 40 })).toMatchObject({
      y: 16,
    });
    // No room beside it: kept 16px from the left edge rather than leaving the viewport.
    expect(placePanel('right', { w: 360, h: 640 }, 100, { x: 304, y: 200, w: 40, h: 186 })).toEqual(
      { x: 16, y: 200, w: 328, h: 100 },
    );
    expect(placePanel('left', { w: 360, h: 640 }, 100, { x: 16, y: 200, w: 40, h: 186 })).toEqual({
      x: 16,
      y: 200,
      w: 328,
      h: 100,
    });
    // A bottom isle whose right end is short of the edge: the panel's right end follows it.
    expect(placePanel('bottom', vp, 100, { x: 300, y: 744, w: 186, h: 40 })).toMatchObject({
      x: 66,
    });
    expect(placePanel('bottom', vp, 100, { x: 100, y: 744, w: 186, h: 40 })).toMatchObject({
      x: 16,
    });
  });
});
