import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createPalette } from '@/content/palette/palette';
import { PALETTE_RUNTIME_KEY, type PaletteRuntimeFactory } from '@/content/runtime-contract';
import { createPortClient } from '@/lib/messaging/port';
import { TRANSLATE_PORT_NAME } from '@/lib/messaging/port-name';
import type { TranslateChunk, TranslateDone, TranslateRequest } from '@/lib/messaging/protocol';

// Loaded on demand by the content script (see content/loader), like page-runtime.ts.
// Evaluating this file must only register the factory: no DOM, no config, no i18n, no Port.
// Same limits: no runtime imports from `protocol.ts` or `config/client.ts` (the bootstrap
// lends them through `deps`, every background message through `deps.send`), no reference to
// any extension resource address. The quick translation opens its own Port, as the selection
// card does (selection-runtime.ts).

const createPaletteRuntime: PaletteRuntimeFactory = (deps) =>
  createPalette({
    deps,
    // Connects on the first quick translation, not here.
    port: createPortClient<TranslateRequest, TranslateChunk, TranslateDone>(() =>
      browser.runtime.connect({ name: TRANSLATE_PORT_NAME }),
    ),
    env: {
      win: window,
      // async: a synchronous throw (the extension reloaded under the page) becomes a rejection.
      detectLanguage: async (text) => browser.i18n.detectLanguage(text),
    },
  });

export default defineUnlistedScript(() => {
  (globalThis as Record<symbol, unknown>)[Symbol.for(PALETTE_RUNTIME_KEY)] = createPaletteRuntime;
});
