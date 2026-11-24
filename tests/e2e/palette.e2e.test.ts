import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, launch, mockTranslate, trackTests, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// M3c PR1, PR2, PR3 and PR6: the command palette. A real `chrome.commands` key cannot be pressed through CDP,
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
const ARROW_DOWN = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 };

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

  it('runs a picked match: “只看”, ↓ and Enter switch to translation only', async () => {
    await h.openPage('e2e-article.html');
    await h.tell('page.toggle');
    await waitFor(async () => (await state()).translated >= 8, {
      message: 'the first screen to be translated',
    });
    await openPalette();
    await h.input('Input.insertText', { text: '只看' });
    // Plain text: the translate row comes first, Enter would translate it (PR3).
    await waitFor(
      async () =>
        (await h.shadow<string>(HOST, `(root) => root.querySelector('#o1 .tt')?.textContent`)) ===
        '只看译文',
      { message: 'the translation-only command to be the first match' },
    );
    await press(ARROW_DOWN);
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
    // A leading slash only searches the commands.
    await h.input('Input.insertText', { text: '/设置' });
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

describe('quick translate (PR3)', () => {
  /** The result area's translation (or notice), '' while it is hidden. */
  const resultText = () =>
    h.shadow<string>(
      HOST,
      `(root) => { const r = root.querySelector('.qr'); return r && !r.hidden ? root.querySelector('.qt').textContent : ''; }`,
    );
  const rowTitle = (index: number) =>
    h.shadow<string>(HOST, `(root) => root.querySelector('#o${index} .tt')?.textContent ?? ''`);

  it('translates typed English on Enter; the result shows above the list, the palette stays', async () => {
    await h.openPage('e2e-article.html');
    // A slow service: the request is seen in flight first.
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    h.mockGoogle(async () => {
      await held;
      return undefined;
    });
    await openPalette();
    const source = 'The quiet harbour wakes before the fishing boats leave.';
    await h.input('Input.insertText', { text: source });
    await waitFor(async () => (await rowTitle(0)) === `翻译“${source}”`, {
      message: 'the translate row to come first',
    });
    try {
      await press(ENTER, '\r');
      // Held at the service: the one request is there, and the lead spins meanwhile.
      await waitFor(() => h.google.count === 1, { message: 'the request to reach the service' });
      await waitFor(
        () =>
          h.shadow<boolean>(HOST, `(root) => root.querySelector('.r').hasAttribute('data-run')`),
        { message: 'the lead to spin while the request runs' },
      );
    } finally {
      release();
    }
    await waitFor(async () => (await resultText()) === mockTranslate(source), {
      message: 'the translation to show',
    });
    expect(h.google.targets[h.google.texts.indexOf(source)]).toBe('zh-CN');
    expect(await h.shadow<string>(HOST, `(root) => root.querySelector('.dr')?.textContent`)).toBe(
      'English→简体中文',
    );
    expect(await isOpen()).toBe(true);
    expect(await h.shadow<string>(HOST, `(root) => root.activeElement?.className`)).toBe('in');
    // The copy row comes right after the translate row.
    expect(await rowTitle(1)).toBe('复制译文');
    h.assertNoErrors();
  });

  it('text in the target language goes into English (the request’s target is en)', async () => {
    await h.openPage('e2e-article.html');
    await openPalette();
    const source = '今天的天气非常好，我们一起去公园散步，然后在湖边喝一杯咖啡吧。';
    await h.input('Input.insertText', { text: source });
    await press(ENTER, '\r');
    await waitFor(() => h.google.texts.includes(source), { message: 'the request to be sent' });
    expect(h.google.targets[h.google.texts.indexOf(source)]).toBe('en');
    await waitFor(async () => (await resultText()) !== '', { message: 'the result to show' });
    expect(await h.shadow<string>(HOST, `(root) => root.querySelector('.dr')?.textContent`)).toBe(
      '简体中文→English',
    );
    h.assertNoErrors();
  });

  it('a leading slash only searches: Enter sends nothing', async () => {
    await h.openPage('e2e-article.html');
    await openPalette();
    await h.input('Input.insertText', { text: '/hello world' });
    await waitFor(() => h.shadow<boolean>(HOST, `(root) => !!root.querySelector('.em')`), {
      message: 'no command to match',
    });
    await press(ENTER, '\r');
    await new Promise((done) => setTimeout(done, 500));
    expect(h.google.count).toBe(0);
    expect(await resultText()).toBe('');
    expect(await isOpen()).toBe(true);
    h.assertNoErrors();
  });

  it('copies the translation with ↓ Enter and says so', async () => {
    await h.openPage('e2e-article.html');
    // The real clipboard cannot be read back here: in the content script's own (isolated)
    // world, where the palette runs, writeText is replaced by a recorder.
    await h.evalInContentWorld(`(() => {
      window.__copied = [];
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text) => { window.__copied.push(text); },
      });
    })()`);
    await openPalette();
    const source = 'Lanterns glow along the old stone bridge.';
    await h.input('Input.insertText', { text: source });
    await press(ENTER, '\r');
    await waitFor(async () => (await resultText()) === mockTranslate(source), {
      message: 'the translation to show',
    });
    await press(ARROW_DOWN);
    await press(ENTER, '\r');
    await waitFor(async () => (await rowTitle(1)) === '已复制', {
      message: 'the copy row to say it copied',
    });
    expect(await h.evalInContentWorld<string[]>('window.__copied')).toEqual([
      mockTranslate(source),
    ]);
    expect(await isOpen()).toBe(true);
    await waitFor(async () => (await rowTitle(1)) === '复制译文', {
      message: 'the copy row to return',
      timeout: 4000,
    });
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
