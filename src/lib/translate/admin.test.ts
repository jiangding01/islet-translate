import { describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { KeyValueStore } from '@/lib/config/repository';
import { appError, ok } from '@/lib/errors';
import {
  type AdminDeps,
  createAdminHandlers,
  isOptionsSender,
  TEST_DEADLINE_MS,
  TEST_SAMPLE,
} from './admin';
import { createScheduler } from './scheduler';
import { createSecretStore, SECRETS_STORAGE_KEY } from './secrets';
import type { ProviderAdapter, ProviderContext } from './types';

const OPTIONS_URL = 'chrome-extension://abc/options.html';
const options = { url: `${OPTIONS_URL}#/providers` };
const contentScript = { url: 'https://evil.example.com/page' };
const DRAFT_KEY = 'sk-draft-SECRET-9999';
const SAVED_KEY = 'sk-saved-SECRET-1234';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, structuredClone(value)),
  };
}

function setup(
  adapter: Partial<ProviderAdapter> & {
    translate?: ProviderAdapter['translate'];
  } = {},
  overrides: Partial<AdminDeps> = {},
) {
  const store = memoryStore();
  const secrets = createSecretStore(store);
  const contexts: ProviderContext[] = [];
  const fake: ProviderAdapter = {
    kind: 'mt',
    limits: { maxItems: 10, maxChars: 1000 },
    async *translate(batch, ctx) {
      contexts.push(ctx);
      for (const [index, text] of batch.entries()) yield { type: 'item', index, text: `T:${text}` };
    },
    ...adapter,
  };
  const cache = {
    stats: vi.fn(async () => ({ count: 3, totalBytes: 42 })),
    clear: vi.fn(async () => {}),
  };
  const config = createDefaultConfig('zh-CN');
  const getConfig = vi.fn(async () => config);
  const scheduler = createScheduler();
  const submit = vi.spyOn(scheduler, 'submit');
  const handlers = createAdminHandlers({
    getConfig,
    secrets,
    cache,
    scheduler,
    optionsUrl: OPTIONS_URL,
    getAdapter: () => fake,
    checkPermission: async () => ok(undefined),
    ...overrides,
  });
  return { handlers, store, secrets, cache, contexts, submit, getConfig };
}

const draft = (extra: Record<string, unknown> = {}) => ({
  engine: 'openai',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-x',
  ...extra,
});

