import { type EngineFields, engineFields } from '@/lib/config/engine-fields';
import type { ConfigV1, Engine } from '@/lib/config/types';
import { normalizeBaseURL } from '@/lib/endpoint';
import { appError } from '@/lib/errors';
import type { ProviderAdapter, ProviderSettings } from '../types';
import { createGeminiAdapter } from './gemini';
import { createGoogleAdapter } from './google';
import { createOpenAICompatAdapter } from './openai-compat';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// DeepSeek thinks (at high effort) unless told not to: slow and costly for translation.
const DEEPSEEK_NO_THINKING = { thinking: { type: 'disabled' } };

const google = createGoogleAdapter();
const openaiCompat = createOpenAICompatAdapter();
const gemini = createGeminiAdapter();

export function getAdapter(engine: Engine): ProviderAdapter {
  if (engine === 'google') return google;
  if (engine === 'gemini') return gemini;
  return openaiCompat;
}

/**
 * Effective settings from raw field values: `baseURL` is normalized; engines
 * with a fixed endpoint ignore it, and Google needs neither. DeepSeek thinking
 * stays off unless `thinking` is true.
 */
export function settingsFor(engine: Engine, fields: EngineFields): ProviderSettings {
  if (engine === 'google') return { baseURL: '', model: '' };
  if (engine === 'deepseek') {
    const settings: ProviderSettings = { baseURL: DEEPSEEK_BASE_URL, model: fields.model };
    if (!fields.thinking) settings.extraBody = DEEPSEEK_NO_THINKING;
    return settings;
  }
  if (engine === 'gemini') return { baseURL: GEMINI_BASE_URL, model: fields.model };
  return { baseURL: normalizeBaseURL(fields.baseURL), model: fields.model };
}

/** Resolves the configured settings of an engine; a missing custom provider is a config error. */
export function resolveProviderSettings(
  engine: Engine,
  config: Pick<ConfigV1, 'providers' | 'customProviders'>,
): ProviderSettings {
  const fields = engineFields(config, engine);
  if (!fields) throw appError('config', 'config/provider-missing', 'Custom provider not found');
  return settingsFor(engine, fields);
}
