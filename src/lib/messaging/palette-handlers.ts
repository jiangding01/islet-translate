import { appError } from '@/lib/errors';
import { handle } from './handle';
import type { PaletteShortcuts } from './protocol';

/** What the handlers read of a message sender: the tab and frame the content script runs in. */
export interface PaletteSenderLike {
  tab?: { id?: number };
  frameId?: number;
}

export interface PaletteHandlerDeps {
  openOptionsPage(): Promise<void>;
  /** `commands.getAll()`: `shortcut` is empty when the command has no key. */
  getAllCommands(): Promise<{ name?: string; shortcut?: string }[]>;
}

const SHORTCUT_NAMES = ['translate-page', 'translate-selection', 'open-palette'] as const;

/**
 * `options.open` and `shortcuts.get`: the palette's two narrow messages. Top frame of a tab
 * only (like `page.status`); they read or navigate, and touch no storage.
 */
export function createPaletteHandlers(deps: PaletteHandlerDeps) {
  const guard = (sender: PaletteSenderLike | undefined) => {
    if (sender?.tab?.id === undefined || sender.frameId !== 0) {
      throw appError('validation', 'validation/invalid-payload', 'Invalid sender');
    }
  };
  return {
    'options.open': handle(async (sender: PaletteSenderLike | undefined) => {
      guard(sender);
      await deps.openOptionsPage();
      return null;
    }),
    'shortcuts.get': handle(async (sender: PaletteSenderLike | undefined) => {
      guard(sender);
      const all = await deps.getAllCommands();
      const shortcuts: PaletteShortcuts = {
        'translate-page': '',
        'translate-selection': '',
        'open-palette': '',
      };
      for (const name of SHORTCUT_NAMES) {
        shortcuts[name] = all.find((command) => command.name === name)?.shortcut ?? '';
      }
      return shortcuts;
    }),
  };
}
