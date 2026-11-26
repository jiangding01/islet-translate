import { appError, isAppError } from '@/lib/errors';
import { createDefaultConfig } from './defaults';
import { isExtraBodyValid } from './extra-body';
import { isPlainObject } from './merge';
import { parseStoredConfig } from './parse';
import { CONFIG_PATHS, getPath, isConfigPath, setPath } from './paths';
import { configSchema } from './schema';
import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_STORAGE_KEY,
  type ConfigChange,
  type ConfigPath,
  type ConfigSnapshot,
  type ConfigV1,
  type CustomProviderChange,
  type CustomStyleChange,
  isCustomProviderId,
  isCustomStyleId,
  MAX_CUSTOM_PROVIDERS,
  MAX_CUSTOM_STYLES,
} from './types';

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ConfigRepositoryDeps {
  store: KeyValueStore;
  uiLanguage: string;
}

export interface ConfigRepository {
  /** Reads and leniently parses; writes the repaired value back once if needed. */
  load(): Promise<ConfigSnapshot>;
  /**
   * Like `load`, but undefined when the config was written by a newer build: the
   * read-only defaults then do not reflect storage. Housekeeping that deletes data
   * (secret pruning) must use this, never `load`.
   */
  loadStored(): Promise<ConfigSnapshot | undefined>;
  patch(changes: readonly ConfigChange[]): Promise<ConfigSnapshot>;
  /** Resets the given paths, or every known path, to defaults. Unknown keys survive. */
  reset(paths?: readonly ConfigPath[]): Promise<ConfigSnapshot>;
}

/**
 * The single writer of `storage.local["config"]` (background only). Every
 * operation that may write runs on one promise chain, so a load repair and a
 * patch that arrive together (SW woken by the patch) cannot overwrite each
 * other. Broadcasting is left entirely to `storage.onChanged`.
 * Failures reject with an AppError and leave the store untouched.
 */
export function createConfigRepository(deps: ConfigRepositoryDeps): ConfigRepository {
  const { store, uiLanguage } = deps;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read() {
    let raw: unknown;
    try {
      raw = await store.get(CONFIG_STORAGE_KEY);
    } catch (error) {
      throw appError('config', 'config/read-failed', describe(error), { retryable: true });
    }
    return parseStoredConfig(raw, { uiLanguage, schema: configSchema });
  }

  async function write(data: unknown): Promise<ConfigSnapshot> {
    const parsed = configSchema.safeParse(data);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
      throw appError('config', 'config/invalid-value', `Invalid config at: ${paths.join(', ')}`);
    }
    const snapshot: ConfigSnapshot = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      data: parsed.data as ConfigV1,
    };
    try {
      await store.set(CONFIG_STORAGE_KEY, snapshot);
    } catch (error) {
      throw appError('config', 'config/write-failed', describe(error), { retryable: true });
    }
    return snapshot;
  }

  async function readWritable() {
    const current = await read();
    if (current.readOnly) {
      throw appError(
        'config',
        'config/newer-version',
        'Config was written by a newer version; refusing to overwrite it',
      );
    }
    return current.snapshot.data;
  }

  const loadParsed = () =>
    enqueue(async () => {
      const current = await read();
      if (current.repaired && !current.readOnly) {
        try {
          await store.set(CONFIG_STORAGE_KEY, current.snapshot);
        } catch {
          // The repaired snapshot is still valid in memory; the next write persists it.
          console.warn('[config] failed to write back the repaired config');
        }
      }
      return current;
    });

  return {
    load: async () => (await loadParsed()).snapshot,

    loadStored: async () => {
      const current = await loadParsed();
      return current.readOnly ? undefined : current.snapshot;
    },

    patch: (changes) =>
      enqueue(async () => {
        let data: unknown = await readWritable();
        let engineSet = false;
        let styleSet = false;
        for (const change of changes) {
          if (isCustomProviderChange(change)) {
            data = applyCustomProviderChange(data, change);
            continue;
          }
          if (isCustomStyleChange(change)) {
            data = applyCustomStyleChange(data, change);
            continue;
          }
          // The records themselves are never replaced wholesale through a patch.
          if (
            !isConfigPath(change.path) ||
            (change.path as string) === 'customProviders' ||
            (change.path as string) === 'customStyles'
          ) {
            throw appError('config', 'config/unknown-path', `Unknown config path: ${change.path}`);
          }
          if (change.path === 'translation.engine') engineSet = true;
          if (change.path === 'translation.style') styleSet = true;
          if (change.path === 'providers.openai.extraBody') checkExtraBody(change.value);
          data = setPath(data, change.path, change.value);
        }
        data = fallBackFromMissingEngine(data, { explicit: engineSet });
        return write(fallBackFromMissingStyle(data, { explicit: styleSet }));
      }),

    reset: (paths) =>
      enqueue(async () => {
        let data: unknown = await readWritable();
        const defaults = createDefaultConfig(uiLanguage);
        for (const path of paths ?? (CONFIG_PATHS as readonly ConfigPath[])) {
          if (!isConfigPath(path)) {
            throw appError('config', 'config/unknown-path', `Unknown config path: ${path}`);
          }
          data = setPath(data, path, structuredClone(getPath(defaults, path)));
        }
        data = fallBackFromMissingEngine(data, { explicit: false });
        return write(fallBackFromMissingStyle(data, { explicit: false }));
      }),
  };
}

function isCustomProviderChange(change: ConfigChange): change is CustomProviderChange {
  return change.path === 'customProviders' && 'key' in change;
}

