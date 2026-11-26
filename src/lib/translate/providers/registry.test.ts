import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { EngineFields } from '@/lib/config/engine-fields';
import { resolveProviderSettings, settingsFor } from './registry';

const NO_THINKING = { thinking: { type: 'disabled' } };
const OPENAI = 'https://api.openai.com/v1';
const fields = (extra: Partial<EngineFields> = {}): EngineFields => ({
  baseURL: OPENAI,
  model: 'gpt-5-mini',
  thinking: false,
  extraBody: '',
  ...extra,
});

describe('provider settings', () => {
  it('turns DeepSeek thinking off unless it is enabled', () => {
    const off = settingsFor('deepseek', { baseURL: '', model: 'deepseek-chat', thinking: false });
    expect(off).toEqual({
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      extraBody: NO_THINKING,
    });
    const on = settingsFor('deepseek', { baseURL: '', model: 'deepseek-chat', thinking: true });
    // Thinking on changes the request (no "disabled" field), so it keys the cache apart.
    expect(on).toEqual({
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      cacheParams: { thinking: true },
    });
  });

  it('lowers OpenAI thinking on the official endpoint, and keys the cache only when on', () => {
    expect(settingsFor('openai', fields())).toEqual({
      baseURL: OPENAI,
      model: 'gpt-5-mini',
      extraBody: { reasoning_effort: 'minimal' },
    });
    expect(settingsFor('openai', fields({ model: 'gpt-5.1' })).extraBody).toEqual({
      reasoning_effort: 'none',
    });
    expect(settingsFor('openai', fields({ thinking: true }))).toEqual({
      baseURL: OPENAI,
      model: 'gpt-5-mini',
      cacheParams: { thinking: true },
    });
  });

  it('sends no thinking fields to a proxy or for an unknown model, and keeps the cache key', () => {
    for (const extra of [
      { baseURL: 'https://proxy.example.com/v1' },
      { model: 'gpt-4o' },
      { model: 'gpt-5.1-mini' },
    ]) {
      for (const thinking of [false, true]) {
        const settings = settingsFor('openai', fields({ ...extra, thinking }));
        expect(settings).not.toHaveProperty('extraBody');
        expect(settings).not.toHaveProperty('cacheParams');
      }
    }
  });

  it('lowers Gemini thinking through generationConfig, and keys the cache only when on', () => {
    const gemini = (model: string, thinking: boolean) =>
      settingsFor('gemini', { baseURL: 'ignored', model, thinking });
    expect(gemini('gemini-2.5-flash', false)).toEqual({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      extraBody: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    expect(gemini('gemini-3.8-flash', false).extraBody).toEqual({
      generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
    });
    expect(gemini('gemini-2.5-flash', true)).toEqual({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      cacheParams: { thinking: true },
    });
    for (const thinking of [false, true]) {
      const settings = gemini('gemini-2.0-flash', thinking);
      expect(settings).not.toHaveProperty('extraBody');
      expect(settings).not.toHaveProperty('cacheParams');
    }
  });

  it('puts the user extra fields after thinking, and keys the cache by their parsed value', () => {
    const settings = settingsFor(
      'openai',
      fields({ extraBody: '{"reasoning_effort": "high", "service_tier": "flex"}' }),
    );
    expect(settings.extraBody).toEqual({ reasoning_effort: 'high', service_tier: 'flex' });
    expect(Object.keys(settings.extraBody ?? {})).toEqual(['reasoning_effort', 'service_tier']);
    expect(settings.cacheParams).toEqual({
      extraBody: { reasoning_effort: 'high', service_tier: 'flex' },
    });
    const custom = settingsFor('custom-aaaaaaaa', {
      baseURL: 'http://localhost:11434/v1/',
      model: 'q',
      extraBody: '{"think": false}',
    });
    expect(custom).toEqual({
      baseURL: 'http://localhost:11434/v1',
      model: 'q',
      extraBody: { think: false },
      cacheParams: { extraBody: { think: false } },
    });
  });

  it('ignores blank, empty and invalid extra fields (hand-edited storage)', () => {
    for (const extraBody of ['', '  ', '{}', '[1]', '{oops', 'null', '{"__proto__": {"x": 1}}']) {
      const settings = settingsFor('custom-aaaaaaaa', {
        baseURL: 'https://llm.example.com/v1',
        model: 'm',
        extraBody,
      });
      expect(settings).toEqual({ baseURL: 'https://llm.example.com/v1', model: 'm' });
    }
  });

  it('never sends user extra fields for Gemini, DeepSeek or Google', () => {
    const extraBody = '{"a": 1}';
    expect(settingsFor('google', { baseURL: '', model: '', extraBody })).toEqual({
      baseURL: '',
      model: '',
    });
    expect(
      settingsFor('gemini', { baseURL: '', model: 'gemini-2.0-flash', extraBody }),
    ).not.toHaveProperty('extraBody');
    expect(
      settingsFor('deepseek', { baseURL: '', model: 'deepseek-chat', thinking: true, extraBody }),
    ).not.toHaveProperty('extraBody');
  });

  it('resolves thinking and extra fields from the config', () => {
    const config = createDefaultConfig('en');
    config.customProviders['custom-aaaaaaaa'] = {
      name: 'A',
      baseURL: 'http://localhost:11434/v1',
      model: 'q',
    };
    expect(resolveProviderSettings('deepseek', config).extraBody).toEqual(NO_THINKING);
    // The default OpenAI model is a reasoning model on the official endpoint.
    expect(resolveProviderSettings('openai', config).extraBody).toEqual({
      reasoning_effort: 'minimal',
    });
    for (const engine of ['google', 'gemini', 'custom-aaaaaaaa'] as const) {
      expect(resolveProviderSettings(engine, config)).not.toHaveProperty('extraBody');
    }
    for (const engine of ['google', 'openai', 'deepseek', 'gemini', 'custom-aaaaaaaa'] as const) {
      expect(resolveProviderSettings(engine, config)).not.toHaveProperty('cacheParams');
    }
    config.providers.deepseek.thinking = true;
    expect(resolveProviderSettings('deepseek', config)).not.toHaveProperty('extraBody');
    config.providers.openai.extraBody = '{"x": 1}';
    expect(resolveProviderSettings('openai', config).extraBody).toEqual({
      reasoning_effort: 'minimal',
      x: 1,
    });
    config.customProviders['custom-aaaaaaaa'] = {
      name: 'A',
      baseURL: 'http://localhost:11434/v1',
      model: 'q',
      extraBody: '{"think": false}',
    };
    expect(resolveProviderSettings('custom-aaaaaaaa', config).extraBody).toEqual({ think: false });
  });
});
