import { describe, expect, it } from 'vitest';
import { thinkingRule } from './thinking-rules';

const OPENAI = 'https://api.openai.com/v1';
const openai = (model: string, baseURL = OPENAI) => thinkingRule('openai', model, baseURL);
const gemini = (model: string) => thinkingRule('gemini', model, '');
const effort = (reasoning_effort: string, kind: 'off' | 'minimum') => ({
  kind,
  body: { reasoning_effort },
});
const geminiConfig = (thinkingConfig: Record<string, unknown>, kind: 'off' | 'minimum') => ({
  kind,
  body: { generationConfig: { thinkingConfig } },
});

describe('thinking rules: OpenAI', () => {
  it.each(['gpt-5.1', 'gpt-5.2', 'gpt-5.5', 'gpt-6-luna', 'gpt-6.1-terra'])(
    'turns %s thinking off with "none"',
    (model) => {
      expect(openai(model)).toEqual(effort('none', 'off'));
    },
  );

  it.each(['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])('lowers %s to "minimal"', (model) => {
    expect(openai(model)).toEqual(effort('minimal', 'minimum'));
  });

  it.each(['gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol'])('lowers %s to "low"', (model) => {
    expect(openai(model)).toEqual(effort('low', 'minimum'));
  });

  it.each([
    'o3',
    'gpt-4.1',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5.1-mini',
    'gpt-5.1-chat-latest',
    'gpt-5-mini-tts',
    'gpt-5o',
    'gpt-55',
    'my-gpt-5',
    '',
  ])('sends nothing for %j', (model) => {
    expect(openai(model)).toBeUndefined();
  });

  it('accepts dated, preview and numbered snapshots of a listed model only', () => {
    expect(openai('gpt-5-mini-2025-08-07')).toEqual(effort('minimal', 'minimum'));
    expect(openai('gpt-5.1-2025-11-13')).toEqual(effort('none', 'off'));
    expect(openai('gpt-5.1-preview')).toEqual(effort('none', 'off'));
    expect(openai('gpt-5-001')).toEqual(effort('minimal', 'minimum'));
    expect(openai('gpt-5-2025-08')).toBeUndefined();
    expect(openai('gpt-5-latest')).toBeUndefined();
    expect(openai('gpt-5-0001')).toBeUndefined();
  });

  it('trims the model and drops a models/ prefix', () => {
    expect(openai('  gpt-5-mini  ')).toEqual(effort('minimal', 'minimum'));
    expect(openai('models/gpt-5.1')).toEqual(effort('none', 'off'));
  });

  it('sends thinking fields only to the official endpoint', () => {
    expect(openai('gpt-5-mini', 'https://api.openai.com/v1/')).toEqual(
      effort('minimal', 'minimum'),
    );
    expect(openai('gpt-5-mini', ' https://api.openai.com/v1/chat/completions ')).toEqual(
      effort('minimal', 'minimum'),
    );
    // Host names are case-insensitive and 443 is the https default: still the official one.
    for (const baseURL of ['https://API.openai.com/v1', 'https://api.openai.com:443/v1']) {
      expect(openai('gpt-5-mini', baseURL)).toEqual(effort('minimal', 'minimum'));
    }
    for (const baseURL of [
      'https://api.openai.com:8443/v1',
      'https://user@api.openai.com/v1',
      'https://api.openai.com/v1?x=1',
      'not a url',
      'https://proxy.example.com/v1',
      'https://api.openai.com/v2',
      'https://api.openai.com',
      'http://api.openai.com/v1',
      'http://localhost:11434/v1',
      '',
    ]) {
      expect(openai('gpt-5-mini', baseURL)).toBeUndefined();
    }
  });

  it('knows no model of a custom provider, even on the official endpoint', () => {
    expect(thinkingRule('custom-aaaaaaaa', 'gpt-5-mini', OPENAI)).toBeUndefined();
    expect(thinkingRule('google', 'gpt-5-mini', OPENAI)).toBeUndefined();
  });
});

describe('thinking rules: Gemini', () => {
  it.each(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])('turns %s thinking off', (model) => {
    expect(gemini(model)).toEqual(geminiConfig({ thinkingBudget: 0 }, 'off'));
  });

  it('lowers 2.5 Pro to its minimum budget', () => {
    expect(gemini('gemini-2.5-pro')).toEqual(geminiConfig({ thinkingBudget: 128 }, 'minimum'));
  });

  it.each([
    'gemini-3-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
  ])('lowers %s to MINIMAL', (model) => {
    expect(gemini(model)).toEqual(geminiConfig({ thinkingLevel: 'MINIMAL' }, 'minimum'));
  });

  it.each([
    'gemini-3-pro-preview',
    'gemini-3.1-pro',
    'gemini-3.1-pro-preview',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-4-hydrogen',
    'gemini-4-carbon',
    'gemini-4-neon',
    'gemini-4-argon',
  ])('lowers %s to LOW', (model) => {
    expect(gemini(model)).toEqual(geminiConfig({ thinkingLevel: 'LOW' }, 'minimum'));
  });

  it('accepts the suffixes of snapshots and previews', () => {
    const off = geminiConfig({ thinkingBudget: 0 }, 'off');
    expect(gemini('models/gemini-2.5-flash')).toEqual(off);
    expect(gemini('gemini-2.5-flash-preview-05-20')).toEqual(off);
    expect(gemini('gemini-2.5-flash-lite-preview-09-2025')).toEqual(off);
    expect(gemini('gemini-2.5-flash-001')).toEqual(off);
    expect(gemini('gemini-2.5-flash-2025-06-17')).toEqual(off);
  });

  it.each([
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-flash-tts',
    'gemini-2.5-flash-live',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-4',
    'gemini-4-carbon-cyber',
    '',
  ])('sends nothing for %j', (model) => {
    expect(gemini(model)).toBeUndefined();
  });
});

describe('thinking rules: DeepSeek', () => {
  it('turns thinking off for any DeepSeek model, as in #88', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'whatever', '']) {
      expect(thinkingRule('deepseek', model, '')).toEqual({
        kind: 'off',
        body: { thinking: { type: 'disabled' } },
      });
    }
  });
});

describe('thinking rules: results are not shared', () => {
  it('returns a body the caller may change without touching the table', () => {
    const body = gemini('gemini-2.5-flash')?.body as {
      generationConfig: { thinkingConfig: { thinkingBudget: number } };
    };
    body.generationConfig.thinkingConfig.thinkingBudget = 9;
    expect(gemini('gemini-2.5-flash')).toEqual(geminiConfig({ thinkingBudget: 0 }, 'off'));
  });
});
