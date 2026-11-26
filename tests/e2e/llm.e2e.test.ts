import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, type LlmRequest, launch, trackTests, waitFor } from './harness';
import { type Ok, type PageState, prepare } from './support';

// M4-A (thinking switch, extra request fields) and M4-B (translation styles) end to end, with
// OpenAI as the default engine and its chat endpoint mocked (h.mockLlm). Every test sets the
// settings it depends on first, so a retry or another order sees the same requests.

const KEY = 'sk-e2e-test';
const CUSTOM_STYLE = 'style-e2etest1';
/** A custom style description with quotes and a prompt placeholder in it. */
const CUSTOM_TEXT = 'Talk like a "salty" sailor <<NONCE>>';
/** The description as one JSON string, with `<` and `>` escaped (styles.ts, quoteStyle). */
// Spelled with escaped backslashes: the expected text holds `\"` and `<` literally.
const CUSTOM_QUOTED = '"Talk like a \\"salty\\" sailor \\u003c\\u003cNONCE\\u003e\\u003e"';

let h: Harness;
trackTests(() => h);

beforeAll(async () => {
  h = await launch({ ui: 'en' });
  await prepare(h, { clearCache: true });
  // A fake key: requests to the mocked endpoint need one, and nothing leaves the browser.
  const options = await h.extPage('options.html');
  expect(await options.send('secrets.set', { provider: 'openai', key: KEY })).toMatchObject({
    ok: true,
  });
  expect(
    await options.send('config.patch', [{ path: 'translation.engine', value: 'openai' }]),
  ).toMatchObject({ ok: true });
  await options.close();
});

afterAll(() => h?.close());

/**
 * From the settings page: the OpenAI and style settings back to their defaults, then
 * `changes` on top; the cache emptied, so the next page load asks the model again.
 */
async function configure(changes: unknown[] = []) {
  const options = await h.extPage('options.html');
  try {
    expect(
      await options.send('config.patch', [
        { path: 'translation.engine', value: 'openai' },
        { path: 'providers.openai.thinking', value: false },
        { path: 'providers.openai.extraBody', value: '' },
        { path: 'translation.style', value: 'general' },
        ...changes,
      ]),
    ).toMatchObject({ ok: true });
    expect(await options.send('cache.clear')).toMatchObject({ ok: true });
  } finally {
    await options.close();
  }
}

/** Settings changes without touching the cache. */
async function patch(changes: unknown[]) {
  const options = await h.extPage('options.html');
  try {
    expect(await options.send('config.patch', changes)).toMatchObject({ ok: true });
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

/** Loads the article, translates it and waits until the first screen is done. */
async function translatePage() {
  await h.openPage('e2e-article.html');
  await h.tell('page.toggle');
  await waitFor(async () => (await state()).translated >= 8, {
    message: 'the first screen to be translated',
  });
  await waitFor(async () => (await state()).phase === 'done', { message: 'the page to settle' });
  expect((await state()).engineError).toBeUndefined();
}

/** Page requests: every one must be a batch with a body the mock could read. */
function pageRequests(): LlmRequest[] {
  const requests = h.llm.requests;
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.format).toBe('batch');
    expect(request.texts.length).toBeGreaterThan(0);
  }
  return requests;
}

/** The fields the extension always sets itself (openai-compat.ts). */
function expectOwnFields(request: LlmRequest) {
  expect(request.body.model).toBe('gpt-5-mini');
  expect(request.body.stream).toBe(true);
  expect(request.body.messages).toEqual([
    { role: 'system', content: request.system },
    { role: 'user', content: request.user },
  ]);
  expect(request.system).toMatch(/^You are a professional translation engine\./);
}

/** The second line of the system message: where a style line goes (prompt.ts, systemText). */
const styleLine = (request: LlmRequest) => request.system.split('\n')[1] ?? '';

describe('M4-A thinking and extra fields', () => {
  it('sends gpt-5-mini with the lowest reasoning effort by default and shows the reply', async () => {
    await configure();
    await translatePage();

    for (const request of pageRequests()) {
      expectOwnFields(request);
      expect(request.body.reasoning_effort).toBe('minimal');
    }
    expect(await translation('#title')).toBe('【MOCK】NOTES FROM A QUIET HARBOUR TOWN');
    // The link survives the batch protocol's inline tags.
    expect(
      await h.evaluate(
        `!!document.querySelector('#linked et-tr a[href="https://example.com/harbour-weather"]')`,
      ),
    ).toBe(true);
    expect(h.google.count).toBe(0);
    h.assertNoErrors();
  });

  it('sends no reasoning effort once thinking is switched on', async () => {
    await configure([{ path: 'providers.openai.thinking', value: true }]);
    await translatePage();

    for (const request of pageRequests()) {
      expectOwnFields(request);
      expect(request.body).not.toHaveProperty('reasoning_effort');
    }
    expect(await translation('#title')).toContain('【MOCK】');
    h.assertNoErrors();
  });

  it('adds the extra request fields without replacing its own', async () => {
    await configure([{ path: 'providers.openai.extraBody', value: '{"temperature":0.2}' }]);
    await translatePage();
    for (const request of pageRequests()) {
      expectOwnFields(request);
      expect(request.body.temperature).toBe(0.2);
      expect(request.body.reasoning_effort).toBe('minimal');
    }

    // Extra fields that try to replace the request's own: they go first and lose.
    const hostile = { temperature: 0.2, model: 'other-model', stream: false, messages: [] };
    await configure([{ path: 'providers.openai.extraBody', value: JSON.stringify(hostile) }]);
    h.resetLogs();
    await translatePage();
    for (const request of pageRequests()) {
      expectOwnFields(request);
      expect(request.body.temperature).toBe(0.2);
    }
    expect(await translation('#title')).toContain('【MOCK】');
    h.assertNoErrors();
  });
});

