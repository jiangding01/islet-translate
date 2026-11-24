import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startIfRemembered } from '@/content/auto-start';
import { createBootstrap } from '@/content/bootstrap';
import { createHoldWatch } from '@/content/hold/watch';
import { loadRuntime } from '@/content/loader';
import {
  PAGE_RUNTIME_KEY,
  PALETTE_RUNTIME_KEY,
  type PageRuntimeFactory,
  type PaletteRuntimeFactory,
  SELECTION_RUNTIME_KEY,
  type SelectionRuntimeFactory,
  type Send,
} from '@/content/runtime-contract';
import { createSelectionWatch, readSelection } from '@/content/selection/watch';
import { readConfig, watchConfig } from '@/lib/config/client';
import type { ConfigV1 } from '@/lib/config/types';
import type { Result } from '@/lib/errors';
import { onMessage, sendMessage } from '@/lib/messaging/protocol';
import { SITE_MEMORY_KEY } from '@/lib/site-memory';

// Runs on every page. The resident part is only the selection and hold-key watchers (a few
// listeners and cheap checks, content/selection/watch and content/hold/watch): until a dot,
// a card or a toggle is wanted it builds no Port and writes no DOM. The page runtime (session,
// scanner, renderer), the selection runtime (dot, card) and the palette runtime are separate
// files imported on first use; this entry only routes messages (content/bootstrap).

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  // WXT otherwise window.postMessage()s `${runtime.id}:...content-script-started` to the
  // page on every load, handing any site the extension ID. It only serves extensions
  // whose older builds listened for that message; ours never did.
  noScriptStartedPostMessage: true,
  main() {
    const getConfig = async () => (await readConfig()).data;
    const watchData = (callback: (config: ConfigV1) => void) =>
      watchConfig((snapshot) => callback(snapshot.data));
    const send: Send = async (type, ...data) => {
      const result = await (
        sendMessage as (type: string, data?: unknown) => Promise<Result<never>>
      )(type, ...data);
      if (!result.ok) throw result.error;
      return result.data;
    };
    const listEngines = () => send('engine.options');
    /** On-demand modules: the address is resolved on every load, never kept. */
    const loader =
      <T extends (...args: never[]) => unknown>(path: string, key: string) =>
      () =>
        loadRuntime<T>({
          path,
          key,
          // WXT types getURL with the public files only; the runtimes are unlisted scripts.
          getURL: (file) => browser.runtime.getURL(file as '/page-runtime.js'),
          importModule: (url) => import(/* @vite-ignore */ url),
        });
    const bootstrap = createBootstrap({
      onMessage,
      pageInfo: () => ({
        title: document.title,
        language: document.documentElement.lang,
      }),
      loadFactory: loader<PageRuntimeFactory>('/page-runtime.js', PAGE_RUNTIME_KEY),
      runtime: {
        getConfig,
        watchConfig: watchData,
        listEngines,
        paletteShortcut: () =>
          send('shortcuts.get').then(
            (keys) => keys['open-palette'],
            () => '',
          ),
        reportStatus: (status) => {
          sendMessage('page.status', status).catch(() => {
            // Background unreachable or extension reloaded: the dot is cosmetic.
          });
        },
      },
      selection: {
        loadFactory: loader<SelectionRuntimeFactory>(
          '/selection-runtime.js',
          SELECTION_RUNTIME_KEY,
        ),
        runtime: {
          getConfig,
          watchConfig: watchData,
          listEngines,
          detectLanguage: (text) => browser.i18n.detectLanguage(text),
        },
        read: () => readSelection(document),
        hasFocus: () => document.hasFocus(),
        // `runtime.id` is unset once the extension is updated or reloaded.
        alive: () => browser.runtime?.id !== undefined,
        onContextLost: () => {
          selectionWatch.stop();
          holdWatch.stop();
        },
      },
      palette: {
        loadFactory: loader<PaletteRuntimeFactory>('/palette-runtime.js', PALETTE_RUNTIME_KEY),
        runtime: { getConfig, send },
      },
    });

    const selectionWatch = createSelectionWatch({
      doc: document,
      getConfig,
      watchConfig: watchData,
      onCandidate: (selection) => bootstrap.showDot(selection),
      onClear: () => bootstrap.hideDot(),
    });
    selectionWatch.start();

    // Holding Ctrl (or the key set in `page.holdKey`) over a paragraph toggles it; with no
    // page session, it translates the held paragraphs alone (the page runtime loads on the
    // first hold).
    const holdWatch = createHoldWatch({
      doc: document,
      onHold: (point) => bootstrap.holdToggle(point),
      getConfig,
      watchConfig: watchData,
    });
    holdWatch.start();

    startIfRemembered({
      origin: location.origin,
      readMemory: async () => (await browser.storage.local.get(SITE_MEMORY_KEY))[SITE_MEMORY_KEY],
      start: () => bootstrap.autoStart(),
    }).catch(() => {
      // Storage unavailable, extension reloaded or runtime failed to load: stay untouched.
    });
  },
});
