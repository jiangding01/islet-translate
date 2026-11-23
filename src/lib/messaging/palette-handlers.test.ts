import { describe, expect, it, vi } from 'vitest';
import { createPaletteHandlers } from './palette-handlers';

const TOP = { tab: { id: 7 }, frameId: 0 };

function setup(commands: { name?: string; shortcut?: string }[] = []) {
  const deps = {
    openOptionsPage: vi.fn(async () => {}),
    getAllCommands: vi.fn(async () => commands),
  };
  return { deps, handlers: createPaletteHandlers(deps) };
}

const REJECTED = { ok: false, error: { code: 'validation/invalid-payload' } };

describe('palette handlers: sender check', () => {
  it.each([
    ['no sender', undefined],
    ['a sender without a tab (an extension page)', { frameId: 0 }],
    ['a tab without an id', { tab: {}, frameId: 0 }],
    ['a sub-frame', { tab: { id: 7 }, frameId: 3 }],
    ['no frame id', { tab: { id: 7 } }],
  ])('rejects %s', async (_label, sender) => {
    const { deps, handlers } = setup();
    expect(await handlers['options.open'](sender)).toMatchObject(REJECTED);
    expect(await handlers['shortcuts.get'](sender)).toMatchObject(REJECTED);
    expect(deps.openOptionsPage).not.toHaveBeenCalled();
    expect(deps.getAllCommands).not.toHaveBeenCalled();
  });
});

describe('options.open', () => {
  it('opens the options page and answers null', async () => {
    const { deps, handlers } = setup();
    expect(await handlers['options.open'](TOP)).toEqual({ ok: true, data: null });
    expect(deps.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('answers with the error when the page cannot be opened', async () => {
    const { deps, handlers } = setup();
    deps.openOptionsPage.mockRejectedValue(new Error('no'));
    expect(await handlers['options.open'](TOP)).toMatchObject({ ok: false });
  });
});

describe('shortcuts.get', () => {
  it('returns the three shortcuts the palette shows, and nothing else', async () => {
    const { handlers } = setup([
      { name: '_execute_action', shortcut: 'Ctrl+Shift+Y' },
      { name: 'translate-page', shortcut: 'Alt+A' },
      { name: 'translate-selection', shortcut: 'Alt+Shift+S' },
      { name: 'open-palette', shortcut: 'Alt+Shift+K' },
      { name: 'other', shortcut: 'Alt+Z' },
    ]);
    expect(await handlers['shortcuts.get'](TOP)).toEqual({
      ok: true,
      data: {
        'translate-page': 'Alt+A',
        'translate-selection': 'Alt+Shift+S',
        'open-palette': 'Alt+Shift+K',
      },
    });
  });

  it('fills missing and unassigned commands with an empty string', async () => {
    const { handlers } = setup([
      { name: 'translate-page', shortcut: '' },
      { name: 'open-palette' },
    ]);
    expect(await handlers['shortcuts.get'](TOP)).toEqual({
      ok: true,
      data: { 'translate-page': '', 'translate-selection': '', 'open-palette': '' },
    });
  });
});
