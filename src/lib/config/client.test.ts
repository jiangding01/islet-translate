import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readConfig, watchConfig } from './client';
import { EXTRA_DEFAULTS } from './test-fixtures';

vi.mock('@/lib/languages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/languages')>()),
  browserUiLanguage: () => 'ko-KR',
}));

const defaults = {
  ui: { theme: 'system' },
  language: { target: 'ko', source: 'auto' },
  ...EXTRA_DEFAULTS,
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('readConfig', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await readConfig()).toEqual({ schemaVersion: 1, data: defaults });
  });

  it('returns defaults after the key is removed', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'dark' } } },
    });
    await fakeBrowser.storage.local.remove('config');
    expect((await readConfig()).data).toEqual(defaults);
  });

  it('merges stored data with defaults', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'dark' } } },
    });
    expect((await readConfig()).data).toEqual({
      ...defaults,
      ui: { theme: 'dark' },
    });
  });

  it('uses defaults for a newer schemaVersion', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 2, data: { ui: { theme: 'dark' } } },
    });
    expect((await readConfig()).data).toEqual(defaults);
  });

  it('guards enum values it does not know', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'neon' }, language: { target: 'xx' } } },
    });
    expect((await readConfig()).data).toEqual(defaults);
  });

  it('guards the isle dock and keeps a valid one', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { page: { isleDock: 'top' } } },
    });
    expect((await readConfig()).data.page.isleDock).toBe('right');
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { page: { isleDock: 'bottom' } } },
    });
    expect((await readConfig()).data.page.isleDock).toBe('bottom');
  });

  it('fills the hold key for a config stored before it existed, and guards it', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { page: { style: 'plain', mode: 'bilingual' } } },
    });
    expect((await readConfig()).data.page.holdKey).toBe('ctrl');
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { page: { holdKey: 'shift' } } },
    });
    expect((await readConfig()).data.page.holdKey).toBe('ctrl');
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { page: { holdKey: ['alt'] } } },
    });
    expect((await readConfig()).data.page.holdKey).toBe('ctrl');
    for (const holdKey of ['alt', 'off'] as const) {
      await fakeBrowser.storage.local.set({
        config: { schemaVersion: 1, data: { page: { holdKey } } },
      });
      expect((await readConfig()).data.page.holdKey).toBe(holdKey);
    }
  });

  it('guards the selection dot flag and keeps a valid one', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { selection: { showDot: 'no' } } },
    });
    expect((await readConfig()).data.selection.showDot).toBe(true);
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { selection: { showDot: false } } },
    });
    expect((await readConfig()).data.selection.showDot).toBe(false);
  });

  it('fills DeepSeek thinking (off) for a config stored before it existed', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { providers: { deepseek: { model: 'd' } } } },
    });
    expect((await readConfig()).data.providers.deepseek).toEqual({ model: 'd', thinking: false });
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { providers: { deepseek: { thinking: true } } } },
    });
    expect((await readConfig()).data.providers.deepseek.thinking).toBe(true);
  });

  it('guards the engine and source language enums', async () => {
    await fakeBrowser.storage.local.set({
      config: {
        schemaVersion: 1,
        data: { language: { source: 'klingon' }, translation: { engine: 'bing' } },
      },
    });
    const { data } = await readConfig();
    expect(data.language.source).toBe('auto');
    expect(data.translation.engine).toBe('google');

    await fakeBrowser.storage.local.set({
      config: {
        schemaVersion: 1,
        data: { language: { source: 'ja' }, translation: { engine: 'gemini' } },
      },
    });
    const next = (await readConfig()).data;
    expect(next.language.source).toBe('ja');
    expect(next.translation.engine).toBe('gemini');
  });

  it('fills the provider defaults when they are missing', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { providers: { openai: { model: 'x' } } } },
    });
    const { data } = await readConfig();
    expect(data.providers.openai).toEqual({ baseURL: 'https://api.openai.com/v1', model: 'x' });
    expect(data.customProviders).toEqual({});
  });

  it('keeps well-formed custom providers in order and drops malformed ones', async () => {
    const ollama = { name: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'm' };
    const router = { name: 'Router', baseURL: 'https://router.example.com/v1', model: 'r' };
    await fakeBrowser.storage.local.set({
      config: {
        schemaVersion: 1,
        data: {
          translation: { engine: 'custom-bbbbbbbb' },
          customProviders: {
            'custom-bbbbbbbb': router,
            'custom-aaaaaaaa': ollama,
            'not-an-id': ollama,
            'custom-cccccccc': { name: 1 },
          },
        },
      },
    });
    const { data } = await readConfig();
    expect(Object.keys(data.customProviders)).toEqual(['custom-bbbbbbbb', 'custom-aaaaaaaa']);
    expect(data.translation.engine).toBe('custom-bbbbbbbb');
  });

  it('falls back to the default engine when the custom provider is missing', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { translation: { engine: 'custom-zzzzzzzz' } } },
    });
    expect((await readConfig()).data.translation.engine).toBe('google');
  });
});

describe('watchConfig', () => {
  it('fires on config changes only, and stops after unsubscribe', async () => {
    const callback = vi.fn();
    const unwatch = watchConfig(callback);

    await fakeBrowser.storage.local.set({ other: 1 });
    await flush();
    expect(callback).not.toHaveBeenCalled();

    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'light' }, language: { target: 'ja' } } },
    });
    await flush();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      data: { ...defaults, ui: { theme: 'light' }, language: { target: 'ja', source: 'auto' } },
    });

    unwatch();
    await fakeBrowser.storage.local.set({ config: { schemaVersion: 1, data: {} } });
    await flush();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('falls back to defaults when the key is deleted', async () => {
    await fakeBrowser.storage.local.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'dark' } } },
    });
    const callback = vi.fn();
    watchConfig(callback);
    await fakeBrowser.storage.local.remove('config');
    await flush();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenLastCalledWith({ schemaVersion: 1, data: defaults });
  });

  it('ignores changes in other storage areas', async () => {
    const callback = vi.fn();
    watchConfig(callback);
    await fakeBrowser.storage.sync.set({
      config: { schemaVersion: 1, data: { ui: { theme: 'dark' } } },
    });
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });
});
