import { isExtraBodyValid } from '@/lib/config/extra-body';
import { type ConfigV1, CUSTOM_PROVIDER_LIMITS, type Engine, isEngineId } from '@/lib/config/types';
import { type AppError, appError, type Result } from '@/lib/errors';
import { handle } from '@/lib/messaging/handle';
import type {
  CacheStatsInfo,
  ProviderTestDraft,
  ProviderTestResult,
  SecretProviderId,
  SecretStatusInfo,
} from '@/lib/messaging/protocol';
import { forbiddenSenderError } from '@/lib/messaging/sender';
import type { TranslationCache } from './cache';
import { checkEngineEndpoint } from './permissions';
import { buildPrompt } from './prompt';
import { getAdapter as registryAdapter, settingsFor } from './providers/registry';
import type { Scheduler } from './scheduler';
import { cleanApiKey, isSecretProvider, type SecretStore } from './secrets';
import type { ProviderAdapter } from './types';

// Background-only handlers for the settings page. Plain functions over injected
// dependencies, so tests need neither a browser nor real messaging.

export const TEST_SAMPLE = 'Hello, world.';
/** One sentence never needs longer; bounds how long a test can hold a scheduler slot. */
export const TEST_DEADLINE_MS = 30_000;

export interface AdminSender {
  url?: string;
}

export interface AdminDeps {
  getConfig(): Promise<ConfigV1>;
  secrets: Pick<SecretStore, 'get' | 'set' | 'status'>;
  cache: Pick<TranslationCache, 'stats' | 'clear'>;
  scheduler: Pick<Scheduler, 'submit'>;
  /** `browser.runtime.getURL('/options.html')`. */
  optionsUrl: string;
  /** `browser.runtime.getURL('/popup.html')`: may read `secrets.status` (never keys). */
  popupUrl?: string;
  getAdapter?: (engine: ProviderTestDraft['engine']) => ProviderAdapter;
  checkPermission?: (engine: Engine, baseURL: string) => Promise<Result<unknown>>;
  now?: () => number;
  randomId?: () => string;
}

function invalidPayload(): AppError {
  return appError('validation', 'validation/invalid-payload', 'Malformed request');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Accepts only the given extension page (`options.html` etc., with query or hash). */
export function isOptionsSender(sender: AdminSender | undefined, optionsUrl: string): boolean {
  const url = sender?.url;
  if (typeof url !== 'string') return false;
  if (!url.startsWith(optionsUrl)) return false;
  const next = url.charAt(optionsUrl.length);
  return next === '' || next === '?' || next === '#';
}

function parseDraft(raw: unknown): ProviderTestDraft {
  if (!isRecord(raw)) throw invalidPayload();
  const { engine, baseURL, model, apiKey, thinking, extraBody } = raw;
  if (
    !isEngineId(engine) ||
    typeof baseURL !== 'string' ||
    baseURL.length > CUSTOM_PROVIDER_LIMITS.baseURL ||
    typeof model !== 'string' ||
    model.length > CUSTOM_PROVIDER_LIMITS.model ||
    (apiKey !== undefined && typeof apiKey !== 'string') ||
    (thinking !== undefined && typeof thinking !== 'boolean') ||
    (extraBody !== undefined &&
      (typeof extraBody !== 'string' || extraBody.length > CUSTOM_PROVIDER_LIMITS.extraBody))
  ) {
    throw invalidPayload();
  }
  return { engine, baseURL, model, apiKey, thinking, extraBody };
}

export function createAdminHandlers(deps: AdminDeps) {
  const getAdapter = deps.getAdapter ?? registryAdapter;
  const checkPermission = deps.checkPermission ?? checkEngineEndpoint;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());

  const guard = (sender: AdminSender | undefined) => {
    if (!isOptionsSender(sender, deps.optionsUrl)) throw forbiddenSenderError();
  };
  // The toolbar panel shows "key missing" hints; status carries no key material.
  const statusGuard = (sender: AdminSender | undefined) => {
    const fromPopup = deps.popupUrl !== undefined && isOptionsSender(sender, deps.popupUrl);
    if (!fromPopup) guard(sender);
  };

  async function testProvider(rawDraft: unknown): Promise<ProviderTestResult> {
    const draft = parseDraft(rawDraft);
    const { engine } = draft;
    const model = draft.model.trim();
    if (engine !== 'google' && model === '') {
      throw appError('config', 'config/model-required', 'Model is required');
    }
    if (draft.extraBody !== undefined && !isExtraBodyValid(draft.extraBody)) {
      throw appError('config', 'config/invalid-extra-body', 'Extra body is not a JSON object');
    }
    // Only the draft's own fields are used: nothing is read from or written to the config.
    const settings = settingsFor(engine, {
      baseURL: draft.baseURL,
      model,
      thinking: draft.thinking,
      extraBody: draft.extraBody,
    });
    const permission = await checkPermission(engine, settings.baseURL);
    if (!permission.ok) throw permission.error;

    // The draft key lives in this stack frame only.
    const draftKey = draft.apiKey === undefined ? '' : cleanApiKey(draft.apiKey);
    const apiKey =
      engine === 'google'
        ? undefined
        : draftKey || (await deps.secrets.get(engine as SecretProviderId));
    const redact = (text: string) => (draftKey ? text.split(draftKey).join('***') : text);

    const config = await deps.getConfig();
    const adapter = getAdapter(engine);
    const prompt =
      adapter.kind === 'llm'
        ? buildPrompt({ source: 'auto', target: config.language.target })
        : undefined;
    const startedAt = now();
    const [outcome] = deps.scheduler.submit({
      caller: `provider-test-${randomId()}`,
      signal: new AbortController().signal,
      engine,
      // Own cooldown and probe scope: a rate-limited test never pauses real translations.
      cooldownKey: `test:${randomId()}`,
      adapter,
      context: { source: 'auto', target: config.language.target, settings, apiKey, prompt },
      segments: [{ key: `test:${randomId()}`, text: TEST_SAMPLE }],
      deadlineMs: TEST_DEADLINE_MS,
      // No persist: a connection test never touches the cache.
    });
    const result = outcome ? await outcome : undefined;
    if (!result) throw appError('internal', 'internal/unexpected', 'No test result');
    if (!result.ok) {
      const { error } = result;
      throw { ...error, message: redact(error.message) } satisfies AppError;
    }
    return { latencyMs: Math.max(0, now() - startedAt), text: redact(result.text) };
  }

  const wrap =
    <A extends unknown[], T>(fn: (...args: A) => T | Promise<T>) =>
    (sender: AdminSender | undefined, ...args: A): Promise<Result<T>> =>
      handle(async () => {
        guard(sender);
        return fn(...args);
      })();

  return {
    'secrets.set': wrap(
      (args: { provider: SecretProviderId; key: string | null }): Promise<SecretStatusInfo> => {
        if (!isRecord(args) || !isSecretProvider(args.provider)) throw invalidPayload();
        if (args.key !== null && typeof args.key !== 'string') throw invalidPayload();
        return deps.secrets.set(args.provider, args.key);
      },
    ),
    'secrets.status': (
      sender: AdminSender | undefined,
    ): Promise<Result<Partial<Record<SecretProviderId, SecretStatusInfo>>>> =>
      handle(async () => {
        statusGuard(sender);
        return deps.secrets.status();
      })(),
    'provider.test': wrap(testProvider),
    'cache.stats': wrap((): Promise<CacheStatsInfo> => deps.cache.stats()),
    'cache.clear': wrap(async () => {
      await deps.cache.clear();
      return null;
    }),
  };
}

export type AdminHandlers = ReturnType<typeof createAdminHandlers>;
