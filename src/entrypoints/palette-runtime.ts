import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createPalette } from '@/content/palette/palette';
import { PALETTE_RUNTIME_KEY, type PaletteRuntimeFactory } from '@/content/runtime-contract';

// Loaded on demand by the content script (see content/loader), like page-runtime.ts.
// Evaluating this file must only register the factory: no DOM, no config, no i18n.
// Same limits: no runtime imports from `protocol.ts` or `config/client.ts` (the bootstrap
// lends them through `deps`, every background message through `deps.send`), no reference to
// any extension resource address.

const createPaletteRuntime: PaletteRuntimeFactory = (deps) =>
  createPalette({ deps, env: { win: window } });

export default defineUnlistedScript(() => {
  (globalThis as Record<symbol, unknown>)[Symbol.for(PALETTE_RUNTIME_KEY)] = createPaletteRuntime;
});