// Every field an update may change: one left out is silently dropped.
const CUSTOM_FIELDS = ['name', 'baseURL', 'model', 'extraBody'] as const;

/**
 * Extra body text must be blank or a JSON object. Checked where it is written (the schema
 * only caps the length), so a hand-edited stored value never blocks unrelated writes.
 */
function checkExtraBody(value: unknown): void {
  if (typeof value === 'string' && !isExtraBodyValid(value)) {
    throw appError('config', 'config/invalid-extra-body', 'Extra body is not a JSON object');
  }
}

function applyCustomProviderChange(data: unknown, change: CustomProviderChange): unknown {
  if (!isCustomProviderId(change.key)) {
    throw appError('config', 'config/invalid-value', 'Invalid custom provider id');
  }
  const current = getPath(data, 'customProviders');
  const providers: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  const exists = Object.hasOwn(providers, change.key);

  if ('remove' in change) {
    delete providers[change.key];
  } else if ('add' in change) {
    if (exists) throw appError('config', 'config/invalid-value', 'Custom provider id is taken');
    if (Object.keys(providers).length >= MAX_CUSTOM_PROVIDERS) {
      throw appError(
        'config',
        'config/provider-limit',
        `At most ${MAX_CUSTOM_PROVIDERS} custom providers`,
      );
    }
    checkExtraBody(isPlainObject(change.add) ? change.add.extraBody : undefined);
    providers[change.key] = structuredClone(change.add);
  } else {
    // Updating a provider another page just removed must not bring it back.
    const existing = providers[change.key];
    if (!exists || !isPlainObject(existing)) {
      throw appError('config', 'config/provider-missing', 'Custom provider not found');
    }
    const fields: Record<string, unknown> = {};
    for (const field of CUSTOM_FIELDS) {
      if (field in change.update) fields[field] = change.update[field];
    }
    checkExtraBody(fields.extraBody);
    // Merge field by field, so quick successive edits of one provider all survive.
    providers[change.key] = { ...existing, ...fields };
  }
  return setPath(data, 'customProviders', providers);
}

function isCustomStyleChange(change: ConfigChange): change is CustomStyleChange {
  return change.path === 'customStyles' && 'key' in change;
}

// The only fields a custom style keeps: anything else in a change is dropped.
const STYLE_FIELDS = ['name', 'description'] as const;

/**
 * The given fields of a custom style, trimmed. A blank (or non-text) field is refused; the
 * schema caps the length, so an overlong one is refused too, never cut.
 */
function styleFields(source: unknown, options: { all: boolean }): Record<string, string> {
  const given = isPlainObject(source) ? source : {};
  const fields: Record<string, string> = {};
  for (const field of STYLE_FIELDS) {
    if (!options.all && !Object.hasOwn(given, field)) continue;
    const value = given[field];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') {
      throw appError('config', 'config/invalid-value', `Custom style ${field} is empty`);
    }
    fields[field] = text;
  }
  return fields;
}

/**
 * Written on its own rather than shared with applyCustomProviderChange, so the custom
 * provider codes and messages stay exactly as they are.
 */
function applyCustomStyleChange(data: unknown, change: CustomStyleChange): unknown {
  if (!isCustomStyleId(change.key)) {
    throw appError('config', 'config/invalid-value', 'Invalid custom style id');
  }
  const current = getPath(data, 'customStyles');
  const records: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  const exists = Object.hasOwn(records, change.key);

  if ('remove' in change) {
    delete records[change.key];
  } else if ('add' in change) {
    if (exists) throw appError('config', 'config/invalid-value', 'Custom style id is taken');
    if (Object.keys(records).length >= MAX_CUSTOM_STYLES) {
      throw appError('config', 'config/style-limit', `At most ${MAX_CUSTOM_STYLES} custom styles`);
    }
    records[change.key] = styleFields(change.add, { all: true });
  } else {
    // Updating a style another page just removed must not bring it back.
    const existing = records[change.key];
    if (!exists || !isPlainObject(existing)) {
      throw appError('config', 'config/style-missing', 'Custom style not found');
    }
    records[change.key] = { ...existing, ...styleFields(change.update, { all: false }) };
  }
  return setPath(data, 'customStyles', records);
}

/**
 * Like fallBackFromMissingEngine: a chosen style that went away (removed, reset) falls back
 * to `general` in the same write; choosing a missing style is an error.
 */
function fallBackFromMissingStyle(data: unknown, options: { explicit: boolean }): unknown {
  const style = getPath(data, 'translation.style');
  const records = getPath(data, 'customStyles');
  if (!isCustomStyleId(style)) return data;
  if (isPlainObject(records) && Object.hasOwn(records, style)) return data;
  if (options.explicit) {
    throw appError('config', 'config/style-missing', 'Custom style not found');
  }
  return setPath(data, 'translation.style', 'general');
}

/**
 * The default engine must exist. When its provider went away (removed, reset)
 * the default falls back to Google in the same write; choosing a provider that
 * does not exist is an error instead, so the page never reports a false success.
 */
function fallBackFromMissingEngine(data: unknown, options: { explicit: boolean }): unknown {
  const engine = getPath(data, 'translation.engine');
  const providers = getPath(data, 'customProviders');
  if (!isCustomProviderId(engine)) return data;
  if (isPlainObject(providers) && Object.hasOwn(providers, engine)) return data;
  if (options.explicit) {
    throw appError('config', 'config/provider-missing', 'Custom provider not found');
  }
  return setPath(data, 'translation.engine', 'google');
}

function describe(error: unknown): string {
  if (isAppError(error) || error instanceof Error) return error.message;
  return 'Unknown storage error';
}
