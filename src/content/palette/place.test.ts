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
