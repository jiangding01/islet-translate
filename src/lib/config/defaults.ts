import { defaultTargetLanguage } from '@/lib/languages';
import { CONFIG_SCHEMA_VERSION, type ConfigSnapshot, type ConfigV1 } from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function createDefaultConfig(uiLanguage: string): ConfigV1 {
  return {
    ui: { theme: 'system' },
    language: { target: defaultTargetLanguage(uiLanguage), source: 'auto' },
    translation: { engine: 'google', style: 'general' },
    page: { style: 'faded', mode: 'bilingual', isleDock: 'right', holdKey: 'ctrl' },
    selection: { showDot: true },
    providers: {
      openai: {
        baseURL: DEFAULT_OPENAI_BASE_URL,
        model: 'gpt-5-mini',
        thinking: false,
        extraBody: '',
      },
      deepseek: { model: 'deepseek-chat', thinking: false },
      gemini: { model: '', thinking: false },
    },
    customProviders: {},
    customStyles: {},
  };
}

export function createDefaultSnapshot(uiLanguage: string): ConfigSnapshot {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, data: createDefaultConfig(uiLanguage) };
}
