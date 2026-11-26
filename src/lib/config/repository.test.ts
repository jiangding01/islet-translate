import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createLocalStore } from './local-store';
import { createConfigRepository, type KeyValueStore } from './repository';
import { EXTRA_DEFAULTS } from './test-fixtures';
import {
  type ConfigChange,
  type CustomProviderId,
  type CustomStyleId,
  MAX_CUSTOM_PROVIDERS,
  MAX_CUSTOM_STYLES,
} from './types';

const uiLanguage = 'en-US';

function memoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore & { data: Map<string, unknown>; failNextSet: boolean } = {
    data,
    failNextSet: false,
    async get(key) {
      await Promise.resolve();
      return structuredClone(data.get(key));
    },
    async set(key, value) {
      await Promise.resolve();
      if (store.failNextSet) {
        store.failNextSet = false;
        throw new Error('quota exceeded');
      }
      data.set(key, structuredClone(value));
    },
  };
  return store;
}

const valid = (data: Record<string, unknown>) => ({ config: { schemaVersion: 1, data } });
const full = (ui: unknown, language: unknown, extra: Record<string, unknown> = {}) =>
  valid({ ui, language, ...EXTRA_DEFAULTS, ...extra });

describe('ConfigRepository', () => {
  it('writes defaults on first load', async () => {
    const store = memoryStore();
    const snapshot = await createConfigRepository({ store, uiLanguage }).load();
    expect(snapshot).toEqual({
      schemaVersion: 1,
      data: {
        ui: { theme: 'system' },
        language: { target: 'en', source: 'auto' },
        ...EXTRA_DEFAULTS,
      },
    });
    expect(store.data.get('config')).toEqual(snapshot);
  });

  it('does not write when stored data is already valid', async () => {
    const store = memoryStore(full({ theme: 'dark' }, { target: 'ja', source: 'auto' }));
    const set = vi.spyOn(store, 'set');
    await createConfigRepository({ store, uiLanguage }).load();
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps both of two concurrent patches to different fields', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    await Promise.all([
      repo.patch([{ path: 'ui.theme', value: 'dark' }]),
      repo.patch([{ path: 'language.target', value: 'ko' }]),
    ]);
    expect(store.data.get('config')).toMatchObject({
      data: { ui: { theme: 'dark' }, language: { target: 'ko' } },
    });
  });

  it('does not lose a patch that races with the load write-back', async () => {
    const store = memoryStore({ config: 'corrupted' });
    const repo = createConfigRepository({ store, uiLanguage });
    const [, patched] = await Promise.all([
      repo.load(),
      repo.patch([{ path: 'ui.theme', value: 'light' }]),
    ]);
    expect(patched.data.ui.theme).toBe('light');
    expect(store.data.get('config')).toMatchObject({ data: { ui: { theme: 'light' } } });
  });

  it('patches stored data that is missing fields or has an unrelated broken field', async () => {
    const store = memoryStore(valid({ ui: { theme: 'neon' }, future: { keep: true } }));
    const repo = createConfigRepository({ store, uiLanguage });
    const snapshot = await repo.patch([{ path: 'language.target', value: 'zh-TW' }]);
    expect(snapshot.data).toEqual({
      ui: { theme: 'system' },
      language: { target: 'zh-TW', source: 'auto' },
      ...EXTRA_DEFAULTS,
      future: { keep: true },
    });
  });

  it('rejects an invalid value and leaves the store unchanged', async () => {
    const initial = valid({ ui: { theme: 'dark' }, language: { target: 'ja' } });
    const store = memoryStore(initial);
    const repo = createConfigRepository({ store, uiLanguage });
    const change = { path: 'ui.theme', value: 'neon' } as unknown as ConfigChange;
    await expect(repo.patch([change])).rejects.toMatchObject({ code: 'config/invalid-value' });
    expect(store.data.get('config')).toEqual(initial.config);
  });

  it('patches the engine, source language and provider fields, and rejects an unknown engine', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    const snapshot = await repo.patch([
      { path: 'translation.engine', value: 'gemini' },
      { path: 'language.source', value: 'ja' },
      { path: 'providers.gemini.model', value: 'some-model' },
    ]);
    expect(snapshot.data.translation.engine).toBe('gemini');
    expect(snapshot.data.language.source).toBe('ja');
    expect(snapshot.data.providers.gemini.model).toBe('some-model');

    const bad = { path: 'translation.engine', value: 'bing' } as unknown as ConfigChange;
    await expect(repo.patch([bad])).rejects.toMatchObject({ code: 'config/invalid-value' });
  });

  it('rejects a path outside the whitelist', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    const change = { path: 'ui', value: {} } as unknown as ConfigChange;
    await expect(repo.patch([change])).rejects.toMatchObject({ code: 'config/unknown-path' });
    expect(store.data.has('config')).toBe(false);
  });

  it('reports a failed write, keeps the store, and keeps serving later patches', async () => {
    const initial = valid({ ui: { theme: 'dark' }, language: { target: 'ja' } });
    const store = memoryStore(initial);
    const repo = createConfigRepository({ store, uiLanguage });
    store.failNextSet = true;
    await expect(repo.patch([{ path: 'ui.theme', value: 'light' }])).rejects.toMatchObject({
      code: 'config/write-failed',
      retryable: true,
    });
    expect(store.data.get('config')).toEqual(initial.config);
    await repo.patch([{ path: 'ui.theme', value: 'light' }]);
    expect(store.data.get('config')).toMatchObject({ data: { ui: { theme: 'light' } } });
  });

  it('resets a single path and all paths, keeping unknown keys', async () => {
    const store = memoryStore(valid({ ui: { theme: 'dark' }, language: { target: 'ja' }, x: 1 }));
    const repo = createConfigRepository({ store, uiLanguage });
    expect((await repo.reset(['ui.theme'])).data).toMatchObject({
      ui: { theme: 'system' },
      language: { target: 'ja' },
      x: 1,
    });
    expect((await repo.reset()).data).toMatchObject({
      ui: { theme: 'system' },
      language: { target: 'en', source: 'auto' },
      x: 1,
    });
  });

  it('reads the last write from a fresh instance (simulated SW restart)', async () => {
    const store = createLocalStore();
    await createConfigRepository({ store, uiLanguage }).patch([
      { path: 'language.target', value: 'ko' },
    ]);
    const restarted = createConfigRepository({ store, uiLanguage });
    expect((await restarted.load()).data.language.target).toBe('ko');
    expect(await fakeBrowser.storage.local.get('config')).toMatchObject({
      config: { schemaVersion: 1, data: { language: { target: 'ko' } } },
    });
  });

  it('loadStored withholds the read-only snapshot of a newer build', async () => {
    const newer = memoryStore({
      config: { schemaVersion: 2, data: { customProviders: { 'custom-aaaaaaaa': {} } } },
    });
    expect(await createConfigRepository({ store: newer, uiLanguage }).loadStored()).toBeUndefined();
    const fine = createConfigRepository({ store: memoryStore(), uiLanguage });
    expect((await fine.loadStored())?.data.translation.engine).toBe('google');
  });

  it('refuses patch and reset in read-only mode and never writes on load', async () => {
    const newer = { config: { schemaVersion: 2, data: { brandNew: true } } };
    const store = memoryStore(newer);
    const set = vi.spyOn(store, 'set');
    const repo = createConfigRepository({ store, uiLanguage });
    expect((await repo.load()).data.ui.theme).toBe('system');
    await expect(repo.patch([{ path: 'ui.theme', value: 'dark' }])).rejects.toMatchObject({
      code: 'config/newer-version',
    });
    await expect(repo.reset()).rejects.toMatchObject({ code: 'config/newer-version' });
    expect(set).not.toHaveBeenCalled();
    expect(store.data.get('config')).toEqual(newer.config);
  });
});

