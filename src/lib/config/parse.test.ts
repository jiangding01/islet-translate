import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MAX_REPAIR_ROUNDS, parseStoredConfig } from './parse';
import { configSchema } from './schema';
import { EXTRA_DEFAULTS } from './test-fixtures';

const uiLanguage = 'ja-JP';
const defaults = {
  ui: { theme: 'system' },
  language: { target: 'ja', source: 'auto' },
  ...EXTRA_DEFAULTS,
};
const stored = (data: unknown) => ({ schemaVersion: 1, data });
const parse = (raw: unknown) => parseStoredConfig(raw, { uiLanguage });

describe('parseStoredConfig', () => {
  it.each([undefined, null, 'x', 42, []])('returns defaults for %j and marks repaired', (raw) => {
    const result = parse(raw);
    expect(result.snapshot).toEqual({ schemaVersion: 1, data: defaults });
    expect(result.repaired).toBe(true);
    expect(result.readOnly).toBe(false);
  });

  it('keeps valid data as-is without marking repaired', () => {
    const data = {
      ui: { theme: 'dark' },
      language: { target: 'ko', source: 'ja' },
      translation: { engine: 'openai' },
      page: { style: 'highlight', mode: 'translation', isleDock: 'left', holdKey: 'alt' },
      selection: { showDot: false },
      providers: { ...EXTRA_DEFAULTS.providers, gemini: { model: 'm' } },
      customProviders: {},
    };
    const result = parse(stored(data));
    expect(result.snapshot.data).toEqual(data);
    expect(result.repaired).toBe(false);
    expect(result.resetPaths).toEqual([]);
  });

  it('drops only the broken custom provider entry, keeping the others and their order', () => {
    const good = { name: 'A', baseURL: 'https://a.example.com/v1', model: 'm' };
    const result = parse(
      stored({
        ...defaults,
        translation: { engine: 'custom-bbbbbbbb' },
        customProviders: {
          'custom-cccccccc': good,
          'custom-aaaaaaaa': { name: 1, baseURL: 'x', model: 'y' },
          'Bad Key': good,
          'custom-bbbbbbbb': good,
        },
      }),
    );
    expect(result.fallback).toBe(false);
    expect(Object.keys(result.snapshot.data.customProviders)).toEqual([
      'custom-cccccccc',
      'custom-bbbbbbbb',
    ]);
    expect(result.snapshot.data.translation.engine).toBe('custom-bbbbbbbb');
    expect(result.resetPaths).toEqual(
      expect.arrayContaining(['customProviders.custom-aaaaaaaa', 'customProviders.Bad Key']),
    );
  });

  it('removes an entry whose key contains a dot without losing anything else', () => {
    const good = { name: 'A', baseURL: 'https://a.example.com/v1', model: 'm' };
    const result = parse(
      stored({
        ...defaults,
        ui: { theme: 'dark' },
        customProviders: { 'bad.key': good, 'custom-abcd1234': good },
      }),
    );
    expect(result.fallback).toBe(false);
    expect(result.snapshot.data.ui.theme).toBe('dark');
    expect(Object.keys(result.snapshot.data.customProviders)).toEqual(['custom-abcd1234']);
    expect(result.resetPaths).toEqual(['customProviders.bad.key']);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'removes an entry keyed %s instead of reaching Object.prototype',
    (key) => {
      const good = { name: 'A', baseURL: 'https://a.example.com/v1', model: 'm' };
      const result = parse(
        stored({ ...defaults, ui: { theme: 'dark' }, customProviders: { [key]: good } }),
      );
      expect(result.fallback).toBe(false);
      expect(result.snapshot.data.ui.theme).toBe('dark');
      expect(result.snapshot.data.customProviders).toEqual({});
    },
  );

  it('keeps more than ten stored providers (the limit applies when adding)', () => {
    const good = { name: 'A', baseURL: 'https://a.example.com/v1', model: 'm' };
    const customProviders = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`custom-${String(index).padStart(8, '0')}`, good]),
    );
    const result = parse(stored({ ...defaults, customProviders }));
    expect(Object.keys(result.snapshot.data.customProviders)).toHaveLength(11);
    expect(result.repaired).toBe(false);
  });

  it('repairs an unknown isle dock to the default and fills it when missing', () => {
    const broken = parse(stored({ ...defaults, page: { ...defaults.page, isleDock: 'top' } }));
    expect(broken.resetPaths).toContain('page.isleDock');
    expect(broken.snapshot.data.page.isleDock).toBe('right');
    const { isleDock: _omitted, ...rest } = defaults.page;
    const missing = parse(stored({ ...defaults, page: rest }));
    expect(missing.snapshot.data.page.isleDock).toBe('right');
  });

  it('repairs an unknown hold key to the default and fills it when missing', () => {
    const broken = parse(stored({ ...defaults, page: { ...defaults.page, holdKey: 'shift' } }));
    expect(broken.resetPaths).toContain('page.holdKey');
    expect(broken.snapshot.data.page.holdKey).toBe('ctrl');
    const { holdKey: _omitted, ...rest } = defaults.page;
    const missing = parse(stored({ ...defaults, page: rest }));
    expect(missing.snapshot.data.page.holdKey).toBe('ctrl');
  });

  it('repairs a non-boolean selection dot flag and fills it when missing', () => {
    const broken = parse(stored({ ...defaults, selection: { showDot: 'yes' } }));
    expect(broken.resetPaths).toContain('selection.showDot');
    expect(broken.snapshot.data.selection.showDot).toBe(true);
    const { selection: _omitted, ...rest } = defaults;
    const missing = parse(stored(rest));
    expect(missing.snapshot.data.selection.showDot).toBe(true);
  });

  it('fills DeepSeek thinking (off) for a config stored before it existed, and repairs it', () => {
    const missing = parse(
      stored({ ...defaults, providers: { ...defaults.providers, deepseek: { model: 'd' } } }),
    );
    expect(missing.snapshot.data.providers.deepseek).toEqual({ model: 'd', thinking: false });
    expect(missing.repaired).toBe(true);
    expect(missing.resetPaths).toEqual([]);
    const broken = parse(
      stored({
        ...defaults,
        providers: { ...defaults.providers, deepseek: { model: 'd', thinking: 'yes' } },
      }),
    );
    expect(broken.resetPaths).toContain('providers.deepseek.thinking');
    expect(broken.snapshot.data.providers.deepseek).toEqual({ model: 'd', thinking: false });
  });

  it('resets a default engine that points at a missing custom provider to Google', () => {
    const result = parse(stored({ ...defaults, translation: { engine: 'custom-zzzzzzzz' } }));
    expect(result.snapshot.data.translation.engine).toBe('google');
    expect(result.resetPaths).toContain('translation.engine');
    expect(result.fallback).toBe(false);
  });

  it('preserves unknown keys at every level', () => {
    const data = {
      ui: { theme: 'dark', density: 'compact' },
      language: { target: 'en', source: 'auto' },
      ...EXTRA_DEFAULTS,
      future: 1,
    };
    const result = parse(stored(data));
    expect(result.snapshot.data).toEqual(data);
    expect(result.repaired).toBe(false);
  });

  it('fills missing fields with defaults and marks repaired', () => {
    const result = parse(stored({ ui: { theme: 'dark' } }));
    expect(result.snapshot.data).toEqual({ ...defaults, ui: { theme: 'dark' } });
    expect(result.repaired).toBe(true);
  });

  it('fills the fields added after M0 into an old stored config', () => {
    const result = parse(stored({ ui: { theme: 'dark' }, language: { target: 'ko' } }));
    expect(result.snapshot.data).toEqual({
      ...defaults,
      ui: { theme: 'dark' },
      language: { target: 'ko', source: 'auto' },
    });
    expect(result.repaired).toBe(true);
  });

  it('resets an invalid engine, source language and provider field independently', () => {
    const result = parse(
      stored({
        ...defaults,
        language: { target: 'ko', source: 'xx' },
        translation: { engine: 'bing' },
        providers: { ...defaults.providers, openai: { baseURL: 1, model: 'm' } },
      }),
    );
    expect(result.snapshot.data).toEqual({
      ...defaults,
      language: { target: 'ko', source: 'auto' },
      providers: {
        ...defaults.providers,
        openai: { baseURL: 'https://api.openai.com/v1', model: 'm' },
      },
    });
    expect(result.resetPaths.sort()).toEqual([
      'language.source',
      'providers.openai.baseURL',
      'translation.engine',
    ]);
  });

  it('resets only the invalid leaf', () => {
    const result = parse(stored({ ui: { theme: 'neon', keep: true }, language: { target: 'ko' } }));
    expect(result.snapshot.data).toEqual({
      ...defaults,
      ui: { theme: 'system', keep: true },
      language: { target: 'ko', source: 'auto' },
    });
    expect(result.repaired).toBe(true);
    expect(result.resetPaths).toEqual(['ui.theme']);
  });

  it('resets several invalid leaves independently', () => {
    const result = parse(stored({ ui: { theme: 1 }, language: { target: 'xx', keep: 'y' } }));
    expect(result.snapshot.data).toEqual({
      ...defaults,
      language: { target: 'ja', source: 'auto', keep: 'y' },
    });
    expect(result.resetPaths.sort()).toEqual(['language.target', 'ui.theme']);
  });

  it('replaces a parent of the wrong type with its default subtree', () => {
    const result = parse(stored({ ui: 'x', language: { target: 'ko' } }));
    expect(result.snapshot.data).toEqual({
      ...defaults,
      language: { target: 'ko', source: 'auto' },
    });
    expect(result.resetPaths).toEqual(['ui']);
  });

  it('resets everything for a root-level issue', () => {
    const result = parse(stored('not an object'));
    expect(result.snapshot.data).toEqual(defaults);
    expect(result.resetPaths).toEqual(['']);
    expect(result.fallback).toBe(false);
  });

  it('drops only the invalid array elements', () => {
    const schema = configSchema.extend({
      styles: z.array(z.object({ name: z.string() })),
    });
    const result = parseStoredConfig(
      stored({ ...defaults, styles: [{ name: 'a' }, { name: 1 }, 'bad', { name: 'b' }] }),
      { uiLanguage, schema },
    );
    expect(result.snapshot.data).toMatchObject({ styles: [{ name: 'a' }, { name: 'b' }] });
    expect(result.resetPaths.sort()).toEqual(['styles.1.name', 'styles.2']);
  });

  it(`falls back to defaults after ${MAX_REPAIR_ROUNDS} rounds that do not converge`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const schema = configSchema.superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', message: 'never valid', path: ['ui', 'theme'] });
    });
    const result = parseStoredConfig(stored(defaults), { uiLanguage, schema });
    expect(result.fallback).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.snapshot.data).toEqual(defaults);
    expect(result.resetPaths).toHaveLength(MAX_REPAIR_ROUNDS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('enters read-only mode for a newer schemaVersion', () => {
    const result = parse({ schemaVersion: 2, data: { whatever: true } });
    expect(result.readOnly).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.snapshot.data).toEqual(defaults);
  });

  it('treats a missing schemaVersion as needing a write-back', () => {
    const result = parse({ data: { ui: { theme: 'dark' }, language: { target: 'en' } } });
    expect(result.snapshot.data).toEqual({
      ...defaults,
      ui: { theme: 'dark' },
      language: { target: 'en', source: 'auto' },
    });
    expect(result.repaired).toBe(true);
  });
});
