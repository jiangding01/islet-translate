import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createActionIcon, drawStatusIcon } from '@/lib/action-icon';
import { createLocalStore } from '@/lib/config/local-store';
import { createConfigRepository } from '@/lib/config/repository';
import { CONFIG_STORAGE_KEY, type ConfigSnapshot } from '@/lib/config/types';
import { createMenuHandlers, rebuildContextMenus } from '@/lib/context-menu';
import { withUserMessage } from '@/lib/error-messages';
import { appError, fail, toAppError } from '@/lib/errors';
import { handle } from '@/lib/messaging/handle';
import { createPaletteHandlers } from '@/lib/messaging/palette-handlers';
import {
  onMessage,
  type PageStatus,
  sendMessage,
  TRANSLATE_PORT_NAME,
} from '@/lib/messaging/protocol';
import {
  createConfigHandlers,
  forbiddenSenderError,
  isExtensionPageSender,
} from '@/lib/messaging/sender';
import { createPhoneticLookup } from '@/lib/phonetic/lookup';
import { createSiteMemoryStore } from '@/lib/site-memory';
import { createAdminHandlers } from '@/lib/translate/admin';
import { createTranslationCache } from '@/lib/translate/cache';
import { buildEngineOptions } from '@/lib/translate/engine-options';
import { createTranslatePortHost } from '@/lib/translate/port-host';
import { createSecretStore } from '@/lib/translate/secrets';
import { createTranslateService } from '@/lib/translate/service';

