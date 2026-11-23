import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, launch, trackTests, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// M3c PR1: the command palette. A real `chrome.commands` key cannot be pressed through CDP,
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
});
