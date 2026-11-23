// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigV1, HoldKey } from '@/lib/config/types';
import { createHoldWatch, HOLD_MS, type HoldWatch } from './watch';

let watch: HoldWatch | undefined;
let onHold: ReturnType<typeof vi.fn<(point: { x: number; y: number }) => void>>;
/** Pushes a config change to the running watch, as `storage.onChanged` would. */
let push: (holdKey: HoldKey) => void;
let unwatch: ReturnType<typeof vi.fn<() => void>>;

const configWith = (holdKey: HoldKey) => ({ page: { holdKey } }) as ConfigV1;

/** The config read settles (a microtask) before the keys are listened to. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/**
 * happy-dom dispatches only untrusted events: tests trust them unless told otherwise.
 * `read` is the stored config's answer; pass a pending promise to hold it back.
 */
async function setup(
  isTrusted: (event: Event) => boolean = () => true,
  read: Promise<ConfigV1> | HoldKey = 'ctrl',
) {
  onHold = vi.fn();
  unwatch = vi.fn();
  watch = createHoldWatch({
    doc: document,
    onHold,
    isTrusted,
    getConfig: () => (typeof read === 'string' ? Promise.resolve(configWith(read)) : read),
    watchConfig: (callback) => {
      push = (holdKey) => callback(configWith(holdKey));
      return unwatch;
    },
  });
  watch.start();
  await flush();
  return watch;
}

function move(x: number, y: number, init: PointerEventInit = {}, target: EventTarget = document) {
  target.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: x,
      clientY: y,
      ctrlKey: true,
      buttons: 0,
      bubbles: true,
      ...init,
    }),
  );
}

function key(type: 'keydown' | 'keyup', name: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, ...init }));
}

const ctrlDown = (init: KeyboardEventInit = {}) => key('keydown', 'Control', init);
const ctrlUp = () => key('keyup', 'Control');

beforeEach(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>Paragraph</p>';
  await setup();
  // The pointer is known and at rest (without Ctrl yet).
  move(100, 200, { ctrlKey: false });
});

