import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createGetMessage, loadLocales } from '../../scripts/i18n-messages.mjs';
import { describeError, withUserMessage } from './error-messages';
import { appError } from './errors';

describe('withUserMessage', () => {
  it('fills userMessage for a code in the table', () => {
    const error = appError('provider', 'provider/unauthorized', 'HTTP 401');
    expect(withUserMessage(error)).toEqual({
      ...error,
      userMessage: describeError(error),
    });
    expect(withUserMessage(error).userMessage).toContain('密钥无效');
  });

  it('leaves an unknown code without userMessage (no generic fallback)', () => {
    const error = appError('internal', 'internal/whatever', 'x');
    const decorated = withUserMessage(error);
    expect(decorated).toEqual(error);
    expect(decorated).not.toHaveProperty('userMessage');
  });

  it('does not mutate the original error', () => {
    const error = appError('network', 'network/timeout', 'slow');
    withUserMessage(error);
    expect(error).not.toHaveProperty('userMessage');
  });
});

/** Switches the getMessage stub to the en copy (vitest.setup puts zh_CN back before each test). */
async function useEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

describe('UI language', () => {
  it('follows the copy Chrome picked, including the default fallback', async () => {
    await useEnglish();
    expect(describeError(appError('network', 'network/timeout', 'slow'))).toBe(
      'The translation service took too long to respond. Check your connection and try again.',
    );
    expect(describeError(appError('internal', 'internal/whatever', 'x'))).toBe(
      'Something went wrong. Try again.',
    );
  });
});

describe('extra request body error', () => {
  it('explains what the field needs, in zh and en', async () => {
    const error = appError('config', 'config/invalid-extra-body', 'Extra body is not an object');
    expect(describeError(error)).toBe('需要是一个 JSON 对象，例如 {"key": "value"}。');
    expect(withUserMessage(error).userMessage).toBe(describeError(error));
    await useEnglish();
    expect(describeError(error)).toBe('Needs to be a JSON object, for example {"key": "value"}.');
  });
});
