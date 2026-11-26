import { type EngineFields, engineFields, hasEditableBaseURL } from '@/lib/config/engine-fields';
import { parseExtraBody } from '@/lib/config/extra-body';
import { thinkingRule } from '@/lib/config/thinking-rules';
import type { ConfigV1, Engine } from '@/lib/config/types';
import { normalizeBaseURL } from '@/lib/endpoint';
import { appError } from '@/lib/errors';
import type { ProviderAdapter, ProviderSettings } from '../types';
import { createGeminiAdapter } from './gemini';
import { createGoogleAdapter } from './google';
import { createOpenAICompatAdapter } from './openai-compat';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const google = createGoogleAdapter();
const openaiCompat = createOpenAICompatAdapter();
const gemini = createGeminiAdapter();

export function getAdapter(engine: Engine): ProviderAdapter {
  if (engine === 'google') return google;
  if (engine === 'gemini') return gemini;
  return openaiCompat;
}

/**
 * Effective settings from raw field values: `baseURL` is normalized; engines with a fixed
 * endpoint ignore it, and Google needs neither. While thinking is off, a model the rule table
 * knows gets its lowest thinking level; the user's extra fields (OpenAI and custom providers)
 * come after, so they may change it. `cacheParams` holds only what makes the request differ
 * from the default one, so default requests keep their cache keys.
 */
export function settingsFor(engine: Engine, fields: EngineFields): ProviderSettings {
  if (engine === 'google') return { baseURL: '', model: '' };
  const baseURL =
    engine === 'deepseek'
      ? DEEPSEEK_BASE_URL
      : engine === 'gemini'
        ? GEMINI_BASE_URL
        : normalizeBaseURL(fields.baseURL);
  const settings: ProviderSettings = { baseURL, model: fields.model };
  const rule = thinkingRule(engine, fields.model, baseURL);
  // Invalid text (only from hand-edited storage) is ignored: it never reaches the request.
  const extra = hasEditableBaseURL(engine) ? parseExtraBody(fields.extraBody) : undefined;
  const body: Record<string, unknown> = {};
  const cacheParams: Record<string, unknown> = {};
  if (rule) {
    if (fields.thinking) cacheParams.thinking = true;
    else Object.assign(body, rule.body);
  }
  if (extra) {
    Object.assign(body, extra);
    cacheParams.extraBody = extra;
  }
  if (Object.keys(body).length > 0) settings.extraBody = body;
  if (Object.keys(cacheParams).length > 0) settings.cacheParams = cacheParams;
  return settings;
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
