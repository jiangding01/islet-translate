import { type GeneratedI18nStructure, i18n } from '#i18n';
import type { AppError } from '@/lib/errors';

// Stable error codes → UI copy keys (src/locales, `errors.*`). Extension pages (settings,
// popup) and the background import it; content scripts must not (scripts/check-build.mjs):
// they show the `userMessage` the background attaches (src/content/error-text.ts). The copy
// is looked up per call, never at module top level (docs/plans/i18n.md 4.2).

type ErrorKey = Extract<keyof GeneratedI18nStructure, `errors.${string}`>;

const MESSAGES: Record<string, ErrorKey> = {
  'config/newer-version': 'errors.config.newerVersion',
  'config/write-failed': 'errors.config.writeFailed',
  'config/read-failed': 'errors.config.readFailed',
  'network/extension-unreachable': 'errors.network.extensionUnreachable',
  'network/page-unreachable': 'errors.network.pageUnreachable',
  'validation/payload-too-large': 'errors.validation.payloadTooLarge',
  'validation/empty-translation': 'errors.validation.emptyTranslation',
  'validation/invalid-payload': 'errors.validation.invalidPayload',
  'validation/forbidden-sender': 'errors.validation.forbiddenSender',
  'validation/invalid-secret': 'errors.validation.invalidSecret',
  'config/invalid-base-url': 'errors.config.invalidBaseUrl',
  'config/model-required': 'errors.config.modelRequired',
  'config/permission-missing': 'errors.config.permissionMissing',
  'config/provider-limit': 'errors.config.providerLimit',
  'config/provider-missing': 'errors.config.providerMissing',
  'config/style-limit': 'errors.config.styleLimit',
  'config/style-missing': 'errors.config.styleMissing',
  'config/invalid-value': 'errors.config.invalidValue',
  'config/invalid-extra-body': 'errors.config.invalidExtraBody',
  'provider/unauthorized': 'errors.provider.unauthorized',
  'provider/local-origin-rejected': 'errors.provider.localOriginRejected',
  'provider/not-found': 'errors.provider.notFound',
  'provider/quota-exceeded': 'errors.provider.quotaExceeded',
  'provider/server-error': 'errors.provider.serverError',
  'provider/output-truncated': 'errors.provider.outputTruncated',
  'provider/content-blocked': 'errors.provider.contentBlocked',
  'rate-limit/too-many-requests': 'errors.rateLimit.tooManyRequests',
  'rate-limit/port-busy': 'errors.rateLimit.portBusy',
  'network/fetch-failed': 'errors.network.fetchFailed',
  'network/timeout': 'errors.network.timeout',
  'network/stream-interrupted': 'errors.network.streamInterrupted',
  'provider/bad-request': 'errors.provider.badRequest',
  'validation/bad-response': 'errors.validation.badResponse',
  'validation/unsupported-page': 'errors.validation.unsupportedPage',
};

function copyFor(code: string): string | undefined {
  const key = MESSAGES[code];
  return key === undefined ? undefined : i18n.t(key);
}

export function describeError(error: AppError, fallback = i18n.t('errors.generic')): string {
  return copyFor(error.code) ?? fallback;
}

/**
 * Attaches this table's copy as `userMessage` when the code is in it; unknown codes are
 * returned untouched (the content side picks its own fallback). Background only.
 */
export function withUserMessage(error: AppError): AppError {
  const userMessage = copyFor(error.code);
  return userMessage === undefined ? error : { ...error, userMessage };
}