describe('sender check', () => {
  it('accepts only the options page', () => {
    expect(isOptionsSender(options, OPTIONS_URL)).toBe(true);
    expect(isOptionsSender({ url: OPTIONS_URL }, OPTIONS_URL)).toBe(true);
    expect(isOptionsSender({ url: `${OPTIONS_URL}?x=1` }, OPTIONS_URL)).toBe(true);
    expect(isOptionsSender({ url: `${OPTIONS_URL}.evil.com` }, OPTIONS_URL)).toBe(false);
    expect(isOptionsSender(contentScript, OPTIONS_URL)).toBe(false);
    expect(isOptionsSender({}, OPTIONS_URL)).toBe(false);
    expect(isOptionsSender(undefined, OPTIONS_URL)).toBe(false);
  });

  it('rejects content-script senders on all five messages without side effects', async () => {
    const { handlers, store, cache, submit } = setup();
    const results = [
      await handlers['secrets.set'](contentScript, { provider: 'openai', key: DRAFT_KEY }),
      await handlers['secrets.status'](contentScript),
      await handlers['provider.test'](contentScript, draft()),
      await handlers['cache.stats'](contentScript),
      await handlers['cache.clear'](contentScript),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'validation/forbidden-sender' } });
    }
    expect(store.data.size).toBe(0);
    expect(cache.stats).not.toHaveBeenCalled();
    expect(cache.clear).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('secrets', () => {
  it('set and status expose only configured and last4', async () => {
    const { handlers } = setup();
    const set = await handlers['secrets.set'](options, { provider: 'openai', key: SAVED_KEY });
    expect(set).toEqual({ ok: true, data: { configured: true, last4: '1234' } });
    const status = await handlers['secrets.status'](options);
    expect(status).toEqual({
      ok: true,
      data: {
        openai: { configured: true, last4: '1234' },
        deepseek: { configured: false, last4: '' },
        gemini: { configured: false, last4: '' },
      },
    });
    expect(JSON.stringify(status)).not.toContain('SECRET');
  });

  it('deletes with null and rejects invalid input', async () => {
    const { handlers } = setup();
    await handlers['secrets.set'](options, { provider: 'openai', key: SAVED_KEY });
    expect(await handlers['secrets.set'](options, { provider: 'openai', key: null })).toEqual({
      ok: true,
      data: { configured: false, last4: '' },
    });
    expect(
      await handlers['secrets.set'](options, { provider: 'google' as never, key: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'validation/invalid-payload' } });
    const bad = await handlers['secrets.set'](options, {
      provider: 'openai',
      key: 'sk-\nabc-SECRET',
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation/invalid-secret' } });
    expect(JSON.stringify(bad)).not.toContain('SECRET');
  });

  it('rejects oversized test drafts before any request', async () => {
    const { handlers, submit } = setup();
    const long = await handlers['provider.test'](
      options,
      draft({ engine: 'openai', baseURL: `https://a.example.com/${'x'.repeat(2048)}` }),
    );
    expect(long).toMatchObject({ ok: false, error: { code: 'validation/invalid-payload' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('lets the popup read the status, but nothing else', async () => {
    const { handlers } = setup({}, { popupUrl: 'chrome-extension://abc/popup.html' });
    const popup = { url: 'chrome-extension://abc/popup.html' };
    expect(await handlers['secrets.status'](popup)).toMatchObject({ ok: true });
    expect(
      await handlers['secrets.set'](popup, { provider: 'openai', key: SAVED_KEY }),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation/forbidden-sender' },
    });
    expect(
      await handlers['secrets.status']({ url: 'https://evil.example/popup.html' }),
    ).toMatchObject({
      ok: false,
    });
  });

  it('accepts custom provider ids and rejects the bare word custom', async () => {
    const { handlers } = setup();
    expect(
      await handlers['secrets.set'](options, { provider: 'custom-aaaaaaaa', key: SAVED_KEY }),
    ).toMatchObject({ ok: true, data: { configured: true } });
    const status = await handlers['secrets.status'](options);
    expect(status).toMatchObject({ ok: true, data: { 'custom-aaaaaaaa': { configured: true } } });
    const bare = { provider: 'custom', key: SAVED_KEY } as unknown as Parameters<
      (typeof handlers)['secrets.set']
    >[1];
    expect(await handlers['secrets.set'](options, bare)).toMatchObject({
      ok: false,
      error: { code: 'validation/invalid-payload' },
    });
  });
});

describe('cache', () => {
  it('stats and clear delegate', async () => {
    const { handlers, cache } = setup();
    expect(await handlers['cache.stats'](options)).toEqual({
      ok: true,
      data: { count: 3, totalBytes: 42 },
    });
    expect(await handlers['cache.clear'](options)).toEqual({ ok: true, data: null });
    expect(cache.clear).toHaveBeenCalledOnce();
  });

  it('reports a failing cache instead of success', async () => {
    const { handlers, cache } = setup();
    const down = appError('internal', 'internal/cache-unavailable', 'Cache unavailable');
    cache.stats.mockRejectedValueOnce(down);
    cache.clear.mockRejectedValueOnce(down);
    expect(await handlers['cache.stats'](options)).toMatchObject({
      ok: false,
      error: { code: 'internal/cache-unavailable' },
    });
    expect(await handlers['cache.clear'](options)).toMatchObject({
      ok: false,
      error: { code: 'internal/cache-unavailable' },
    });
  });
});

describe('provider.test', () => {
  it('translates the sample with the draft key, without touching storage or config', async () => {
    const { handlers, store, contexts, submit } = setup();
    const result = await handlers['provider.test'](options, draft({ apiKey: DRAFT_KEY }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toBe(`T:${TEST_SAMPLE}`);
    expect(result.data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(contexts[0]?.apiKey).toBe(DRAFT_KEY);
    expect(contexts[0]?.settings).toEqual({ baseURL: 'https://api.openai.com/v1', model: 'gpt-x' });
    // Nothing persisted: no persist callback, unique key, nothing in storage.
    const request = submit.mock.calls[0]?.[0];
    expect(request?.persist).toBeUndefined();
    expect(request?.segments[0]?.key).toMatch(/^test:/);
    // A test holds a scheduler slot for at most this long.
    expect(request?.deadlineMs).toBe(TEST_DEADLINE_MS);
    expect(store.data.has(SECRETS_STORAGE_KEY)).toBe(false);
    expect(store.data.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain(DRAFT_KEY);
  });

  it('uses the saved key when the draft has none or a blank one', async () => {
    const { handlers, contexts } = setup();
    await handlers['secrets.set'](options, { provider: 'openai', key: SAVED_KEY });
    await handlers['provider.test'](options, draft());
    await handlers['provider.test'](options, draft({ apiKey: '   ' }));
    expect(contexts.map((ctx) => ctx.apiKey)).toEqual([SAVED_KEY, SAVED_KEY]);
  });

  it('uses a distinct caller and key per run', async () => {
    const { handlers, submit } = setup();
    await handlers['provider.test'](options, draft());
    await handlers['provider.test'](options, draft());
    const [a, b] = submit.mock.calls.map((call) => call[0]);
    expect(a?.caller).not.toBe(b?.caller);
    // Own cooldown scope: a rate-limited test never cools down real translations.
    expect(a?.cooldownKey).toMatch(/^test:/);
    expect(a?.cooldownKey).not.toBe(b?.cooldownKey);
    expect(a?.segments[0]?.key).not.toBe(b?.segments[0]?.key);
  });

  it('never leaks the draft key through errors', async () => {
    const leaking: Partial<ProviderAdapter> = {
      // biome-ignore lint/correctness/useYield: always fails
      async *translate() {
        throw appError('provider', 'provider/unauthorized', `bad key ${DRAFT_KEY}`);
      },
    };
    const { handlers } = setup(leaking);
    const result = await handlers['provider.test'](options, draft({ apiKey: DRAFT_KEY }));
    expect(result).toMatchObject({ ok: false, error: { code: 'provider/unauthorized' } });
    expect(JSON.stringify(result)).not.toContain(DRAFT_KEY);
  });

  it('never leaks the draft key through validation errors', async () => {
    const { handlers } = setup();
    const result = await handlers['provider.test'](options, draft({ apiKey: `${DRAFT_KEY}\n` }));
    // Trailing whitespace is trimmed; an inner control character is rejected.
    expect(result.ok).toBe(true);
    const bad = await handlers['provider.test'](options, draft({ apiKey: `sk-​${DRAFT_KEY}` }));
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation/invalid-secret' } });
    expect(JSON.stringify(bad)).not.toContain(DRAFT_KEY);
  });

  it('requires a model for non-google engines', async () => {
    const { handlers, submit } = setup();
    const result = await handlers['provider.test'](options, draft({ model: ' ' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'config/model-required' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('checks the permission of a custom endpoint before any request', async () => {
    const checkPermission = vi.fn(
      async () =>
        ({ ok: false, error: appError('config', 'config/permission-missing', 'no') }) as const,
    );
    const { handlers, submit } = setup({}, { checkPermission });
    const result = await handlers['provider.test'](
      options,
      draft({ engine: 'custom-aaaaaaaa', baseURL: 'https://llm.example.com/v1/chat/completions' }),
    );
    expect(checkPermission).toHaveBeenCalledWith('custom-aaaaaaaa', 'https://llm.example.com/v1');
    expect(result).toMatchObject({ ok: false, error: { code: 'config/permission-missing' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not ignore a missing permission for an openai endpoint', async () => {
    const checkPermission = vi.fn(
      async () =>
        ({ ok: false, error: appError('config', 'config/permission-missing', 'no') }) as const,
    );
    const { handlers, submit } = setup({}, { checkPermission });
    const result = await handlers['provider.test'](
      options,
      draft({ baseURL: 'https://proxy.example.com/v1' }),
    );
    expect(checkPermission).toHaveBeenCalledWith('openai', 'https://proxy.example.com/v1');
    expect(result).toMatchObject({ ok: false, error: { code: 'config/permission-missing' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('tests DeepSeek with thinking as the draft sets it, off when not given', async () => {
    const { handlers, contexts } = setup();
    const deepseek = { engine: 'deepseek', baseURL: '', model: 'deepseek-chat' };
    await handlers['provider.test'](options, draft({ ...deepseek, thinking: false }));
    await handlers['provider.test'](options, draft({ ...deepseek, thinking: true }));
    await handlers['provider.test'](options, draft(deepseek));
    expect(contexts.map((ctx) => ctx.settings.extraBody)).toEqual([
      { thinking: { type: 'disabled' } },
      undefined,
      { thinking: { type: 'disabled' } },
    ]);
  });

  it('rejects a malformed draft', async () => {
    const { handlers } = setup();
    for (const bad of [
      null,
      { engine: 'nope', baseURL: '', model: '' },
      draft({ model: 1 }),
      draft({ thinking: 'yes' }),
    ]) {
      expect(await handlers['provider.test'](options, bad)).toMatchObject({
        ok: false,
        error: { code: 'validation/invalid-payload' },
      });
    }
  });

  it('tests google without model, key or permission', async () => {
    const { handlers, contexts } = setup();
    const result = await handlers['provider.test'](
      options,
      draft({ engine: 'google', baseURL: '', model: '' }),
    );
    expect(result.ok).toBe(true);
    expect(contexts[0]?.apiKey).toBeUndefined();
  });
});