describe('ConfigRepository: custom providers', () => {
  const entry = (name: string) => ({ name, baseURL: `https://${name}.example.com/v1`, model: 'm' });
  const add = (key: CustomProviderId, name: string): ConfigChange => ({
    path: 'customProviders',
    key,
    add: entry(name),
  });
  const update = (key: CustomProviderId, fields: Record<string, string>): ConfigChange => ({
    path: 'customProviders',
    key,
    update: fields,
  });
  const remove = (key: CustomProviderId): ConfigChange => ({
    path: 'customProviders',
    key,
    remove: true,
  });
  const setup = () => createConfigRepository({ store: memoryStore(), uiLanguage });

  it('adds, updates in place and removes single entries', async () => {
    const repo = setup();
    await repo.patch([add('custom-aaaaaaaa', 'a')]);
    await repo.patch([add('custom-bbbbbbbb', 'b')]);
    const updated = await repo.patch([update('custom-aaaaaaaa', { name: 'a2' })]);
    expect(Object.keys(updated.data.customProviders)).toEqual([
      'custom-aaaaaaaa',
      'custom-bbbbbbbb',
    ]);
    expect(updated.data.customProviders['custom-aaaaaaaa']).toEqual({ ...entry('a'), name: 'a2' });
    const removed = await repo.patch([remove('custom-aaaaaaaa')]);
    expect(Object.keys(removed.data.customProviders)).toEqual(['custom-bbbbbbbb']);
  });

  it('keeps both fields when one provider is edited twice in quick succession', async () => {
    const repo = setup();
    await repo.patch([add('custom-aaaaaaaa', 'a')]);
    await Promise.all([
      repo.patch([update('custom-aaaaaaaa', { model: 'new-model' })]),
      repo.patch([update('custom-aaaaaaaa', { name: 'renamed' })]),
    ]);
    const { data } = await repo.load();
    expect(data.customProviders['custom-aaaaaaaa']).toMatchObject({
      name: 'renamed',
      model: 'new-model',
    });
  });

  it('never brings back a provider that was removed', async () => {
    const repo = setup();
    await repo.patch([add('custom-aaaaaaaa', 'a')]);
    await repo.patch([remove('custom-aaaaaaaa')]);
    await expect(repo.patch([update('custom-aaaaaaaa', { name: 'late' })])).rejects.toMatchObject({
      code: 'config/provider-missing',
    });
    expect((await repo.load()).data.customProviders).toEqual({});
  });

  it('keeps concurrent edits of different entries', async () => {
    const repo = setup();
    await Promise.all([
      repo.patch([add('custom-aaaaaaaa', 'a')]),
      repo.patch([add('custom-bbbbbbbb', 'b')]),
    ]);
    const { data } = await repo.load();
    expect(Object.keys(data.customProviders).sort()).toEqual([
      'custom-aaaaaaaa',
      'custom-bbbbbbbb',
    ]);
  });

  it('can make a new entry the default in the same patch', async () => {
    const snapshot = await setup().patch([
      add('custom-aaaaaaaa', 'a'),
      { path: 'translation.engine', value: 'custom-aaaaaaaa' },
    ]);
    expect(snapshot.data.translation.engine).toBe('custom-aaaaaaaa');
  });

  it('falls back to Google when the default provider is removed', async () => {
    const repo = setup();
    await repo.patch([
      add('custom-aaaaaaaa', 'a'),
      { path: 'translation.engine', value: 'custom-aaaaaaaa' },
    ]);
    expect((await repo.patch([remove('custom-aaaaaaaa')])).data.translation.engine).toBe('google');
  });

  it('refuses to make a missing provider the default instead of silently choosing Google', async () => {
    const repo = setup();
    await expect(
      repo.patch([{ path: 'translation.engine', value: 'custom-zzzzzzzz' }]),
    ).rejects.toMatchObject({ code: 'config/provider-missing' });
    expect((await repo.load()).data.translation.engine).toBe('google');
  });

  it('falls back to Google when the custom providers are reset', async () => {
    const repo = setup();
    await repo.patch([
      add('custom-aaaaaaaa', 'a'),
      { path: 'translation.engine', value: 'custom-aaaaaaaa' },
    ]);
    const snapshot = await repo.reset(['customProviders']);
    expect(snapshot.data.customProviders).toEqual({});
    expect(snapshot.data.translation.engine).toBe('google');
  });

  it(`stops adding at ${MAX_CUSTOM_PROVIDERS} entries but still allows updates`, async () => {
    const repo = setup();
    const ids = Array.from(
      { length: MAX_CUSTOM_PROVIDERS },
      (_, index) => `custom-${String(index).padStart(8, '0')}` as CustomProviderId,
    );
    await repo.patch(ids.map((id) => add(id, id)));
    await expect(repo.patch([add('custom-zzzzzzzz', 'z')])).rejects.toMatchObject({
      code: 'config/provider-limit',
    });
    await expect(
      repo.patch([update(ids[0] as CustomProviderId, { name: 'again' })]),
    ).resolves.toBeDefined();
  });

  it('rejects malformed ids, a taken id, invalid values and replacing the whole record', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    const badId = {
      path: 'customProviders',
      key: 'custom',
      add: entry('a'),
    } as unknown as ConfigChange;
    await expect(repo.patch([badId])).rejects.toMatchObject({ code: 'config/invalid-value' });
    const badValue = add('custom-aaaaaaaa', 'x'.repeat(41));
    await expect(repo.patch([badValue])).rejects.toMatchObject({ code: 'config/invalid-value' });
    const whole = { path: 'customProviders', value: {} } as unknown as ConfigChange;
    await expect(repo.patch([whole])).rejects.toMatchObject({ code: 'config/unknown-path' });
    expect(store.data.has('config')).toBe(false);
    await repo.patch([add('custom-aaaaaaaa', 'a')]);
    await expect(repo.patch([add('custom-aaaaaaaa', 'b')])).rejects.toMatchObject({
      code: 'config/invalid-value',
    });
  });

  it('caps the OpenAI base URL and model like custom providers', async () => {
    const repo = setup();
    await expect(
      repo.patch([{ path: 'providers.openai.model', value: 'm'.repeat(201) }]),
    ).rejects.toMatchObject({ code: 'config/invalid-value' });
  });

  it('keeps the extra request body of a provider on add and update, as typed', async () => {
    const repo = setup();
    const text = '{\n  "think": false\n}';
    await repo.patch([
      {
        path: 'customProviders',
        key: 'custom-aaaaaaaa',
        add: { ...entry('a'), extraBody: text },
      },
    ]);
    expect((await repo.load()).data.customProviders['custom-aaaaaaaa']?.extraBody).toBe(text);
    await repo.patch([update('custom-aaaaaaaa', { extraBody: '{"a": 1}' })]);
    await repo.patch([update('custom-aaaaaaaa', { model: 'm2' })]);
    expect((await repo.load()).data.customProviders['custom-aaaaaaaa']).toEqual({
      ...entry('a'),
      model: 'm2',
      extraBody: '{"a": 1}',
    });
    await repo.patch([update('custom-aaaaaaaa', { extraBody: '' })]);
    expect((await repo.load()).data.customProviders['custom-aaaaaaaa']?.extraBody).toBe('');
  });

  it('refuses an extra request body that is not a JSON object, and stores nothing', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    await repo.patch([add('custom-aaaaaaaa', 'a')]);
    const before = structuredClone(store.data.get('config'));
    for (const extraBody of ['[1]', '{oops', 'null', '"x"', '{"__proto__": {"x": 1}}']) {
      await expect(repo.patch([update('custom-aaaaaaaa', { extraBody })])).rejects.toMatchObject({
        code: 'config/invalid-extra-body',
      });
      await expect(
        repo.patch([
          { path: 'customProviders', key: 'custom-bbbbbbbb', add: { ...entry('b'), extraBody } },
        ]),
      ).rejects.toMatchObject({ code: 'config/invalid-extra-body' });
      await expect(
        repo.patch([{ path: 'providers.openai.extraBody', value: extraBody }]),
      ).rejects.toMatchObject({ code: 'config/invalid-extra-body' });
    }
    expect(store.data.get('config')).toEqual(before);
    await expect(
      repo.patch([update('custom-aaaaaaaa', { extraBody: `{"a":"${'x'.repeat(2000)}"}` })]),
    ).rejects.toMatchObject({ code: 'config/invalid-value' });
  });

  it('stores the OpenAI and Gemini thinking switches and the OpenAI extra body', async () => {
    const repo = setup();
    const snapshot = await repo.patch([
      { path: 'providers.openai.thinking', value: true },
      { path: 'providers.gemini.thinking', value: true },
      { path: 'providers.openai.extraBody', value: ' { "service_tier": "flex" } ' },
    ]);
    expect(snapshot.data.providers.openai).toMatchObject({
      thinking: true,
      extraBody: ' { "service_tier": "flex" } ',
    });
    expect(snapshot.data.providers.gemini.thinking).toBe(true);
    const cleared = await repo.patch([{ path: 'providers.openai.extraBody', value: '{}' }]);
    expect(cleared.data.providers.openai.extraBody).toBe('{}');
  });
});

