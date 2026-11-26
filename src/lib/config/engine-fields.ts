import {
  type ConfigChange,
  type ConfigV1,
  type Engine,
  isBuiltinEngine,
  isCustomProviderId,
} from './types';

// The one map from an engine to where its settings live. Pure and zod-free:
// used by the background registry, the settings page and the toolbar panel.

export interface EngineFields {
  /** Raw, unnormalized; '' for engines with a fixed endpoint. */
  baseURL: string;
  model: string;
  /** OpenAI, DeepSeek and Gemini: the thinking switch; absent for other engines. */
  thinking?: boolean;
  /** OpenAI and custom providers: extra request body text as stored; absent for others. */
  extraBody?: string;
}

/** Configured fields of an engine; undefined for a custom provider that does not exist. */
export function engineFields(
  config: Pick<ConfigV1, 'providers' | 'customProviders'>,
  engine: Engine,
): EngineFields | undefined {
  switch (engine) {
    case 'google':
      return { baseURL: '', model: '' };
    case 'openai':
      return {
        baseURL: config.providers.openai.baseURL,
        model: config.providers.openai.model,
        thinking: config.providers.openai.thinking === true,
        extraBody: config.providers.openai.extraBody ?? '',
      };
    case 'deepseek':
      return {
        baseURL: '',
        model: config.providers.deepseek.model,
        thinking: config.providers.deepseek.thinking === true,
      };
    case 'gemini':
      return {
        baseURL: '',
        model: config.providers.gemini.model,
        thinking: config.providers.gemini.thinking === true,
      };
    default: {
      const custom = Object.hasOwn(config.customProviders, engine)
        ? config.customProviders[engine]
        : undefined;
      return (
        custom && {
          baseURL: custom.baseURL,
          model: custom.model,
          extraBody: custom.extraBody ?? '',
        }
      );
    }
  }
}

/** OpenAI and custom providers let the user set the endpoint. */
export function hasEditableBaseURL(engine: Engine): boolean {
  return engine === 'openai' || !isBuiltinEngine(engine);
}

/** Every engine but Google takes an API key (optional for custom providers). */
export function takesApiKey(engine: Engine): engine is Exclude<Engine, 'google'> {
  return engine !== 'google';
}

/** The change that stores one field of an engine; undefined when the engine has no such field. */
export function fieldChange(
  engine: Engine,
  field: 'baseURL' | 'model' | 'extraBody',
  value: string,
): ConfigChange | undefined {
  if (isCustomProviderId(engine)) {
    return { path: 'customProviders', key: engine, update: { [field]: value } };
  }
  if (field === 'baseURL') {
    return engine === 'openai' ? { path: 'providers.openai.baseURL', value } : undefined;
  }
  if (field === 'extraBody') {
    return engine === 'openai' ? { path: 'providers.openai.extraBody', value } : undefined;
  }
  switch (engine) {
    case 'openai':
      return { path: 'providers.openai.model', value };
    case 'deepseek':
      return { path: 'providers.deepseek.model', value };
    case 'gemini':
      return { path: 'providers.gemini.model', value };
    default:
      return undefined;
  }
}