describe('M4-B styles', () => {
  it('adds the preset style line, and the general style is served from its own cache', async () => {
    await configure();
    await translatePage();
    for (const request of pageRequests()) {
      expectOwnFields(request);
      expect(request.system).not.toMatch(/^Style:/m);
    }
    const general = await translation('#title');
    expect(general).toContain('【MOCK】');

    // Another style is another prompt: the same page is asked for again.
    await patch([{ path: 'translation.style', value: 'tech' }]);
    h.resetLogs();
    await translatePage();
    for (const request of pageRequests()) {
      expect(styleLine(request).startsWith('Style: technical documentation.')).toBe(true);
    }

    // Back to general: its translations are still cached, so nothing is sent.
    await patch([{ path: 'translation.style', value: 'general' }]);
    h.resetLogs();
    await translatePage();
    expect(h.llm.count).toBe(0);
    expect(await translation('#title')).toBe(general);
    h.assertNoErrors();
  });

  it('quotes a custom style as a JSON string in page and selection prompts', async () => {
    await configure([
      // Removed first, so a retry can add it again.
      { path: 'customStyles', key: CUSTOM_STYLE, remove: true },
      {
        path: 'customStyles',
        key: CUSTOM_STYLE,
        add: { name: 'Sailor', description: CUSTOM_TEXT },
      },
      { path: 'translation.style', value: CUSTOM_STYLE },
    ]);
    await translatePage();

    for (const request of pageRequests()) {
      const line = styleLine(request);
      expect(line.startsWith('The user asked for this translation style')).toBe(true);
      expect(line.slice(-CUSTOM_QUOTED.length - 2)).toBe(`: ${CUSTOM_QUOTED}`);
      expect(line).not.toMatch(/[<>]/);
      expect(request.system).not.toContain(CUSTOM_TEXT);
    }

    // The selection card streams a text prompt, whose <<NONCE>> placeholders are filled in:
    // the escaped description must come through untouched.
    h.resetLogs();
    await h.openPage('e2e-article.html');
    const phrase = 'the fishing boats leave before sunrise';
    await openCard('#intro', phrase);
    await waitFor(async () => (await cardText()).includes('【MOCK】'), {
      message: 'the card to show the mock translation',
    });
    expect(await cardText()).toContain(phrase.toUpperCase());
    const [text, ...others] = h.llm.requests;
    expect(others).toEqual([]);
    if (!text) throw new Error('no selection request');
    expect(text.format).toBe('text');
    expect(text.texts).toEqual([phrase]);
    expectOwnFields(text);
    const line = styleLine(text);
    expect(line.slice(-CUSTOM_QUOTED.length - 2)).toBe(`: ${CUSTOM_QUOTED}`);
    expect(line).not.toMatch(/[<>]/);
    // The nonce of this request marks the input, and nowhere in the style line.
    const nonce = /^-----BEGIN (\w+)-----/.exec(text.user)?.[1] ?? '';
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(text.system).toContain(`-----BEGIN ${nonce}-----`);
    expect(line).not.toContain(nonce);
    h.assertNoErrors();
  });
});

// The selection card (as in selection.e2e.test.ts): its dot and card live in a closed shadow
// root, read through h.shadow; the dot is clicked with a trusted click.

const HOST = 'et-selection';

async function view(): Promise<string> {
  const present = await h.evaluate<boolean>(`!!document.querySelector('${HOST}')`);
  if (!present) return 'none';
  return h.shadow<string>(HOST, `(root) => root.querySelector('.r')?.dataset.view ?? 'none'`);
}

async function openCard(selector: string, phrase: string) {
  await h.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(phrase)});
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${phrase.length});
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    }
    throw new Error('no text ' + ${JSON.stringify(phrase)});
  })()`);
  await waitFor(async () => (await view()) === 'dot', { message: 'the selection dot' });
  const centre = await h.shadow<{ x: number; y: number }>(
    HOST,
    `(root) => {
      const r = root.querySelector('.zn').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }`,
  );
  await h.trustedClick(centre);
  await waitFor(async () => (await view()) === 'card', { message: 'the card to open' });
}

const cardText = () =>
  h.shadow<string>(HOST, `(root) => root.querySelector('.bi')?.textContent ?? ''`);
