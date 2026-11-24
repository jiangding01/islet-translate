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

describe('region picker (PR4)', () => {
  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const PICK = 'et-pick';

  /** Whether the picker is running: its hint bar shows. */
  const isPicking = () =>
    h.shadow<boolean>(PICK, `(root) => !root.querySelector('.hn').hidden`).catch(() => false);
  const rectOf = (selector: string) =>
    h.evaluate<Box>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
  const boxRect = () =>
    h.shadow<Box | null>(
      PICK,
      `(root) => {
        const b = root.querySelector('.bx');
        if (b.hidden) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }`,
    );
  /** Waits until the box sits 4px outside `selector` (it glides there within 120ms). */
  async function boxAround(selector: string) {
    await waitFor(
      async () => {
        const [box, el] = [await boxRect(), await rectOf(selector)];
        const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
        return (
          !!box &&
          near(box.x, el.x - 4) &&
          near(box.y, el.y - 4) &&
          near(box.w, el.w + 8) &&
          near(box.h, el.h + 8)
        );
      },
      { message: `the box around ${selector}` },
    );
  }
  /** A real pointer move to the middle of `selector`. */
  async function hover(selector: string) {
    const r = await rectOf(selector);
    await h.input('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(r.x + Math.min(r.w / 2, 40)),
      y: Math.round(r.y + r.h / 2),
    });
  }
  /** From the palette: “/区域”, Enter, until the picker shows. */
  async function startPicking() {
    await openPalette();
    await h.input('Input.insertText', { text: '/区域' });
    await waitFor(
      async () =>
        (await h.shadow<string>(HOST, `(root) => root.querySelector('#o0 .tt')?.textContent`)) ===
        '选择要翻译的区域',
      { message: 'the region command to be the first match' },
    );
    await press(ENTER, '\r');
    await waitFor(isPicking, { message: 'the picker to start' });
    await waitFor(async () => !(await isOpen()), { message: 'the palette to close' });
  }
  const ARROW_UP = { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };

  it('from the keyboard: ↑ grows the box, Enter translates only that area', async () => {
    await h.openPage('e2e-article.html');
    await startPicking();
    expect(await h.evaluate<string>(`document.activeElement?.localName`)).toBe(PICK);
    await hover('#intro');
    await boxAround('#intro');
    await press(ARROW_UP);
    await boxAround('#article');
    await press(ENTER, '\r');
    await waitFor(async () => !(await isPicking()), { message: 'the picker to end' });
    await waitFor(async () => (await state()).phase === 'done', {
      message: 'the area to be translated',
    });
    expect(await state()).toMatchObject({ scope: 'units' });
    const counts = await h.evaluate<{ inside: number; all: number }>(`({
      inside: document.querySelectorAll('#article et-tr:not([data-et-state])').length,
      all: document.querySelectorAll('et-tr').length,
    })`);
    expect(counts.inside).toBeGreaterThanOrEqual(8);
    expect(counts.all).toBe(counts.inside);
    expect(h.google.texts.some((text) => /serendipity|Further down the coast/.test(text))).toBe(
      false,
    );
    h.assertNoErrors();
  });

  it('a click while picking follows no link: it picks the block under it', async () => {
    await h.openPage('e2e-article.html');
    const href = await h.evaluate<string>('location.href');
    await startPicking();
    await hover('#link');
    await boxAround('#linked');
    await h.trustedClick('#link');
    await waitFor(async () => !(await isPicking()), { message: 'the click to confirm' });
    await waitFor(
      () => h.evaluate<boolean>(`!!document.querySelector('#linked > et-tr:not([data-et-state])')`),
      { message: 'the linked paragraph to be translated' },
    );
    expect(await h.evaluate<string>('location.href')).toBe(href);
    expect(await h.evaluate<number>(`document.querySelectorAll('et-tr').length`)).toBe(1);
    h.assertNoErrors();
  });

  it('a click on another block, with no move before it, confirms the block clicked', async () => {
    await h.openPage('e2e-article.html');
    // The pointer rests on #word before the pick: no move reaches the picker, so its box
    // starts from the keyboard's point (the viewport's centre), somewhere else.
    const word = await rectOf('#word');
    const at = { x: Math.round(word.x + 40), y: Math.round(word.y + word.h / 2) };
    await h.input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    await startPicking();
    await new Promise((done) => setTimeout(done, 300));
    const box = await boxRect();
    expect(!!box && Math.abs(box.y - (word.y - 4)) <= 1.5).toBe(false);
    // Pressed and released where it rests: a click, with no move in between.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await h.input('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
    }
    await waitFor(async () => !(await isPicking()), { message: 'the click to confirm' });
    await waitFor(
      () => h.evaluate<boolean>(`!!document.querySelector('#word > et-tr:not([data-et-state])')`),
      { message: 'the clicked paragraph to be translated' },
    );
    expect(await h.evaluate<number>(`document.querySelectorAll('et-tr').length`)).toBe(1);
    h.assertNoErrors();
  });

  it('with the focus in the page’s field: no key scrolls the page or reaches it', async () => {
    await h.openPage('e2e-article.html');
    await focusField();
    await h.evaluate(`document.querySelector('#field').setSelectionRange(5, 5)`);
    await startPicking();
    // The page is long enough to scroll: Space, Page Down and ↓ would all move it.
    expect(
      await h.evaluate<number>('document.documentElement.scrollHeight - innerHeight'),
    ).toBeGreaterThan(800);
    const scrolled = () => h.evaluate<number>('scrollY');
    const before = await scrolled();
    await press({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }, ' ');
    await press({ key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
    await press({ key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await press(ARROW_UP);
    await press({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await new Promise((done) => setTimeout(done, 300));
    expect(await scrolled()).toBe(before);
    await press(ESCAPE);
    await waitFor(async () => !(await isPicking()), { message: 'Escape to end the pick' });
    expect(await h.evaluate<string>(`document.activeElement?.id`)).toBe('field');
    expect(await h.evaluate<number>(`document.querySelector('#field').selectionStart`)).toBe(5);
    expect(await h.evaluate<string[]>('window.__keys')).toEqual([]);
    expect((await state()).phase).toBe('idle');
    h.assertNoErrors();
  });

  it('an area over the limit: the box turns coral and Enter does nothing', async () => {
    await h.openPage('e2e-article.html');
    // Five paragraphs of about 4 500 characters: each one fits, together they are too many.
    await h.evaluate(`(() => {
      const big = document.createElement('div');
      big.id = 'big';
      for (let i = 0; i < 5; i += 1) {
        const p = document.createElement('p');
        p.id = 'big-' + i;
        p.textContent = 'The tide comes in slowly over the sand. '.repeat(112);
        big.append(p);
      }
      document.body.prepend(big);
    })()`);
    await startPicking();
    await hover('#big-0');
    await boxAround('#big-0');
    const over = () =>
      h.shadow<boolean>(PICK, `(root) => root.querySelector('.bx').hasAttribute('data-over')`);
    expect(await over()).toBe(false);
    await press(ARROW_UP);
    await boxAround('#big');
    expect(await over()).toBe(true);
    expect(await h.shadow<string>(PICK, `(root) => root.querySelector('.hn').textContent`)).toBe(
      '区域太大，可直接翻译此页·↓缩小·Esc取消',
    );
    await press(ENTER, '\r');
    await new Promise((done) => setTimeout(done, 500));
    expect(await isPicking()).toBe(true);
    expect(h.google.count).toBe(0);
    expect((await state()).phase).toBe('idle');
    await press(ESCAPE);
    await waitFor(async () => !(await isPicking()), { message: 'Escape to end the pick' });
    h.assertNoErrors();
  });
});
