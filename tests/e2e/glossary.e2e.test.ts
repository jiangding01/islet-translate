import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, launch, mockTranslate, trackTests, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// M4-C glossary end to end: Google keeps the marked terms (or loses them and the page falls back
// to a translation without terms), the AI request carries the terms of its own paragraphs only,
// and the settings page adds and deletes an entry. Every case starts from an empty cache and an
// empty glossary.

const KEY = 'sk-e2e-test';
const KEEPER = {
  source: 'lighthouse keeper',
  target: '灯塔看守人',
  lang: 'zh-CN',
  caseSensitive: false,
};
const VISITORS = { source: 'Visitors', target: '', lang: '', caseSensitive: true };
const SPAN = /<span translate="no" id="g\d+">|<\/span>/g;

let h: Harness;
trackTests(() => h);

beforeAll(async () => {
  h = await launch({ ui: 'en' });
});

beforeEach(async () => {
  await prepare(h, { clearCache: true });
  const options = await h.extPage('options.html');
  try {
    await options.evaluate(`chrome.storage.local.remove('glossary')`);
    expect(
      await options.send('config.patch', [{ path: 'translation.engine', value: 'google' }]),
    ).toMatchObject({ ok: true });
  } finally {
    await options.close();
  }
});

afterAll(() => h?.close());

/** Adds entries through the background, as the settings page does. */
async function addTerms(...entries: (typeof KEEPER)[]) {
  const options = await h.extPage('options.html');
  try {
    for (const entry of entries) {
      expect(await options.send('glossary.change', { type: 'add', entry })).toMatchObject({
        ok: true,
      });
    }
  } finally {
    await options.close();
  }
}

const state = async () => (await h.tell<Ok<PageState>>('page.getState')).data;