export default defineBackground(() => {
  const store = createLocalStore();
  const repo = createConfigRepository({ store, uiLanguage: browser.i18n.getUILanguage() });
  const secrets = createSecretStore(store);
  const cache = createTranslationCache();
  const service = createTranslateService({
    getConfig: async () => (await repo.load()).data,
    secrets,
    cache,
    lookupPhonetic: createPhoneticLookup(),
  });
  const config = createConfigHandlers({ repo, extensionRoot: browser.runtime.getURL('/') });
  const admin = createAdminHandlers({
    getConfig: async () => (await repo.load()).data,
    secrets,
    cache,
    scheduler: service.scheduler,
    optionsUrl: browser.runtime.getURL('/options.html'),
    popupUrl: browser.runtime.getURL('/popup.html'),
  });

  // Register synchronously at top level so a message that wakes the SW is handled.
  onMessage(
    'app.getStatus',
    handle(() => ({ version: browser.runtime.getManifest().version })),
  );
  // Config writes are accepted from extension pages only, never from content scripts.
  onMessage('config.patch', ({ data, sender }) => config['config.patch'](sender, data));
  onMessage('config.reset', ({ data, sender }) => config['config.reset'](sender, data));
  onMessage('secrets.set', ({ data, sender }) => admin['secrets.set'](sender, data));
  onMessage('secrets.status', ({ sender }) => admin['secrets.status'](sender));
  onMessage('provider.test', ({ data, sender }) => admin['provider.test'](sender, data));
  onMessage('cache.stats', ({ sender }) => admin['cache.stats'](sender));
  onMessage('cache.clear', ({ sender }) => admin['cache.clear'](sender));
  // Engine list for the page isle (content scripts cannot query permissions or key status).
  // Read directly from the stores, not through `secrets.status`, which stays extension-page only.
  onMessage(
    'engine.options',
    handle(async () =>
      buildEngineOptions({
        config: (await repo.load()).data,
        secrets: await secrets.status(),
        hasPermission: (pattern) => browser.permissions.contains({ origins: [pattern] }),
      }),
    ),
  );
  // Content scripts carry no copy table: errors leave the Port with `userMessage` attached.
  browser.runtime.onConnect.addListener(
    createTranslatePortHost(service, TRANSLATE_PORT_NAME, { decorateError: withUserMessage }),
  );

  // Site memory ("总是翻译此站"): written here only, on behalf of extension pages.
  const extensionRoot = browser.runtime.getURL('/');
  const siteMemory = createSiteMemoryStore(store);
  onMessage('site.setAlways', ({ data, sender }) => {
    if (!isExtensionPageSender(sender, extensionRoot)) {
      return Promise.resolve(fail(forbiddenSenderError()));
    }
    return handle(() => siteMemory.setAlways(data?.origin, data?.always))();
  });

  // Toolbar icon status dot, per tab, reported by the page's content script.
  const bases = new Map<number, Promise<ImageBitmap>>();
  const loadBase = (size: 16 | 32) => {
    let base = bases.get(size);
    if (!base) {
      // 16 and 32 are each drawn on their own pixel grid (scripts/build-icons.mjs).
      base = fetch(browser.runtime.getURL(`/icon/${size}.png`))
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob));
      bases.set(size, base);
      base.catch(() => bases.delete(size));
    }
    return base;
  };
  const icon = createActionIcon({
    draw: (status) => drawStatusIcon(status, loadBase),
    setIcon: (details) => browser.action.setIcon(details),
  });
  const PAGE_STATUSES: readonly PageStatus[] = ['idle', 'running', 'done', 'error'];
  onMessage(
    'page.status',
    handle(({ data, sender }) => {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0 || !PAGE_STATUSES.includes(data)) {
        throw appError('validation', 'validation/invalid-payload', 'Invalid page status');
      }
      void icon.show(tabId, data);
      return null;
    }),
  );
  // The palette's two narrow messages: top frame of a tab only, read or navigate only.
  const palette = createPaletteHandlers({
    openOptionsPage: () => browser.runtime.openOptionsPage(),
    getAllCommands: () => browser.commands.getAll(),
  });
  onMessage('options.open', ({ sender }) => palette['options.open'](sender));
  onMessage('shortcuts.get', ({ sender }) => palette['shortcuts.get'](sender));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading') void icon.reset(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => icon.forget(tabId));

  // Context menu items and shortcuts. Listeners are registered synchronously at top level.
  // Menus persist across restarts: the items are rebuilt on install and update, and on
  // browser start, since a new browser language only applies after a restart.
  const menus = createMenuHandlers({
    send: (type, data, target) => sendMessage(type, data as never, target),
    activeTabId: async () =>
      (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  });
  browser.contextMenus.onClicked.addListener((info, tab) => menus.onClicked(info, tab));
  browser.commands.onCommand.addListener((command, tab) => menus.onCommand(command, tab));
  const rebuildMenus = () => {
    rebuildContextMenus({
      removeAll: () => browser.contextMenus.removeAll(),
      create: (item) =>
        new Promise<void>((resolve, reject) => {
          browser.contextMenus.create(item, () => {
            const error = browser.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          });
        }),
    }).catch((error: unknown) => {
      console.warn('[context-menu] rebuild failed:', toAppError(error).code);
    });
  };
  browser.runtime.onInstalled.addListener(rebuildMenus);
  browser.runtime.onStartup.addListener(rebuildMenus);

  // A key lives exactly as long as its custom provider, however the provider went
  // away (deleted on any page, reset, dropped by repair). The background owns this.
  // A config written by a newer build is read-only here: its defaults stand in for
  // providers that still exist, so it must never decide which keys to delete.
  const pruneSecrets = (snapshot: ConfigSnapshot | undefined) => {
    if (!snapshot) return;
    secrets.pruneCustom(new Set(Object.keys(snapshot.data.customProviders))).catch(() => {
      console.warn('[secrets] prune failed');
    });
  };
  const load = () => {
    // Shares the repository queue with patches, so it never races them.
    repo
      .loadStored()
      .then(pruneSecrets)
      .catch((error: unknown) => {
        console.warn('[config] load failed:', toAppError(error).code);
      });
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && CONFIG_STORAGE_KEY in changes) load();
  });
  browser.runtime.onInstalled.addListener(load);
  load();
});
