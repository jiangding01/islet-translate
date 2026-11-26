import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from './defaults';
import { engineFields, fieldChange, hasEditableBaseURL, takesApiKey } from './engine-fields';
import { BUILTIN_ENGINES } from './types';

describe('engine fields', () => {
  const config = createDefaultConfig('en');
  config.customProviders['custom-aaaaaaaa'] = {
    name: 'A',
    baseURL: 'http://localhost:11434/v1',
    model: 'q',
  };

  it('reads every engine from one place', () => {
    expect(engineFields(config, 'google')).toEqual({ baseURL: '', model: '' });
    expect(engineFields(config, 'openai')).toEqual({
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      thinking: false,
      extraBody: '',
    });
    expect(engineFields(config, 'deepseek')).toEqual({
      baseURL: '',
      model: 'deepseek-chat',
      thinking: false,
    });
    expect(engineFields(config, 'gemini')).toEqual({ baseURL: '', model: '', thinking: false });
    expect(engineFields(config, 'custom-aaaaaaaa')).toEqual({
      baseURL: 'http://localhost:11434/v1',
      model: 'q',
      extraBody: '',
    });
    expect(engineFields(config, 'custom-zzzzzzzz')).toBeUndefined();
  });

  it('gives OpenAI, DeepSeek and Gemini a thinking switch, OpenAI and custom providers extra fields', () => {
    const engines = [...BUILTIN_ENGINES, 'custom-aaaaaaaa'] as const;
    expect(
      engines.filter((engine) => engineFields(config, engine)?.thinking !== undefined),
    ).toEqual(['openai', 'deepseek', 'gemini']);
    expect(
      engines.filter((engine) => engineFields(config, engine)?.extraBody !== undefined),
    ).toEqual(['openai', 'custom-aaaaaaaa']);
  });

  it('reads the saved extra body text as it is', () => {
    const withExtra = {
      ...config,
      providers: { ...config.providers, openai: { ...config.providers.openai, extraBody: ' {} ' } },
      customProviders: {
        'custom-aaaaaaaa': { name: 'A', baseURL: 'u', model: 'q', extraBody: '{"a":1}' },
      },
    };
    expect(engineFields(withExtra, 'openai')?.extraBody).toBe(' {} ');
    expect(engineFields(withExtra, 'custom-aaaaaaaa')?.extraBody).toBe('{"a":1}');
  });

  it('reads DeepSeek thinking as on only when it is exactly true', () => {
    const deepseek = (thinking: unknown) =>
      engineFields(
        {
          ...config,
          providers: { ...config.providers, deepseek: { model: 'd', thinking } },
        } as never,
        'deepseek',
      )?.thinking;
    expect(deepseek(true)).toBe(true);
    expect(deepseek(false)).toBe(false);
    expect(deepseek(undefined)).toBe(false);
    expect(deepseek('yes')).toBe(false);
    const openai = (thinking: unknown) =>
      engineFields(
        {
          ...config,
          providers: { ...config.providers, openai: { ...config.providers.openai, thinking } },
        } as never,
        'openai',
      )?.thinking;
    expect(openai(true)).toBe(true);
    expect(openai('yes')).toBe(false);
  });

  it('writes each field to its own path, and updates custom providers field by field', () => {
    expect(fieldChange('openai', 'baseURL', 'u')).toEqual({
      path: 'providers.openai.baseURL',
      value: 'u',
    });
    expect(fieldChange('gemini', 'model', 'g')).toEqual({
      path: 'providers.gemini.model',
      value: 'g',
    });
    expect(fieldChange('deepseek', 'baseURL', 'u')).toBeUndefined();
    expect(fieldChange('google', 'model', 'x')).toBeUndefined();
    expect(fieldChange('openai', 'extraBody', '{}')).toEqual({
      path: 'providers.openai.extraBody',
      value: '{}',
    });
    expect(fieldChange('custom-aaaaaaaa', 'extraBody', '{}')).toEqual({
      path: 'customProviders',
      key: 'custom-aaaaaaaa',
      update: { extraBody: '{}' },
    });
    for (const engine of ['google', 'deepseek', 'gemini'] as const) {
      expect(fieldChange(engine, 'extraBody', '{}')).toBeUndefined();
    }
    expect(fieldChange('custom-aaaaaaaa', 'model', 'm')).toEqual({
      path: 'customProviders',
      key: 'custom-aaaaaaaa',
      update: { model: 'm' },
    });
  });

  it('knows which engines take a base URL and a key', () => {
    expect(BUILTIN_ENGINES.filter(hasEditableBaseURL)).toEqual(['openai']);
    expect(hasEditableBaseURL('custom-aaaaaaaa')).toBe(true);
    expect(BUILTIN_ENGINES.filter(takesApiKey)).toEqual(['openai', 'deepseek', 'gemini']);
  });
});