describe('ConfigRepository: custom styles (M4-B)', () => {
  const style = (name: string) => ({ name, description: `Write like ${name}.` });
  const add = (key: CustomStyleId, name: string): ConfigChange => ({
    path: 'customStyles',
    key,
    add: style(name),
  });
  const update = (key: CustomStyleId, fields: Record<string, unknown>): ConfigChange =>
    ({ path: 'customStyles', key, update: fields }) as ConfigChange;
  const remove = (key: CustomStyleId): ConfigChange => ({
    path: 'customStyles',
    key,
    remove: true,
  });
  const choose = (value: string): ConfigChange =>
    ({ path: 'translation.style', value }) as ConfigChange;
  const setup = () => createConfigRepository({ store: memoryStore(), uiLanguage });

  it('adds, updates in place and removes single entries, keeping their order', async () => {
    const repo = setup();
    await repo.patch([add('style-aaaaaaaa', 'a')]);
    await repo.patch([add('style-bbbbbbbb', 'b')]);
    const updated = await repo.patch([update('style-aaaaaaaa', { name: 'a2' })]);
    expect(Object.keys(updated.data.customStyles)).toEqual(['style-aaaaaaaa', 'style-bbbbbbbb']);
    expect(updated.data.customStyles['style-aaaaaaaa']).toEqual({ ...style('a'), name: 'a2' });
    const described = await repo.patch([update('style-aaaaaaaa', { description: 'Terse.' })]);
    expect(described.data.customStyles['style-aaaaaaaa']).toEqual({
      name: 'a2',
      description: 'Terse.',
    });
    const removed = await repo.patch([remove('style-aaaaaaaa')]);
    expect(Object.keys(removed.data.customStyles)).toEqual(['style-bbbbbbbb']);
  });

  it('trims the name and the description before storing them', async () => {
    const snapshot = await setup().patch([
      { path: 'customStyles', key: 'style-aaaaaaaa', add: { name: ' a ', description: '\n d \t' } },
    ]);
    expect(snapshot.data.customStyles['style-aaaaaaaa']).toEqual({ name: 'a', description: 'd' });
  });

  it('stores only the name and the description of an added style', async () => {
    const snapshot = await setup().patch([
      {
        path: 'customStyles',
        key: 'style-aaaaaaaa',
        add: { ...style('a'), prompt: 'x', extra: 1 },
      } as unknown as ConfigChange,
    ]);
    expect(snapshot.data.customStyles['style-aaaaaaaa']).toEqual(style('a'));
    const updated = await setup().patch([
      add('style-aaaaaaaa', 'a'),
      update('style-aaaaaaaa', { name: 'b', prompt: 'x' }),
    ]);
    expect(updated.data.customStyles['style-aaaaaaaa']).toEqual({ ...style('a'), name: 'b' });
  });

  it(`stops adding at ${MAX_CUSTOM_STYLES} entries but still allows updates`, async () => {
    const repo = setup();
    const ids = Array.from(
      { length: MAX_CUSTOM_STYLES },
      (_, index) => `style-${String(index).padStart(8, '0')}` as CustomStyleId,
    );
    await repo.patch(ids.map((id) => add(id, id.slice(-8))));
    await expect(repo.patch([add('style-zzzzzzzz', 'z')])).rejects.toMatchObject({
      code: 'config/style-limit',
    });
    await expect(
      repo.patch([update(ids[0] as CustomStyleId, { name: 'again' })]),
    ).resolves.toBeDefined();
  });

  it('never brings back a style that was removed', async () => {
    const repo = setup();
    await repo.patch([add('style-aaaaaaaa', 'a')]);
    await repo.patch([remove('style-aaaaaaaa')]);
    await expect(repo.patch([update('style-aaaaaaaa', { name: 'late' })])).rejects.toMatchObject({
      code: 'config/style-missing',
    });
    expect((await repo.load()).data.customStyles).toEqual({});
  });

  it('chooses a preset or an existing custom style, and refuses a missing one', async () => {
    const repo = setup();
    expect((await repo.patch([choose('tech')])).data.translation.style).toBe('tech');
    const both = await repo.patch([add('style-aaaaaaaa', 'a'), choose('style-aaaaaaaa')]);
    expect(both.data.translation.style).toBe('style-aaaaaaaa');
    await expect(repo.patch([choose('style-zzzzzzzz')])).rejects.toMatchObject({
      code: 'config/style-missing',
    });
    await expect(repo.patch([choose('formal')])).rejects.toMatchObject({
      code: 'config/invalid-value',
    });
    expect((await repo.load()).data.translation.style).toBe('style-aaaaaaaa');
  });

  it('falls back to general in the same write when the chosen style is removed', async () => {
    const repo = setup();
    await repo.patch([add('style-aaaaaaaa', 'a'), add('style-bbbbbbbb', 'b')]);
    await repo.patch([choose('style-aaaaaaaa')]);
    const other = await repo.patch([remove('style-bbbbbbbb')]);
    expect(other.data.translation.style).toBe('style-aaaaaaaa');
    const removed = await repo.patch([remove('style-aaaaaaaa')]);
    expect(removed.data.translation.style).toBe('general');
  });

  it('falls back to general when the custom styles are reset, or everything is', async () => {
    const repo = setup();
    await repo.patch([add('style-aaaaaaaa', 'a'), choose('style-aaaaaaaa')]);
    const styles = await repo.reset(['customStyles']);
    expect(styles.data.customStyles).toEqual({});
    expect(styles.data.translation.style).toBe('general');
    await repo.patch([add('style-aaaaaaaa', 'a'), choose('style-aaaaaaaa')]);
    const all = await repo.reset();
    expect(all.data.customStyles).toEqual({});
    expect(all.data.translation.style).toBe('general');
  });

  it('refuses blank or overlong fields and stores nothing', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    await repo.patch([add('style-aaaaaaaa', 'a')]);
    const before = structuredClone(store.data.get('config'));
    const refused: ConfigChange[] = [
      { path: 'customStyles', key: 'style-bbbbbbbb', add: { name: '  ', description: 'd' } },
      { path: 'customStyles', key: 'style-bbbbbbbb', add: { name: 'n', description: ' \n ' } },
      { path: 'customStyles', key: 'style-bbbbbbbb', add: { name: 'n' } as never },
      {
        path: 'customStyles',
        key: 'style-bbbbbbbb',
        add: { name: 'x'.repeat(21), description: 'd' },
      },
      {
        path: 'customStyles',
        key: 'style-bbbbbbbb',
        add: { name: 'n', description: 'x'.repeat(501) },
      },
      update('style-aaaaaaaa', { name: '' }),
      update('style-aaaaaaaa', { description: '   ' }),
      update('style-aaaaaaaa', { name: 42 }),
      update('style-aaaaaaaa', { description: 'x'.repeat(501) }),
    ];
    for (const change of refused) {
      await expect(repo.patch([change])).rejects.toMatchObject({ code: 'config/invalid-value' });
    }
    expect(store.data.get('config')).toEqual(before);
    // The limits count UTF-16 units, as the settings page does.
    const longest = await repo.patch([
      update('style-aaaaaaaa', { name: '名'.repeat(20), description: '说'.repeat(500) }),
    ]);
    expect(longest.data.customStyles['style-aaaaaaaa']?.name).toHaveLength(20);
  });

  it('rejects malformed ids, a taken id and replacing the whole record', async () => {
    const store = memoryStore();
    const repo = createConfigRepository({ store, uiLanguage });
    const badId = {
      path: 'customStyles',
      key: 'custom-aaaaaaaa',
      add: style('a'),
    } as unknown as ConfigChange;
    await expect(repo.patch([badId])).rejects.toMatchObject({ code: 'config/invalid-value' });
    const whole = { path: 'customStyles', value: {} } as unknown as ConfigChange;
    await expect(repo.patch([whole])).rejects.toMatchObject({ code: 'config/unknown-path' });
    expect(store.data.has('config')).toBe(false);
    await repo.patch([add('style-aaaaaaaa', 'a')]);
    await expect(repo.patch([add('style-aaaaaaaa', 'b')])).rejects.toMatchObject({
      code: 'config/invalid-value',
    });
  });

  it('keeps custom providers and custom styles apart', async () => {
    const repo = setup();
    const snapshot = await repo.patch([
      add('style-aaaaaaaa', 'a'),
      {
        path: 'customProviders',
        key: 'custom-aaaaaaaa',
        add: { name: 'p', baseURL: 'https://p.example.com/v1', model: 'm' },
      },
    ]);
    expect(Object.keys(snapshot.data.customStyles)).toEqual(['style-aaaaaaaa']);
    expect(Object.keys(snapshot.data.customProviders)).toEqual(['custom-aaaaaaaa']);
    await expect(
      repo.patch([{ path: 'translation.engine', value: 'custom-zzzzzzzz' }]),
    ).rejects.toMatchObject({ code: 'config/provider-missing' });
  });
});