afterEach(() => {
  watch?.stop();
  watch = undefined;
  vi.useRealTimers();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('hold watch', () => {
  it('fires once at the pointer after Ctrl is held still, and not again until released', () => {
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith({ x: 100, y: 200 });
    vi.advanceTimersByTime(HOLD_MS * 3);
    move(100, 230);
    vi.advanceTimersByTime(HOLD_MS * 3);
    expect(onHold).toHaveBeenCalledTimes(1);
    ctrlUp();
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(2);
    expect(onHold).toHaveBeenLastCalledWith({ x: 100, y: 230 });
  });

  it('ignores a quick Ctrl press and release (⌃Space switching the input method)', () => {
    ctrlDown();
    vi.advanceTimersByTime(80);
    ctrlUp();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it.each([
    ['C (Ctrl+C)', 'c'],
    ['Meta', 'Meta'],
    ['Shift', 'Shift'],
    ['Alt', 'Alt'],
  ])('voids the press when another key joins: %s', (_label, other) => {
    ctrlDown();
    vi.advanceTimersByTime(100);
    key('keydown', other, { ctrlKey: true });
    key('keyup', other, { ctrlKey: true });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('voids the press on Ctrl+wheel (zoom)', () => {
    ctrlDown();
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, ctrlKey: true, bubbles: true }));
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not start while a button is down (Ctrl during a drag)', () => {
    move(110, 200, { ctrlKey: false, buttons: 1 });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('starts again once the button was released', () => {
    document.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { buttons: 0, bubbles: true }));
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('voids the press on a pointerdown (Ctrl+click on a link)', () => {
    ctrlDown();
    vi.advanceTimersByTime(200);
    document.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, bubbles: true }));
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('voids the press when a move says Ctrl is up (the keyup was lost)', () => {
    ctrlDown();
    vi.advanceTimersByTime(100);
    move(101, 200, { ctrlKey: false });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not start the count on a repeated keydown (Ctrl held while coming back)', () => {
    ctrlDown({ repeat: true });
    ctrlDown({ repeat: true });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('needs a new pointer move after the window lost focus', () => {
    window.dispatchEvent(new Event('blur'));
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
    ctrlUp();
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('voids the press when the window loses focus or the tab is hidden', () => {
    ctrlDown();
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(HOLD_MS * 2);
    move(100, 200);
    ctrlDown();
    vi.advanceTimersByTime(100);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('voids the press when the pointer leaves the document', () => {
    ctrlDown();
    document.body.dispatchEvent(
      new PointerEvent('pointerout', { relatedTarget: null, bubbles: true }),
    );
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('ignores Ctrl during input method composition', () => {
    ctrlDown({ isComposing: true });
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    ctrlDown({ keyCode: 229 });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('ignores a composition key while Ctrl is held', () => {
    ctrlDown();
    key('keydown', 'Process', { keyCode: 229 });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it.each([
    ['an input without a type', '<input id="f">'],
    ['a text input', '<input id="f" type="text">'],
    ['a search input', '<input id="f" type="search">'],
    ['a password input', '<input id="f" type="password">'],
    ['a number input', '<input id="f" type="number">'],
    ['a textarea', '<textarea id="f"></textarea>'],
    ['an editable element', '<div id="f" contenteditable="true" tabindex="0">x</div>'],
  ])('does not fire while %s has focus', (_label, markup) => {
    document.body.innerHTML = markup;
    (document.getElementById('f') as HTMLElement).focus();
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not fire while the focus is in one of our own hosts (the palette input)', () => {
    // A closed shadow root: the document only sees the host as focused.
    const host = document.createElement('et-palette');
    const input = document.createElement('input');
    host.attachShadow({ mode: 'closed' }).append(input);
    document.body.replaceChildren(host);
    input.focus();
    expect(document.activeElement).toBe(host);
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('still fires while the focus is on a button in the selection card (not the palette)', () => {
    const host = document.createElement('et-selection');
    const button = document.createElement('button');
    host.attachShadow({ mode: 'closed' }).append(button);
    document.body.replaceChildren(host);
    button.focus();
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a checkbox', '<input id="f" type="checkbox">'],
    ['a radio button', '<input id="f" type="radio">'],
    ['a range slider', '<input id="f" type="range">'],
    ['a submit input', '<input id="f" type="submit">'],
    ['a button', '<button id="f">Go</button>'],
  ])('still fires while %s has focus (no typing there)', (_label, markup) => {
    document.body.innerHTML = markup;
    (document.getElementById('f') as HTMLElement).focus();
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
  ])('voids a Ctrl press that comes with %s already down', (_label, init) => {
    ctrlDown(init);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('ignores synthetic (untrusted) key and pointer events by default', async () => {
    watch?.stop();
    // The production default: happy-dom's events are all untrusted.
    await setup((event) => event.isTrusted);
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('a forged keydown starts nothing, a forged move changes nothing', async () => {
    watch?.stop();
    const forge = <T extends Event>(event: T) => Object.assign(event, { forged: true });
    await setup((event) => !('forged' in event));
    move(100, 200, { ctrlKey: false });
    document.dispatchEvent(forge(new KeyboardEvent('keydown', { key: 'Control' })));
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
    ctrlDown();
    // A page script "moving" the pointer away with Ctrl up neither cancels nor moves it.
    document.dispatchEvent(
      forge(new PointerEvent('pointermove', { clientX: 500, clientY: 500, ctrlKey: false })),
    );
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledWith({ x: 100, y: 200 });
  });

  it('checks the isle when the count ends: the pointer may rest on it by then', () => {
    document.body.innerHTML = '<p>Text</p><et-isle></et-isle>';
    ctrlDown();
    vi.advanceTimersByTime(200);
    // A small move (under 6 px) onto the isle: the count goes on, but must not fire there.
    move(102, 200, {}, document.querySelector('et-isle') as Element);
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not fire over the page isle or the selection card', () => {
    document.body.innerHTML = '<et-isle></et-isle><et-selection></et-selection>';
    for (const tag of ['et-isle', 'et-selection']) {
      move(50, 50, {}, document.querySelector(tag) as Element);
      ctrlDown();
      vi.advanceTimersByTime(HOLD_MS * 2);
      ctrlUp();
    }
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does not fire when the pointer has not moved since the page loaded', async () => {
    watch?.stop();
    await setup();
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('restarts the count when the pointer travels more than 6 px, not for a jitter', () => {
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS - 100);
    // 3 + 3 px: still at rest.
    move(103, 200);
    move(100, 200);
    vi.advanceTimersByTime(100);
    expect(onHold).toHaveBeenCalledTimes(1);
    ctrlUp();
    ctrlDown();
    vi.advanceTimersByTime(300);
    // 4 + 4 px adds up past 6: the count starts again from here.
    move(104, 200);
    move(108, 200);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onHold).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(2);
    expect(onHold).toHaveBeenLastCalledWith({ x: 108, y: 200 });
  });

  it('calls nothing after stop', () => {
    ctrlDown();
    watch?.stop();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    move(100, 210);
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("never prevents Ctrl's keyup, even after the press fired", () => {
    const release = () => {
      const up = new KeyboardEvent('keyup', { key: 'Control', bubbles: true, cancelable: true });
      document.dispatchEvent(up);
      return up.defaultPrevented;
    };
    ctrlDown();
    vi.advanceTimersByTime(80);
    expect(release()).toBe(false);
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(release()).toBe(false);
  });

  it('stop removes every listener even when unsubscribing throws (extension reloaded)', async () => {
    watch?.stop();
    // Spies call through; their calls say what was attached and detached, and where.
    const spies = [document, window].map((target) => ({
      target,
      add: vi.spyOn(target, 'addEventListener'),
      remove: vi.spyOn(target, 'removeEventListener'),
    }));
    const current = await setup();
    unwatch.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => current.stop()).not.toThrow();
    const calls = (kind: 'add' | 'remove') =>
      spies.flatMap((spy) => spy[kind].mock.calls.map((call) => [spy.target, ...call]));
    const added = calls('add');
    const removed = calls('remove');
    for (const spy of spies) {
      spy.add.mockRestore();
      spy.remove.mockRestore();
    }
    expect(unwatch).toHaveBeenCalledOnce();
    expect(added).toContainEqual([document, 'keyup', expect.any(Function), true]);
    expect(added).toContainEqual([window, 'blur', expect.any(Function), expect.anything()]);
    for (const type of ['keydown', 'pointermove', 'pointerdown', 'wheel', 'visibilitychange']) {
      expect(added).toContainEqual([document, type, expect.any(Function), expect.anything()]);
    }
    expect(removed).toEqual(added);
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe('hold watch with Alt', () => {
  // A real Alt keydown reports Alt itself as down.
  const altDown = (init: KeyboardEventInit = {}) =>
    key('keydown', 'Alt', { altKey: true, ...init });
  /** Cancelable, as a real keyup is: whether the watch prevented it. */
  const altUp = () => {
    const up = new KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true });
    document.dispatchEvent(up);
    return up.defaultPrevented;
  };

  beforeEach(async () => {
    watch?.stop();
    await setup(undefined, 'alt');
    move(100, 200, { ctrlKey: false });
  });

  it('fires once after Alt is held still, and keeps the menu from taking focus on release', () => {
    altDown();
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    move(101, 200, { ctrlKey: false, altKey: true });
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledWith({ x: 101, y: 200 });
    expect(altUp()).toBe(true);
  });

  it('leaves a quick Alt press alone: no hold, keyup not prevented', () => {
    altDown();
    vi.advanceTimersByTime(80);
    expect(altUp()).toBe(false);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('does nothing for a held Ctrl', () => {
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    expect(onHold).not.toHaveBeenCalled();
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Shift', { shiftKey: true }],
    ['Meta', { metaKey: true }],
  ])('voids an Alt press that comes with %s already down', (_label, init) => {
    altDown(init);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('voids the press when another key joins (Alt+Tab, Alt+D), and leaves its keyup alone', () => {
    altDown();
    key('keydown', 'd', { altKey: true });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
    expect(altUp()).toBe(false);
  });

  it('voids the press when a move says Alt is up (the keyup was lost)', () => {
    altDown();
    vi.advanceTimersByTime(100);
    move(101, 200, { ctrlKey: false, altKey: false });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe('hold watch following the setting', () => {
  it('listens to no key while the setting is off', async () => {
    watch?.stop();
    const add = vi.spyOn(document, 'addEventListener');
    const addToWindow = vi.spyOn(window, 'addEventListener');
    await setup(undefined, 'off');
    for (const type of ['keydown', 'keyup', 'pointermove']) {
      expect(add).not.toHaveBeenCalledWith(type, expect.anything(), expect.anything());
    }
    expect(addToWindow).not.toHaveBeenCalledWith('blur', expect.anything(), expect.anything());
    add.mockRestore();
    addToWindow.mockRestore();
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('listens to nothing until the stored setting is read', async () => {
    watch?.stop();
    let answer: (config: ConfigV1) => void = () => {};
    const add = vi.spyOn(document, 'addEventListener');
    await setup(undefined, new Promise<ConfigV1>((resolve) => (answer = resolve)));
    expect(add).not.toHaveBeenCalledWith('keydown', expect.anything(), expect.anything());
    answer(configWith('ctrl'));
    await flush();
    expect(add).toHaveBeenCalledWith('keydown', expect.anything(), expect.anything());
    add.mockRestore();
  });

  it('a change pushed while the read is out wins over the read', async () => {
    watch?.stop();
    let answer: (config: ConfigV1) => void = () => {};
    await setup(undefined, new Promise<ConfigV1>((resolve) => (answer = resolve)));
    push('off');
    answer(configWith('ctrl'));
    await flush();
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('follows ctrl → off → alt as the setting changes', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    push('off');
    expect(remove).toHaveBeenCalledWith('keydown', expect.anything(), expect.anything());
    remove.mockRestore();
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    expect(onHold).not.toHaveBeenCalled();

    push('alt');
    // Listening again: the pointer must move before anything fires.
    move(100, 200, { ctrlKey: false });
    ctrlDown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    ctrlUp();
    expect(onHold).not.toHaveBeenCalled();
    key('keydown', 'Alt', { altKey: true });
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('drops a press under way when the key changes', () => {
    ctrlDown();
    vi.advanceTimersByTime(100);
    push('alt');
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('stops following the setting once stopped', () => {
    watch?.stop();
    expect(unwatch).toHaveBeenCalledOnce();
    const add = vi.spyOn(document, 'addEventListener');
    push('alt');
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });
});
