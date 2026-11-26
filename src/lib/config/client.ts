import { browser } from 'wxt/browser';
import type { Result } from '@/lib/errors';
import { browserUiLanguage, isLanguageCode } from '@/lib/languages';
import { call } from '@/lib/messaging/handle';
import { sendMessage } from '@/lib/messaging/protocol';
import { createDefaultSnapshot } from './defaults';
import { isPlainObject, mergeDefaults } from './merge';
import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_STORAGE_KEY,
  type ConfigChange,
  type ConfigPath,
  type ConfigSnapshot,
  type ConfigV1,
  CUSTOM_PROVIDER_ID_PATTERN,
  type CustomProvider,
  HOLD_KEYS,
  ISLE_DOCKS,
  isBuiltinEngine,
  isCustomProviderId,
  PAGE_MODES,
  PAGE_STYLES,
  THEMES,
} from './types';

// Config access for extension pages and content scripts. Deliberately zod-free:
// the background is the only writer and validates everything it stores, so
// this layer only guards against version skew. It reads through the native
// storage API (not `wxt/utils/storage`) to keep the content script small.

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return (values as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

function isCustomProvider(value: unknown): value is CustomProvider {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.baseURL === 'string' &&
    typeof value.model === 'string'
  );
}

/** Keeps well-formed entries in stored order. */
function normalizeCustomProviders(raw: unknown): Record<string, CustomProvider> {
  const providers: Record<string, CustomProvider> = {};
  if (!isPlainObject(raw)) return providers;
  for (const [id, value] of Object.entries(raw)) {
    if (CUSTOM_PROVIDER_ID_PATTERN.test(id) && isCustomProvider(value)) providers[id] = value;
  }
  return providers;
}

/** Structural merge with defaults plus enum guards. Pure; exported for tests. */
export function normalizeConfig(raw: unknown, uiLanguage: string): ConfigSnapshot {
  const defaults = createDefaultSnapshot(uiLanguage);
  if (!isPlainObject(raw) || raw.schemaVersion !== CONFIG_SCHEMA_VERSION) return defaults;

  // `providers` and `customStyles` are kept as merged (defaults filled), unchecked: the
  // background validates them.
  const merged = mergeDefaults(defaults.data, raw.data) as Record<string, unknown> &
    Pick<ConfigV1, 'providers' | 'customStyles'>;
  if (!isPlainObject(merged)) return defaults;
  const ui = isPlainObject(merged.ui) ? merged.ui : {};
  const language = isPlainObject(merged.language) ? merged.language : {};
  const translation = isPlainObject(merged.translation) ? merged.translation : {};
  const page = isPlainObject(merged.page) ? merged.page : {};
  const selection = isPlainObject(merged.selection) ? merged.selection : {};
  const customProviders = normalizeCustomProviders(merged.customProviders);
  const engine = translation.engine;
  const engineOk =
    isBuiltinEngine(engine) ||
    (isCustomProviderId(engine) && Object.hasOwn(customProviders, engine));
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    data: {
      ...merged,
      ui: { ...ui, theme: oneOf(THEMES, ui.theme) ?? defaults.data.ui.theme },
      language: {
        ...language,
        target: isLanguageCode(language.target) ? language.target : defaults.data.language.target,
        source:
          language.source === 'auto' || isLanguageCode(language.source)
            ? language.source
            : defaults.data.language.source,
      },
      customProviders,
      page: {
        ...page,
        style: oneOf(PAGE_STYLES, page.style) ?? defaults.data.page.style,
        mode: oneOf(PAGE_MODES, page.mode) ?? defaults.data.page.mode,
        isleDock: oneOf(ISLE_DOCKS, page.isleDock) ?? defaults.data.page.isleDock,
        holdKey: oneOf(HOLD_KEYS, page.holdKey) ?? defaults.data.page.holdKey,
      },
      selection: {
        ...selection,
        showDot:
          typeof selection.showDot === 'boolean'
            ? selection.showDot
            : defaults.data.selection.showDot,
      },
      // `style` passes through as merged too: only AI requests in the background read it,
      // and the settings page skips malformed custom styles.
      translation: {
        ...translation,
        engine: engineOk ? engine : defaults.data.translation.engine,
      } as ConfigV1['translation'],
    },
  };
}

export async function readConfig(): Promise<ConfigSnapshot> {
  const stored = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  return normalizeConfig(stored[CONFIG_STORAGE_KEY], browserUiLanguage());
}

/** Calls `callback` whenever the stored config changes; returns the unsubscribe function. */
export function watchConfig(callback: (snapshot: ConfigSnapshot) => void): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown } | undefined>,
    area: string,
  ): void => {
    if (area !== 'local' || !Object.hasOwn(changes, CONFIG_STORAGE_KEY)) return;
    callback(normalizeConfig(changes[CONFIG_STORAGE_KEY]?.newValue, browserUiLanguage()));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export function patchConfig(changes: ConfigChange[]): Promise<Result<ConfigSnapshot>> {
  return call(() => sendMessage('config.patch', changes));
}

export function resetConfig(paths?: ConfigPath[]): Promise<Result<ConfigSnapshot>> {
  return call(() => sendMessage('config.reset', paths));
}
