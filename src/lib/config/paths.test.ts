import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { CONFIG_PATHS, derivePaths, getPath, isConfigPath, setPath } from './paths';
import type { ConfigPath } from './types';

describe('getPath / setPath', () => {
  const value = { ui: { theme: 'dark', extra: 1 }, language: { target: 'ja' } };

  it('reads nested values and returns undefined for missing ones', () => {
    expect(getPath(value, 'ui.theme')).toBe('dark');
    expect(getPath(value, 'ui.missing.deep')).toBeUndefined();
  });

  it('sets a nested value without mutating the input', () => {
    const next = setPath(value, 'ui.theme', 'light');
    expect(next).toEqual({ ui: { theme: 'light', extra: 1 }, language: { target: 'ja' } });
    expect(value.ui.theme).toBe('dark');
    expect(next.language).toBe(value.language);
  });

  it('replaces arrays and records as a whole', () => {
    const source = { list: [1, 2, 3], map: { a: 1, b: 2 } };
    expect(setPath(source, 'list', [9])).toEqual({ list: [9], map: { a: 1, b: 2 } });
    expect(setPath(source, 'map', { c: 3 })).toEqual({ list: [1, 2, 3], map: { c: 3 } });
  });

  it('creates missing intermediate objects', () => {
    expect(setPath({}, 'a.b', 1)).toEqual({ a: { b: 1 } });
  });
});

describe('whitelist', () => {
  it('stops at leaves, arrays and records', () => {
    const schema = z.object({
      a: z.object({ b: z.string(), list: z.array(z.object({ x: z.number() })) }),
      map: z.record(z.string(), z.object({ y: z.number() })),
    });
    expect(derivePaths(schema)).toEqual(['a.b', 'a.list', 'map']);
  });

  it('unwraps optional, default and nullable objects before expanding', () => {
    const schema = z.object({
      a: z.object({ b: z.string() }).optional(),
      c: z.object({ d: z.string() }).default({ d: 'x' }),
      e: z.object({ f: z.string() }).nullable(),
    });
    expect(derivePaths(schema)).toEqual(['a.b', 'c.d', 'e.f']);
  });

  it('rejects paths outside the whitelist', () => {
    expect(isConfigPath('ui.theme')).toBe(true);
    expect(isConfigPath('ui')).toBe(false);
    expect(isConfigPath('ui.unknown')).toBe(false);
    expect(isConfigPath(42)).toBe(false);
  });

  it('matches the ConfigPath type exactly', () => {
    const expected = [
      'ui.theme',
      'language.target',
      'language.source',
      'translation.engine',
      'page.style',
      'page.mode',
      'page.isleDock',
      'page.holdKey',
      'selection.showDot',
      'providers.openai.baseURL',
      'providers.openai.model',
      'providers.openai.thinking',
      'providers.openai.extraBody',
      'providers.deepseek.model',
      'providers.deepseek.thinking',
      'providers.gemini.model',
      'providers.gemini.thinking',
      'customProviders',
    ] as const satisfies readonly ConfigPath[];
    // Type side: every ConfigPath is listed (and `satisfies` checks the reverse).
    expectTypeOf<Exclude<ConfigPath, (typeof expected)[number]>>().toEqualTypeOf<never>();
    expectTypeOf<ConfigPath>().toEqualTypeOf<(typeof expected)[number]>();
    // Runtime side: the schema-derived whitelist is the same set.
    expect([...CONFIG_PATHS].sort()).toEqual([...expected].sort());
  });
});
