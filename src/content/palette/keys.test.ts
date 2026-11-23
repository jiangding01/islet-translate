import { describe, expect, it } from 'vitest';
import { keyAction, moveActive } from './keys';

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, isComposing: false, keyCode: 0, ...extra }) as KeyboardEvent;

describe('keyAction', () => {
  it.each([
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['Enter', 'run'],
    ['Escape', 'back'],
    ['Tab', 'stay'],
    ['s', undefined],
    ['ArrowLeft', undefined],
    ['Backspace', undefined],
  ])('%s → %s', (k, expected) => {
    expect(keyAction(key(k))).toBe(expected);
  });

  it('leaves every key to an input method while it composes', () => {
    for (const k of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape', 'Tab']) {
      expect(keyAction(key(k, { isComposing: true }))).toBeUndefined();
      expect(keyAction(key(k, { keyCode: 229 }))).toBeUndefined();
    }
  });

  it('goes back to the commands on ← or Backspace in an empty engine list only', () => {
    expect(keyAction(key('Backspace'), true)).toBe('parent');
    expect(keyAction(key('ArrowLeft'), true)).toBe('parent');
    expect(keyAction(key('Backspace'), false)).toBeUndefined();
    expect(keyAction(key('Backspace', { isComposing: true }), true)).toBeUndefined();
  });
});

describe('moveActive', () => {
  it('starts at the first enabled row and wraps both ways, skipping disabled rows', () => {
    const disabled = [true, false, true, false];
    expect(moveActive(disabled, -1, 1)).toBe(1);
    expect(moveActive(disabled, 1, 1)).toBe(3);
    expect(moveActive(disabled, 3, 1)).toBe(1);
    expect(moveActive(disabled, 1, -1)).toBe(3);
  });

  it('is -1 with no enabled row', () => {
    expect(moveActive([], -1, 1)).toBe(-1);
    expect(moveActive([true, true], -1, 1)).toBe(-1);
  });
});