/** The translation text under `selector` (excluding failure placeholders), if any. */
const translation = (selector: string) =>
  h.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(`${selector} > et-tr:not([data-et-state])`)})?.textContent ?? null`,
  );

async function translateArticle() {
  await h.openPage('e2e-article.html');
  await h.tell('page.toggle');
  await waitFor(async () => (await state()).translated >= 8, {
    message: 'the first screen to be translated',
  });
  await waitFor(async () => (await state()).phase === 'done', { message: 'the page to settle' });
}

describe('Google', () => {
  it('keeps the terms as set when Google keeps the spans', async () => {
    await addTerms(KEEPER, VISITORS);
    const html: string[] = [];
    h.mockGoogle((text, request) => {
      if (request.html) html.push(text);
      return undefined;
    });
    await translateArticle();

    expect(
      html.some((text) => text.includes('<span translate="no" id="g0">lighthouse keeper</span>')),
    ).toBe(true);
    expect(html.some((text) => text.includes('<span translate="no" id="g0">Visitors</span>'))).toBe(
      true,
    );
    // The mock upper-cases what it translates: the terms come from the glossary, not from it.
    expect(await translation('#linked')).toContain('THE OLD 灯塔看守人 STILL');
    expect(await translation('#coded')).toMatch(/^【MOCK】Visitors WHO RENT/);
    // The link inside the same paragraph survives.
    expect(
      await h.evaluate(
        `!!document.querySelector('#linked et-tr a[href="https://example.com/harbour-weather"]')`,
      ),
    ).toBe(true);
    h.assertNoErrors();
  });

  it('falls back to a translation without terms when Google drops the spans', async () => {
    await addTerms(KEEPER);
    const html: string[] = [];
    const plain: string[] = [];
    h.mockGoogle((text, request) => {
      (request.html ? html : plain).push(text);
      return request.html ? mockTranslate(text).replace(SPAN, '') : undefined;
    });
    await translateArticle();

    expect(html.some((text) => text.includes('lighthouse keeper</span>'))).toBe(true);
    // A second request, in plain mode, for the paragraph whose marks were lost.
    expect(
      plain.some((text) => text.includes('old lighthouse keeper') && !text.includes('<span')),
    ).toBe(true);
    const linked = await translation('#linked');
    expect(linked).toContain('【MOCK】');
    expect(linked).toContain('LIGHTHOUSE KEEPER');
    expect(linked).not.toContain('灯塔看守人');
    expect((await state()).failed).toBe(0);
    h.assertNoErrors();
  });
});

describe('AI', () => {
  it('sends the terms only with the paragraphs that hold them', async () => {
    await addTerms(KEEPER, VISITORS, { ...VISITORS, source: 'Nowhere in the page' });
    const options = await h.extPage('options.html');
    try {
      expect(await options.send('secrets.set', { provider: 'openai', key: KEY })).toMatchObject({
        ok: true,
      });
      expect(
        await options.send('config.patch', [
          { path: 'translation.engine', value: 'openai' },
          { path: 'translation.style', value: 'general' },
        ]),
      ).toMatchObject({ ok: true });
    } finally {
      await options.close();
    }
    h.mockLlm();
    await translateArticle();

    const requests = h.llm.requests;
    const withTerms = requests.filter((request) => request.glossary !== undefined);
    const without = requests.filter((request) => request.glossary === undefined);
    expect(withTerms.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const request of withTerms) {
      expect(request.texts.every((text) => /lighthouse keeper|Visitors/.test(text))).toBe(true);
      expect(request.glossary).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: expect.any(String) })]),
      );
      expect(
        request.glossary?.every((pair) => ['lighthouse keeper', 'Visitors'].includes(pair.source)),
      ).toBe(true);
    }
    expect(withTerms.flatMap((request) => request.glossary ?? [])).toEqual(
      expect.arrayContaining([
        { source: 'Visitors', target: '' },
        { source: 'lighthouse keeper', target: '灯塔看守人' },
      ]),
    );
    for (const request of without) {
      expect(request.user.startsWith('Translate this JSON array:\n')).toBe(true);
      expect(request.texts.some((text) => /lighthouse keeper|Visitors/.test(text))).toBe(false);
    }
    expect(h.google.count).toBe(0);
    h.assertNoErrors();
  });
});

describe('settings page', () => {
  /** Sets a React-controlled input's value as typing would. */
  const typeInto = (selector: string, value: string) => `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;
  const clickButton = (text: string) =>
    `[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(text)}).click()`;
  // The glossary rows only: the import dialog (always mounted) has list items of its own.
  const rows = (page: Awaited<ReturnType<Harness['extPage']>>) =>
    page.evaluate<string[]>(
      `[...document.querySelectorAll('li')].filter((li) => !li.closest('dialog')).map((li) => li.textContent)`,
    );

  it('adds an entry that is still there after a reload, and deletes it', async () => {
    let page = await h.extPage('options.html#glossary');
    await waitFor(() => page.evaluate(`document.body.innerText.includes('No terms yet.')`), {
      message: 'the empty glossary',
    });
    await page.evaluate(clickButton('Add term'));
    await waitFor(() => page.evaluate(`!!document.querySelector('dialog[open]')`), {
      message: 'the add term dialog',
    });
    await page.evaluate(typeInto('dialog input', 'Sonnet'));
    await page.evaluate(`document.querySelector('dialog input[type="checkbox"]').click()`);
    await page.evaluate(clickButton('Save'));
    await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`), {
      message: 'the dialog to close',
    });
    await waitFor(async () => (await rows(page)).some((row) => row.includes('Sonnet')), {
      message: 'the new row',
    });
    await page.close();

    page = await h.extPage('options.html#glossary');
    const [row] = await waitFor(
      async () => {
        const list = await rows(page);
        return list.length > 0 && list;
      },
      { message: 'the row after a reload' },
    );
    expect(row).toContain('Sonnet');
    expect(row).toContain('Keep as is');
    expect(row).toContain('Aa');

    // The background refuses a duplicate on save: the dialog stays open and says so under the
    // source field.
    await page.evaluate(clickButton('Add term'));
    await waitFor(() => page.evaluate(`!!document.querySelector('dialog[open]')`), {
      message: 'the add term dialog again',
    });
    await page.evaluate(typeInto('dialog input', 'sonnet'));
    await page.evaluate(clickButton('Save'));
    const duplicate = await waitFor(
      () =>
        page.evaluate<string>(`(() => {
          const id = document.querySelector('dialog input').getAttribute('aria-describedby');
          return id ? document.getElementById(id).textContent : '';
        })()`),
      { message: 'the duplicate refusal' },
    );
    expect(duplicate).toBe('A term with the same source already exists.');
    expect(await page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`)).toBe(true);
    await page.evaluate(clickButton('Cancel'));
    await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`), {
      message: 'the dialog to close after cancelling',
    });

    await page.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Delete "Sonnet"').click()`,
    );
    await page.evaluate(clickButton('Delete'));
    await waitFor(() => page.evaluate(`document.body.innerText.includes('No terms yet.')`), {
      message: 'the row to go',
    });
    const stored = await page.evaluate<{ entries: unknown[] }>(
      `chrome.storage.local.get('glossary').then((value) => value.glossary)`,
    );
    expect(stored.entries).toEqual([]);
    await page.close();
    h.assertNoErrors();
  });

  it('imports a CSV after a preview, filters, and exports CSV and JSON with the four fields only', async () => {
    await addTerms(KEEPER, VISITORS);
    const page = await h.extPage('options.html#glossary');
    await waitFor(async () => (await rows(page)).length === 2, { message: 'the two terms' });

    // Import: a file put into the dialog's file input, as a pick would.
    await page.evaluate(clickButton('Import'));
    await waitFor(
      () => page.evaluate(`!!document.querySelector('dialog[open] input[type="file"]')`),
      {
        message: 'the import dialog',
      },
    );
    const csv = [
      'source,target,lang,caseSensitive',
      'lighthouse keeper,灯塔守护者,zh-CN,',
      'Visitors,,,yes',
      'harbour,港口,zh-CN,',
      ',orphan,zh-CN,',
    ].join('\r\n');
    await page.evaluate(`(() => {
      const input = document.querySelector('dialog[open] input[type="file"]');
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(csv)}], 'terms.csv', { type: 'text/csv' }));
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const counts = await waitFor(
      async () => {
        const text = await page.evaluate<string>(
          `[...document.querySelectorAll('dialog[open] span')].filter((s) => s.querySelector(':scope > b')).map((s) => s.textContent).join('|')`,
        );
        return text || undefined;
      },
      { message: 'the preview counts' },
    );
    expect(counts).toBe('1New|1Overwrite|1Unchanged|1Invalid');
    expect(
      await page.evaluate<string>(`document.querySelector('dialog[open]').textContent`),
    ).toContain('Line 5: The source is empty');
    await page.evaluate(clickButton('Import 2 terms'));
    await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`), {
      message: 'the dialog to close after the import',
    });
    await waitFor(async () => (await rows(page)).length === 3, { message: 'the imported row' });
    const list = await rows(page);
    expect(list[0]).toContain('灯塔守护者');
    expect(list[2]).toContain('harbour');
    const stored = await page.evaluate<{ entries: { id: string; source: string }[] }>(
      `chrome.storage.local.get('glossary').then((value) => value.glossary)`,
    );
    expect(stored.entries.map((entry) => entry.source)).toEqual([
      'lighthouse keeper',
      'Visitors',
      'harbour',
    ]);

    // Filter.
    await page.evaluate(typeInto('input[type="search"]', 'HARB'));
    expect(await rows(page)).toEqual([expect.stringContaining('harbour')]);
    await page.evaluate(typeInto('input[type="search"]', ''));

    // Export: the download is caught in the page (and downloads are denied browser-wide).
    await page.evaluate(`(() => {
      window.__exports = [];
      URL.createObjectURL = (blob) => {
        window.__exports.push({ blob });
        return 'blob:e2e';
      };
      HTMLAnchorElement.prototype.click = function () {
        window.__exports.at(-1).name = this.download;
      };
    })()`);
    const exportAs = async (label: string) => {
      await page.evaluate(clickButton('Export'));
      await waitFor(() => page.evaluate(`!!document.querySelector('[role="menu"]')`), {
        message: 'the export menu',
      });
      await page.evaluate(
        `[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`,
      );
    };
    await exportAs('Export as CSV');
    await exportAs('Export as JSON');
    // `text()` decodes as UTF-8 and drops the BOM: the first bytes are read as they are.
    const files = await page.evaluate<{ name: string; text: string; head: number[] }[]>(
      `Promise.all(window.__exports.map(async (item) => ({
        name: item.name,
        text: await item.blob.text(),
        head: [...new Uint8Array(await item.blob.slice(0, 3).arrayBuffer())],
      })))`,
    );
    expect(files.map((file) => file.name)).toEqual([
      expect.stringMatching(/^islet-glossary-\d{4}-\d{2}-\d{2}\.csv$/),
      expect.stringMatching(/^islet-glossary-\d{4}-\d{2}-\d{2}\.json$/),
    ]);
    const [csvFile, jsonFile] = files;
    expect(csvFile?.head).toEqual([0xef, 0xbb, 0xbf]);
    expect(csvFile?.text.split('\r\n').slice(0, 2)).toEqual([
      '"source","target","lang","caseSensitive"',
      '"lighthouse keeper","灯塔守护者","zh-CN","false"',
    ]);
    expect(csvFile?.text).not.toContain('term-');
    const json = JSON.parse(jsonFile?.text ?? '{}');
    expect(json).toMatchObject({ format: 'islet-translate.glossary', version: 1 });
    for (const entry of json.entries) {
      expect(Object.keys(entry)).toEqual(['source', 'target', 'lang', 'caseSensitive']);
    }
    expect(json.entries.map((entry: { source: string }) => entry.source)).toEqual([
      'lighthouse keeper',
      'Visitors',
      'harbour',
    ]);
    await page.close();
    h.assertNoErrors();
  });
});
