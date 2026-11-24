import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, launch, trackTests, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// M3c PR1, PR2 and PR6: the command palette. A real `chrome.commands` key cannot be pressed through CDP,
// so `palette.toggle` is sent the way the background sends it for the shortcut. Keys and
// text are real CDP input. Chinese UI: the commands are matched by their zh_CN titles.

let h: Harness;
trackTests(() => h);

beforeAll(async () => {
  h = await launch({ ui: 'zh_CN' });
});

beforeEach(() => prepare(h, { clearCache: true }));

afterAll(() => h?.close());

const HOST = 'et-palette';
const state = async () => (await h.tell<Ok<PageState>>('page.getState')).data;

const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
const ESCAPE = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };

async function press(key: Record<string, unknown>, text?: string) {
  await h.input('Input.dispatchKeyEvent', { type: 'keyDown', ...key, ...(text ? { text } : {}) });
  await h.input('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** Whether the palette is open: its host is there and marked open. */
const isOpen = () => h.evaluate<boolean>(`!!document.querySelector('${HOST}[data-open]')`);

/** Opens the palette and waits until its commands are listed. */
async function openPalette() {
  await h.tell('palette.toggle');
  await waitFor(isOpen, { message: 'the palette to open' });
  await waitFor(() => h.shadow<number>(HOST, `(root) => root.querySelectorAll('.o').length`), {
    message: 'the commands to be listed',
  });
}

/** Focuses the page's text field and records page keys seen in the bubble phase. */
async function focusField() {
  await h.evaluate(`(() => {
    window.__keys = [];
    for (const type of ['keydown', 'keypress', 'keyup', 'input']) {
      document.addEventListener(type, (event) => window.__keys.push(type + ':' + (event.key ?? '')));
    }
    document.querySelector('#field').focus();
  })()`);
}

describe('command palette', () => {
  it('opens with the focus in its input, and typed keys never reach the page', async () => {
    await h.openPage('e2e-article.html');
    await focusField();
    await openPalette();
    expect(await h.evaluate<string>(`document.activeElement?.localName`)).toBe(HOST);
    expect(await h.shadow<string>(HOST, `(root) => root.activeElement?.className`)).toBe('in');

    await press({ key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 }, 's');
    expect(await h.shadow<string>(HOST, `(root) => root.querySelector('.in').value`)).toBe('s');
    expect(await h.evaluate<string[]>('window.__keys')).toEqual([]);
    h.assertNoErrors();
  });

  it('runs the highlighted match on Enter: “只看” switches to translation only', async () => {
    await h.openPage('e2e-article.html');
    await h.tell('page.toggle');
    await waitFor(async () => (await state()).translated >= 8, {
      message: 'the first screen to be translated',
    });
    await openPalette();
    await h.input('Input.insertText', { text: '只看' });
    await waitFor(
      async () =>
        (await h.shadow<string>(HOST, `(root) => root.querySelector('.o .tt')?.textContent`)) ===
        '只看译文',
      { message: 'the translation-only command to be the first match' },
    );
    await press(ENTER, '\r');
    await waitFor(async () => (await state()).mode === 'translation', {
      message: 'the page to show translations only',
    });
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close' });
    h.assertNoErrors();
  });

  it('closes on Escape and hands the focus back to the page’s field', async () => {
    await h.openPage('e2e-article.html');
    await focusField();
    await openPalette();
    await press(ESCAPE);
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close' });
    expect(await h.evaluate<string>(`document.activeElement?.id`)).toBe('field');
    // Not even the Escape's keyup reaches the page.
    expect(await h.evaluate<string[]>('window.__keys')).toEqual([]);
    h.assertNoErrors();
  });

  it('runs a command on Enter without the Enter reaching the page’s field', async () => {
    await h.openPage('e2e-article.html');
    await focusField();
    await openPalette();
    await press(ENTER, '\r');
    await waitFor(async () => (await state()).phase !== 'idle', {
      message: 'the page translation to start',
    });
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close' });
    expect(await h.evaluate<string>(`document.activeElement?.id`)).toBe('field');
    expect(await h.evaluate<string[]>('window.__keys')).toEqual([]);
    h.assertNoErrors();
  });

  it('closes an open selection card first', async () => {
    await h.openPage('e2e-article.html');
    // As from the context menu in a frame: the card opens on the text alone.
    await h.tell('selection.open', { selectionText: 'the quiet harbour', frameId: 1 });
    const cardView = () =>
      h.shadow<string>('et-selection', `(root) => root.querySelector('.r')?.dataset.view`);
    await waitFor(async () => (await cardView()) === 'card', { message: 'the card to open' });
    await openPalette();
    await waitFor(async () => (await cardView()) !== 'card', { message: 'the card to close' });
    h.assertNoErrors();
  });
  it('shows the translate-page key the browser reports on the “翻译此页” row', async () => {
    await h.openPage('e2e-article.html');
    // Whatever the platform and the browser made of the suggested key: never a literal here.
    const expected = await h.sw<string>(
      `chrome.commands.getAll().then((all) => all.find((c) => c.name === 'translate-page')?.shortcut ?? '')`,
    );
    await openPalette();
    const row = () =>
      h.shadow<{ title: string; kb: string } | null>(
        HOST,
        `(root) => {
          const o = [...root.querySelectorAll('.o')].find((el) => el.querySelector('.tt')?.textContent === '翻译此页');
          return o ? { title: '翻译此页', kb: o.querySelector('.kb')?.textContent ?? '' } : null;
        }`,
      );
    // The key arrives a moment after the list: wait for it when there is one to show.
    if (expected) {
      await waitFor(async () => (await row())?.kb === expected, {
        message: `the row to show ${expected}`,
      });
    } else {
      await waitFor(row, { message: 'the row' });
      expect((await row())?.kb).toBe('');
    }
    // The row's slot is visible exactly when there is a key.
    const shown = await h.shadow<boolean>(
      HOST,
      `(root) => {
        const o = [...root.querySelectorAll('.o')].find((el) => el.querySelector('.tt')?.textContent === '翻译此页');
        return !!o && getComputedStyle(o.querySelector('.kb')).display !== 'none';
      }`,
    );
    expect(shown).toBe(expected !== '');
    h.assertNoErrors();
  });

  it('opens the settings page on “打开设置”', async () => {
    await h.openPage('e2e-article.html');
    await openPalette();
    await h.input('Input.insertText', { text: '设置' });
    await waitFor(
      async () =>
        (await h.shadow<string>(HOST, `(root) => root.querySelector('.o .tt')?.textContent`)) ===
        '打开设置',
      { message: 'the settings command to be the first match' },
    );
    // Not a leftover from an earlier step: the page below must be the one this Enter opens.
    expect(
      await h.sw<number>(
        `chrome.tabs.query({ url: chrome.runtime.getURL('options.html') }).then((tabs) => tabs.length)`,
      ),
    ).toBe(0);
    await press(ENTER, '\r');
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close' });
    const options = await h.waitForExtPage('options.html');
    await options.close();
    h.assertNoErrors();
  });
});

describe('the isle’s ⌘ (PR6)', () => {
  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** A trusted click on `selector` inside the isle's shadow root, once it has stopped moving. */
  async function clickInIsle(selector: string) {
    const where = () =>
      h.shadow<{ x: number; y: number } | null>(
        'et-isle',
        `(root) => {
          const r = root.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
          return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }`,
      );
    const point = await waitFor(
      async () => {
        const before = await where();
        await new Promise((done) => setTimeout(done, 200));
        const after = await where();
        return before && after && before.x === after.x && before.y === after.y ? after : null;
      },
      { message: `${selector} in the isle to hold still` },
    );
    await h.trustedClick(point);
  }

  const isleView = () =>
    h.shadow<string>('et-isle', `(root) => root.querySelector('.r')?.dataset.view`);
  /** The isle's toolbar as drawn on screen (its shell is clipped to the same box). */
  const isleRect = () =>
    h.shadow<Box | null>(
      'et-isle',
      `(root) => {
        const r = root.querySelector('.bar')?.getBoundingClientRect();
        return r && r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }`,
    );
  /** The palette's content box once its shape has stopped moving. */
  const paletteRect = () =>
    waitFor(
      async () => {
        const read = () =>
          h.shadow<(Box & { anim: boolean }) | null>(
            HOST,
            `(root) => {
              const r = root.querySelector('.cn')?.getBoundingClientRect();
              const anim = root.querySelector('.r')?.hasAttribute('data-anim') ?? true;
              return r && r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height, anim } : null;
            }`,
          );
        const box = await read();
        return box && !box.anim ? box : null;
      },
      { message: 'the palette to come to rest' },
    );

  it('opens beside the isle from a real click; the isle stays open; ⌘ again closes it', async () => {
    await h.openPage('e2e-article.html');
    await h.tell('page.toggle');
    await waitFor(async () => (await state()).phase === 'done', { message: 'the page to settle' });
    await clickInIsle('.hit');
    await waitFor(async () => (await isleView()) === 'isle', { message: 'the isle to open' });

    await clickInIsle('[data-act="palette"]');
    await waitFor(isOpen, { message: 'the palette to open from the ⌘' });
    expect(await h.evaluate<string>(`document.activeElement?.localName`)).toBe(HOST);
    expect(await h.shadow<string>(HOST, `(root) => root.activeElement?.className`)).toBe('in');
    // Right dock (the default): 8px to the left of the isle, the tops aligned.
    const isle = await waitFor(isleRect, { message: 'the isle’s toolbar' });
    const panel = await paletteRect();
    expect(Math.abs(panel.x + panel.w - (isle.x - 8))).toBeLessThanOrEqual(3);
    expect(Math.abs(panel.y - isle.y)).toBeLessThanOrEqual(3);

    // A click in the palette (the pointer far outside the isle) leaves the isle open.
    await h.trustedClick({ x: panel.x + 40, y: panel.y + 23 });
    await new Promise((done) => setTimeout(done, 700));
    expect(await isleView()).toBe('isle');
    expect(await isOpen()).toBe(true);

    // The ⌘ again: the palette closes (a press on the isle is not a press elsewhere).
    await clickInIsle('[data-act="palette"]');
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close from the ⌘' });
    h.assertNoErrors();
  });
});
