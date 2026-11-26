import { describe, expect, it, vi } from 'vitest';
import { createConfigHandlers, createGlossaryHandlers, isExtensionPageSender } from './sender';

const ROOT = 'chrome-extension://abc/';

describe('isExtensionPageSender', () => {
  it('accepts pages of this extension only', () => {
    expect(isExtensionPageSender({ url: `${ROOT}options.html#/general` }, ROOT)).toBe(true);
    expect(isExtensionPageSender({ url: `${ROOT}popup.html` }, ROOT)).toBe(true);
    expect(isExtensionPageSender({ url: 'https://evil.example.com/page' }, ROOT)).toBe(false);
    expect(isExtensionPageSender({ url: 'chrome-extension://other/options.html' }, ROOT)).toBe(
      false,
    );
    expect(isExtensionPageSender({}, ROOT)).toBe(false);
    expect(isExtensionPageSender(undefined, ROOT)).toBe(false);
  });
});

describe('config handlers', () => {
  function setup() {
    const repo = {
      patch: vi.fn(async () => ({ data: 'patched' })),
      reset: vi.fn(async () => ({ data: 'reset' })),
    };
    const handlers = createConfigHandlers({ repo: repo as never, extensionRoot: ROOT });
    return { repo, handlers };
  }

  it('rejects config.patch and config.reset from a content script', async () => {
    const { repo, handlers } = setup();
    const sender = { url: 'https://evil.example.com/page' };
    for (const result of [
      await handlers['config.patch'](sender, []),
      await handlers['config.reset'](sender, undefined),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'validation/forbidden-sender' } });
    }
    expect(repo.patch).not.toHaveBeenCalled();
    expect(repo.reset).not.toHaveBeenCalled();
  });

  it('runs config.patch and config.reset for extension pages', async () => {
    const { repo, handlers } = setup();
    const sender = { url: `${ROOT}popup.html` };
    expect(await handlers['config.patch'](sender, [])).toEqual({
      ok: true,
      data: { data: 'patched' },
    });
    expect(await handlers['config.reset'](sender, undefined)).toEqual({
      ok: true,
      data: { data: 'reset' },
    });
    expect(repo.patch).toHaveBeenCalledWith([]);
  });
});

describe('glossary handlers (M4-C)', () => {
  it('accepts glossary.change from extension pages only', async () => {
    const repo = { change: vi.fn(async () => []) };
    const handlers = createGlossaryHandlers({ repo, extensionRoot: ROOT });
    const change = { type: 'remove' as const, id: 'term-aaaaaaaa' };
    expect(
      await handlers['glossary.change']({ url: 'https://evil.example.com/' }, change),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation/forbidden-sender' },
    });
    expect(repo.change).not.toHaveBeenCalled();
    expect(await handlers['glossary.change']({ url: `${ROOT}options.html` }, change)).toEqual({
      ok: true,
      data: [],
    });
    expect(repo.change).toHaveBeenCalledWith(change);
  });
});
