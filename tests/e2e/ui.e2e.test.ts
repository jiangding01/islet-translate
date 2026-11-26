import { describe, expect, it } from 'vitest';
import { type Harness, launch, trackTests, type UiLocale, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// P0-7 (settings page) and P0-8 (action panel): rendered in the real extension, in the
// interface language the build was forced to.

let h: Harness | undefined;
trackTests(() => h, { closeAfterEach: true });

const COPY = {
  en: {
    brand: 'Islet Translate',
    title: 'Islet Translate · Settings',
    general: 'General',
    services: 'Translation services',
    panel: 'Settings',
    blocked: "This page can't be translated",
  },
  zh_TW: {
    brand: '譯嶼',
    title: '譯嶼 · 設定',
    general: '一般',
    services: '翻譯服務',
    panel: '設定',
    blocked: '這個頁面無法翻譯',
  },
} as const;

async function start(ui: UiLocale) {
  // Not the previous (closed) browser: a failed launch must not save its stale artifacts.
  h = undefined;
  h = await launch({ ui });
  await prepare(h);
  return h;
}

describe('settings page', () => {
  it.each(['en', 'zh_TW'] as const)(
    'switches pages and follows the interface language (%s)',
    async (ui) => {
      const copy = COPY[ui];
      const page = await (await start(ui)).extPage('options.html');
      const text = (selector: string) =>
        page.evaluate<string>(
          `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
        );

      // The page opens on the general tab; the brand and the tab title use the UI language.
      await waitFor(async () => (await text('h1')) === copy.general, {
        message: 'the general page',
      });
      expect(await page.evaluate<string>('document.title')).toBe(copy.title);
      expect(await text('nav img + span')).toBe(copy.brand);
      expect(await text('nav a[aria-current="page"]')).toBe(copy.general);

      await page.evaluate(`document.querySelector('nav a[href="#services"]').click()`);
      await waitFor(async () => (await text('h1')) === copy.services, {
        message: 'the services page',
      });
      expect(await text('nav a[aria-current="page"]')).toBe(copy.services);

      await page.evaluate(`document.querySelector('nav a[href="#general"]').click()`);
      await waitFor(async () => (await text('h1')) === copy.general, {
        message: 'the general page again',
      });
      h?.assertNoErrors();
    },
  );

  it('chooses a translation style, and adds and deletes a custom one', async () => {
    const page = await (await start('en')).extPage('options.html');
    const text = (selector: string) =>
      page.evaluate<string>(
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
      );
    const checkedStyle = () =>
      page.evaluate<string>(
        `document.querySelector('input[name="translation-style"]:checked')?.value ?? ''`,
      );
    const storedStyle = () =>
      page.evaluate<string>(
        `chrome.storage.local.get('config').then((r) => r.config?.data?.translation?.style ?? '')`,
      );
    const clickButton = (label: string) =>
      page.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}).click()`,
      );
    const mouse = (
      type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
      point: { x: number; y: number },
      buttons = 0,
    ) =>
      page.input('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : buttons,
        clickCount: 1,
      });
    /** Types into a React-controlled field (the native setter, then an input event). */
    const fill = (selector: string, value: string) =>
      page.evaluate(`(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set;
        setter.call(field, ${JSON.stringify(value)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);

    await waitFor(async () => (await text('h1')) === 'General', { message: 'the general page' });
    await page.evaluate(`document.querySelector('nav a[href="#styles"]').click()`);
    await waitFor(async () => (await text('h1')) === 'Translation styles', {
      message: 'the styles page',
    });
    expect(await checkedStyle()).toBe('general');
    // The section note is always there, whichever engine is the default.
    expect(await text('h2')).toBe('Styles');
    expect(await page.evaluate<string>('document.body.innerText')).toContain(
      'Applies to AI engines only; Google Translate is not affected',
    );

    // A preset survives a reload of the page.
    await page.evaluate(`document.querySelector('input[value="tech"]').click()`);
    await waitFor(async () => (await storedStyle()) === 'tech', { message: 'the stored style' });
    await page.evaluate('setTimeout(() => location.reload(), 0), true');
    await waitFor(
      async () => (await text('h1')) === 'Translation styles' && (await checkedStyle()) === 'tech',
      { message: 'the chosen style after a reload' },
    );

    // A custom style: add it, choose it, delete it, and the choice falls back to General.
    await clickButton('Add style');
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`), {
      message: 'the add style dialog',
    });
    await fill('dialog input', 'Short');
    await fill('dialog textarea', 'Use short sentences.');
    // Selecting text by dragging out of a field and releasing on the backdrop keeps the dialog
    // open; a press that starts and ends on the backdrop closes it.
    // Measured once the dialog has finished growing out of its button.
    await waitFor(
      () => page.evaluate<boolean>(`document.querySelector('dialog').getAnimations().length === 0`),
      { message: 'the dialog to settle' },
    );
    const field = await page.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('dialog input').getBoundingClientRect();
      return { x: r.x + 8, y: r.y + r.height / 2 };
    })()`);
    const backdrop = { x: 8, y: 8 };
    await mouse('mousePressed', field);
    await mouse('mouseMoved', backdrop, 1);
    await mouse('mouseReleased', backdrop);
    await new Promise((done) => setTimeout(done, 300));
    expect(await page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`)).toBe(true);
    await mouse('mousePressed', backdrop);
    await mouse('mouseReleased', backdrop);
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('dialog[open]')`), {
      message: 'the dialog to close on the backdrop',
    });
    await clickButton('Add style');
    // Reopened right away: the previous close's `close` event, which arrives late, must not
    // close the new one.
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`), {
      message: 'the add style dialog again',
    });
    await new Promise((done) => setTimeout(done, 300));
    expect(await page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`)).toBe(true);
    await fill('dialog input', 'Short');
    await fill('dialog textarea', 'Use short sentences.');
    await clickButton('Save');
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === ${JSON.stringify('Edit "Short"')})`,
        ),
      { message: 'the new custom style card' },
    );
    const id = await page.evaluate<string>(
      `[...document.querySelectorAll('input[name="translation-style"]')].at(-1).value`,
    );
    expect(id).toMatch(/^style-[a-z0-9]{8}$/);
    await page.evaluate(`document.querySelector('input[value="${id}"]').click()`);
    await waitFor(async () => (await storedStyle()) === id, { message: 'the custom style chosen' });
    expect(await checkedStyle()).toBe(id);

    await clickButton('Delete "Short"');
    await clickButton('Delete');
    await waitFor(async () => (await checkedStyle()) === 'general', {
      message: 'the general style after deleting the chosen one',
    });
    expect(await storedStyle()).toBe('general');
    expect(await page.evaluate<boolean>(`!!document.querySelector('input[value="${id}"]')`)).toBe(
      false,
    );
    h?.assertNoErrors();
  });

  it('keeps a dialog open on Esc while it saves, also after Save was clicked', async () => {
    const page = await (await start('en')).extPage('options.html#styles');
    const open = () => page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`);
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll('button')].some((b) => b.textContent === 'Add style')`,
        ),
      { message: 'the styles page' },
    );
    await page.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Add style').click()`,
    );
    await waitFor(open, { message: 'the add style dialog' });
    await waitFor(
      () => page.evaluate<boolean>(`document.querySelector('dialog').getAnimations().length === 0`),
      { message: 'the dialog to settle' },
    );
    await page.evaluate(`(() => {
      for (const [selector, value] of [['dialog input', 'Short'], ['dialog textarea', 'Brief.']]) {
        const field = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // The save never answers: the dialog stays busy.
      chrome.runtime.sendMessage = () => new Promise(() => {});
    })()`);
    // A real click: the focus goes to Save, which is then disabled while saving.
    const save = await page.evaluate<{ x: number; y: number }>(`(() => {
      const r = [...document.querySelectorAll('dialog button')]
        .find((b) => b.textContent === 'Save').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.input('Input.dispatchMouseEvent', {
        type,
        ...save,
        button: 'left',
        clickCount: 1,
      });
    }
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Save').disabled`,
        ),
      { message: 'the dialog to be saving' },
    );
    const ESC = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
    for (let i = 0; i < 2; i++) {
      await page.input('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ESC });
      await page.input('Input.dispatchKeyEvent', { type: 'keyUp', ...ESC });
      await new Promise((done) => setTimeout(done, 200));
      expect(await open(), `open after Esc #${i + 1}`).toBe(true);
      // The second time with the focus on the page itself, as when Save loses it.
      await page.evaluate(`document.activeElement?.blur()`);
    }
  });

  it('tests the Google connection and shows the mock translation', async () => {
    // `#services`: how the popup's "去设置" next to an engine problem opens it.
    const page = await (await start('en')).extPage('options.html#services');
    // The default engine's panel is open: its test button and the live result.
    await waitFor(
      () =>
        page.evaluate(
          `[...document.querySelectorAll('button')].some((b) => b.textContent === 'Test connection')`,
        ),
      { message: 'the test button' },
    );
    await page.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Test connection').click()`,
    );
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll('[role="status"]')].some((el) => el.textContent.includes('【MOCK】HELLO, WORLD.'))`,
        ),
      { message: 'the translated test sentence' },
    );
    expect(h?.google.count).toBeGreaterThan(0);
    h?.assertNoErrors();
  });
});

describe('action panel', () => {
  it.each(['en', 'zh_TW'] as const)(
    'opens, renders and follows the interface language (%s)',
    async (ui) => {
      const harness = await start(ui);
      const copy = COPY[ui];
      await harness.openPage('e2e-article.html');
      await harness.sw('chrome.action.openPopup()');
      const popup = await harness.waitForExtPage('popup.html');
      // The panel has no activeTab here (the popup is opened by the worker, not a click), so
      // it reports a page it cannot read; that state and its Settings button are stable.
      // Wait for that state itself: on the way the panel shows text too ("loading", then
      // "reading the page"), so "the root has content" can be read too early.
      const body = await waitFor(
        async () => {
          const text = await popup.evaluate<string>('document.body.innerText');
          if (!text.includes(copy.blocked)) throw new Error(`panel text ${JSON.stringify(text)}`);
          return text;
        },
        { message: 'the panel to report a page it cannot read' },
      );
      expect(body).toContain(copy.panel);
      harness.assertNoErrors();
    },
  );

  it('shows the page it was opened for and translates it from the button', async () => {
    const harness = await start('en');
    await harness.openPage('e2e-article.html');
    const { origin, host } = await harness.evaluate<{ origin: string; host: string }>(
      '({ origin: location.origin, host: location.host })',
    );
    // As a plain tab the panel has no "active tab" of its own: both extension API objects
    // answer tabs.query with the test page (wxt picks whichever one exists).
    const tab = { id: harness.tabId, url: `${origin}/e2e-article.html`, active: true, windowId: 1 };
    const preload = `for (const api of [globalThis.browser, globalThis.chrome]) {
      if (api?.tabs) api.tabs.query = async () => [${JSON.stringify(tab)}];
    }`;
    const popup = await harness.extPage('popup.html', { preload });
    try {
      const button = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Translate this page'))`;
      await waitFor(
        async () =>
          (await popup.evaluate<string>('document.body.innerText')).includes(host) &&
          (await popup.evaluate<boolean>(`!!(${button})`)),
        { message: 'the panel to show the test page and its translate button' },
      );
      await popup.evaluate(`(${button}).click()`);
      await waitFor(
        async () => (await harness.tell<Ok<PageState>>('page.getState')).data.translated >= 8,
        { message: 'the test page to be translated from the panel' },
      );
      expect(harness.google.count).toBeGreaterThan(0);
      harness.assertNoErrors();
    } finally {
      // The panel closes itself once translation starts.
      await popup.close();
    }
  });

  it('offers "Translate anyway" on a page that declares the target language', async () => {
    const harness = await start('en');
    await harness.openPage('e2e-native.html');
    const { origin, host } = await harness.evaluate<{ origin: string; host: string }>(
      '({ origin: location.origin, host: location.host })',
    );
    const tab = { id: harness.tabId, url: `${origin}/e2e-native.html`, active: true, windowId: 1 };
    const preload = `for (const api of [globalThis.browser, globalThis.chrome]) {
      if (api?.tabs) api.tabs.query = async () => [${JSON.stringify(tab)}];
    }`;
    const text = (popup: { evaluate<T>(expression: string): Promise<T> }) =>
      popup.evaluate<string>('document.body.innerText');
    const anyway = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Translate anyway'))`;
    const always = `[...document.querySelectorAll('[role="switch"]')].some((el) => el.textContent.includes('Always translate this site'))`;

    const first = await harness.extPage('popup.html', { preload });
    try {
      await waitFor(
        async () =>
          (await text(first)).includes('This page is already in') &&
          (await first.evaluate<boolean>(`!!(${anyway})`)),
        { message: 'the panel to show the native state and its Translate anyway button' },
      );
      const shown = await text(first);
      expect(shown).toContain(host);
      // The target picker is there, with the page's own language on its left.
      const pair = await first.evaluate<{ source: string; picker: string }>(
        `(() => {
          const arrow = document.querySelector('main svg');
          return {
            source: arrow?.previousElementSibling?.textContent ?? '',
            picker: arrow?.nextElementSibling?.textContent ?? '',
          };
        })()`,
      );
      expect(pair.source).toBe('简体中文');
      expect(pair.picker).toContain('Translate to');
      expect(shown).not.toContain('Auto-detect');
      expect(await first.evaluate<boolean>(always)).toBe(false);
      expect(shown).not.toContain('Always translate this site');

      await first.evaluate(`(${anyway}).click()`);
      await waitFor(
        () =>
          harness.evaluate<boolean>(
            `document.querySelector('#intro et-tr')?.textContent.includes('【MOCK】') ?? false`,
          ),
        { message: 'the English paragraph to be translated from the panel' },
      );
      harness.assertNoErrors();
    } finally {
      await first.close();
    }

    // With the session running, the site switch still stays away on a native-language page.
    const second = await harness.extPage('popup.html', { preload });
    try {
      await waitFor(async () => (await text(second)).includes(host), {
        message: 'the panel to show the test page again',
      });
      await waitFor(async () => (await text(second)).includes('Show original'), {
        message: 'the panel to show the running session',
      });
      expect(await second.evaluate<boolean>(always)).toBe(false);
      harness.assertNoErrors();
    } finally {
      await second.close();
    }
  });
});
