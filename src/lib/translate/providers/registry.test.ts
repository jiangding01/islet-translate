import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import { resolveProviderSettings, settingsFor } from './registry';

const NO_THINKING = { thinking: { type: 'disabled' } };

describe('provider settings', () => {
  it('turns DeepSeek thinking off unless it is enabled', () => {
    const off = settingsFor('deepseek', { baseURL: '', model: 'deepseek-chat', thinking: false });
    expect(off).toEqual({
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      extraBody: NO_THINKING,
    });
    const on = settingsFor('deepseek', { baseURL: '', model: 'deepseek-chat', thinking: true });
    expect(on).toEqual({ baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' });
  });

  it('sends no extra body fields for any other engine', () => {
    const fields = { baseURL: 'https://llm.example.com/v1', model: 'm', thinking: false };
    for (const engine of ['google', 'openai', 'gemini', 'custom-aaaaaaaa'] as const) {
      expect(settingsFor(engine, fields)).not.toHaveProperty('extraBody');
    }
  });

  it('resolves DeepSeek thinking from the config', () => {
    const config = createDefaultConfig('en');
    config.customProviders['custom-aaaaaaaa'] = {
      name: 'A',
      baseURL: 'http://localhost:11434/v1',
      model: 'q',
    };
    expect(resolveProviderSettings('deepseek', config).extraBody).toEqual(NO_THINKING);
    for (const engine of ['google', 'openai', 'gemini', 'custom-aaaaaaaa'] as const) {
      expect(resolveProviderSettings(engine, config)).not.toHaveProperty('extraBody');
    }
    config.providers.deepseek.thinking = true;
    expect(resolveProviderSettings('deepseek', config)).not.toHaveProperty('extraBody');
  });
});
