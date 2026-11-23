import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createGetMessage, loadLocales } from '../../scripts/i18n-messages.mjs';
import {
  createMenuHandlers,
  MENU_PAGE_ID,
  MENU_SELECTION_ID,
  type MenuApi,
  type MenuDeps,
  rebuildContextMenus,
} from './context-menu';

const URL_PATTERNS = ['http://*/*', 'https://*/*'];

function fakeApi(options: { failCreateAt?: number } = {}) {
  const events: string[] = [];
  const created: unknown[] = [];
  let open = 0;
  let overlapped = false;
  const step = async (name: string, run?: () => void) => {
    open += 1;
    if (open > 1) overlapped = true;
    events.push(`${name}:start`);
    // Yield so that an unserialized caller would overlap here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    run?.();
    events.push(`${name}:end`);
    open -= 1;
  };
  const api: MenuApi = {
    removeAll: () => step('removeAll'),
    create: async (item) => {
      await step(`create:${item.id}`, () => {
        if (options.failCreateAt === created.length) throw new Error('create failed');
        created.push(item);
      });
    },
  };
  return { api, events, created, overlapped: () => overlapped };
}

describe('rebuildContextMenus', () => {
  it('removes everything, then creates the two items one after another', async () => {
    const fake = fakeApi();
    await rebuildContextMenus(fake.api);
    expect(fake.events).toEqual([
      'removeAll:start',
      'removeAll:end',
      'create:translate-selection:start',
      'create:translate-selection:end',
      'create:translate-page:start',
      'create:translate-page:end',
    ]);
    expect(fake.overlapped()).toBe(false);
  });

  it('creates the selection item and the page item with their titles and contexts', async () => {
    const fake = fakeApi();
    await rebuildContextMenus(fake.api);
    expect(fake.created).toEqual([
      {
        id: 'translate-selection',
        title: '翻译选中文字',
        contexts: ['selection'],
        documentUrlPatterns: URL_PATTERNS,
      },
      {
        id: 'translate-page',
        title: '翻译此页 / 显示原文',
        contexts: ['page'],
        documentUrlPatterns: URL_PATTERNS,
      },
    ]);
  });

  it('stops at the first failure and reports it', async () => {
    const fake = fakeApi({ failCreateAt: 0 });
    await expect(rebuildContextMenus(fake.api)).rejects.toThrow('create failed');
    expect(fake.created).toEqual([]);
    expect(fake.events).not.toContain('create:translate-page:start');
  });
});

function setup(options: { send?: MenuDeps['send']; activeTabId?: number | undefined } = {}) {
  const send = vi.fn<MenuDeps['send']>(options.send ?? (async () => null));
  const activeTabId = vi.fn(async () => options.activeTabId);
  const handlers = createMenuHandlers({ send, activeTabId });
  return { handlers, send, activeTabId };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('menu clicks', () => {
  it('the selection item sends selection.open with the text and menu frame to frame 0', () => {
    const { handlers, send } = setup();
    handlers.onClicked(
      { menuItemId: MENU_SELECTION_ID, selectionText: 'Hello', frameId: 4 },
      { id: 9 },
    );
    expect(send).toHaveBeenCalledWith(
      'selection.open',
      { selectionText: 'Hello', frameId: 4 },
      { tabId: 9, frameId: 0 },
    );
  });

  it('the page item sends page.toggle to frame 0', () => {
    const { handlers, send } = setup();
    handlers.onClicked({ menuItemId: MENU_PAGE_ID }, { id: 9 });
    expect(send).toHaveBeenCalledWith('page.toggle', undefined, { tabId: 9, frameId: 0 });
  });

  it('ignores other items and clicks without a tab', () => {
    const { handlers, send } = setup();
    handlers.onClicked({ menuItemId: 'other' }, { id: 9 });
    handlers.onClicked({ menuItemId: MENU_PAGE_ID }, undefined);
    handlers.onClicked({ menuItemId: MENU_PAGE_ID }, {});
    expect(send).not.toHaveBeenCalled();
  });

  it('stays silent when the tab has no content script', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { handlers } = setup({ send: () => Promise.reject(new Error('no receiver')) });
    handlers.onClicked({ menuItemId: MENU_SELECTION_ID, selectionText: 'x' }, { id: 1 });
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('commands', () => {
  it('translate-selection sends selection.open without selectionText', async () => {
    const { handlers, send } = setup();
    handlers.onCommand('translate-selection', { id: 5 });
    await flush();
    expect(send).toHaveBeenCalledWith('selection.open', {}, { tabId: 5, frameId: 0 });
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('selectionText');
  });

  it('translate-page sends page.toggle', async () => {
    const { handlers, send } = setup();
    handlers.onCommand('translate-page', { id: 5 });
    await flush();
    expect(send).toHaveBeenCalledWith('page.toggle', undefined, { tabId: 5, frameId: 0 });
  });

  it('open-palette sends palette.toggle to the top frame', async () => {
    const { handlers, send } = setup();
    handlers.onCommand('open-palette', { id: 5 });
    await flush();
    expect(send).toHaveBeenCalledWith('palette.toggle', undefined, { tabId: 5, frameId: 0 });
  });

  it('uses the active tab when the command has none, and does nothing without one', async () => {
    const withTab = setup({ activeTabId: 8 });
    withTab.handlers.onCommand('translate-selection', undefined);
    await flush();
    expect(withTab.send).toHaveBeenCalledWith('selection.open', {}, { tabId: 8, frameId: 0 });

    const without = setup({ activeTabId: undefined });
    without.handlers.onCommand('translate-selection', undefined);
    await flush();
    expect(without.send).not.toHaveBeenCalled();
  });

  it('ignores unknown commands and stays silent on failures', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { handlers, send } = setup({ send: () => Promise.reject(new Error('gone')) });
    handlers.onCommand('other', { id: 1 });
    expect(send).not.toHaveBeenCalled();
    handlers.onCommand('translate-selection', { id: 1 });
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

/** Switches the getMessage stub to the en copy (vitest.setup puts zh_CN back before each test). */
async function useEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

describe('context menu copy', () => {
  it('uses the shortcut descriptions of the current UI language', async () => {
    await useEnglish();
    const { api, created } = fakeApi();
    await rebuildContextMenus(api);
    expect(created).toMatchObject([
      { title: 'Translate selected text' },
      { title: 'Translate this page / Show original' },
    ]);
  });
});
