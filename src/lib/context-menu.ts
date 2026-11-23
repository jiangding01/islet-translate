import { i18n } from '#i18n';

// Context menu and shortcut handling for the background. The browser API is injected so
// the logic is testable; `background.ts` registers the listeners at top level, so a menu
// click or shortcut that wakes the service worker is still handled.

export const MENU_SELECTION_ID = 'translate-selection';
export const MENU_PAGE_ID = 'translate-page';
const COMMAND_SELECTION = 'translate-selection';
const COMMAND_PAGE = 'translate-page';
const COMMAND_PALETTE = 'open-palette';

/** Web pages only: the content script runs nowhere else, so a menu item would do nothing. */
export const MENU_URL_PATTERNS = ['http://*/*', 'https://*/*'];

export interface MenuItem {
  id: string;
  title: string;
  contexts: ['selection' | 'page', ...('selection' | 'page')[]];
  documentUrlPatterns: string[];
}

export interface MenuApi {
  removeAll(): Promise<void>;
  /** Resolves once the browser has created the item. */
  create(item: MenuItem): Promise<void>;
}

/**
 * Removes every item, then creates ours one after another. Item creation is
 * asynchronous in the browser: unordered calls can interleave with `removeAll` and
 * collide on an id, and a failure must not leave a half-built menu unreported.
 */
export async function rebuildContextMenus(api: MenuApi): Promise<void> {
  await api.removeAll();
  await api.create({
    id: MENU_SELECTION_ID,
    // Same wording as the shortcut's description in the manifest.
    title: i18n.t('manifest.commands.translateSelection'),
    contexts: ['selection'],
    documentUrlPatterns: MENU_URL_PATTERNS,
  });
  await api.create({
    id: MENU_PAGE_ID,
    title: i18n.t('manifest.commands.translatePage'),
    contexts: ['page'],
    documentUrlPatterns: MENU_URL_PATTERNS,
  });
}

export interface MenuClick {
  menuItemId: string | number;
  selectionText?: string;
  /** The frame the menu was opened in; 0 is the top frame. */
  frameId?: number;
}

export interface TabLike {
  id?: number;
}

export interface Target {
  tabId: number;
  frameId?: number;
}

export interface MenuDeps {
  /** Sends a message to a tab's content script; rejects when nothing listens. */
  send(
    type: 'selection.open' | 'page.toggle' | 'palette.toggle',
    data: { selectionText?: string; frameId?: number } | undefined,
    target: Target,
  ): Promise<unknown>;
  /** The active tab of the current window, for a shortcut that arrives without a tab. */
  activeTabId(): Promise<number | undefined>;
}

export interface MenuHandlers {
  onClicked(info: MenuClick, tab: TabLike | undefined): void;
  onCommand(command: string, tab: TabLike | undefined): void;
}

export function createMenuHandlers(deps: MenuDeps): MenuHandlers {
  // No content script on the tab (browser pages, the store, a tab opened before the
  // install) is normal, not an error: failures stay silent.
  const quiet = (sent: Promise<unknown>) => {
    sent.catch(() => {});
  };
  return {
    onClicked(info, tab) {
      const tabId = tab?.id;
      if (tabId === undefined) return;
      if (info.menuItemId === MENU_SELECTION_ID) {
        // The content script runs in the top frame only; `frameId` tells it where the
        // selection actually is.
        quiet(
          deps.send(
            'selection.open',
            { selectionText: info.selectionText, frameId: info.frameId },
            { tabId, frameId: 0 },
          ),
        );
      } else if (info.menuItemId === MENU_PAGE_ID) {
        quiet(deps.send('page.toggle', undefined, { tabId, frameId: 0 }));
      }
    },
    onCommand(command, tab) {
      let type: 'selection.open' | 'page.toggle' | 'palette.toggle';
      let data: { selectionText?: string } | undefined;
      if (command === COMMAND_PAGE) {
        type = 'page.toggle';
      } else if (command === COMMAND_PALETTE) {
        // Opens the palette, or closes it when it is open (the content script decides).
        type = 'palette.toggle';
      } else if (command === COMMAND_SELECTION) {
        // No `selectionText`: the content script reads its own selection.
        type = 'selection.open';
        data = {};
      } else {
        return;
      }
      const resolved = tab?.id !== undefined ? Promise.resolve(tab.id) : deps.activeTabId();
      quiet(
        resolved.then((tabId) =>
          tabId === undefined ? undefined : deps.send(type, data, { tabId, frameId: 0 }),
        ),
      );
    },
  };
}
