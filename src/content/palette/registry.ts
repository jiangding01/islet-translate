import type { PageState } from '@/lib/messaging/protocol';
import { message } from '../i18n';
import { hasRetry, isActive } from '../page-state';
import type { PageActions } from '../runtime-contract';

// The palette's commands (docs/plans/m3c.md, "指令表"): plain data and pure functions, no DOM.
// Copy is looked up inside `title` only (docs/plans/i18n.md 4.2): evaluating this module
// must not call i18n.

/** What a command's availability and order depend on. */
export interface PaletteContext {
  state: PageState;
}

/** What a command can do when it runs. */
export interface CommandApi {
  page: PageActions;
  /** Shows the engine list in place of the commands; the palette stays open. */
  engines(): void;
}

export interface Command {
  id: string;
  title(ctx: PaletteContext): string;
  /** English aliases, lower case: they match in every UI language. */
  keywords: readonly string[];
  when(ctx: PaletteContext): boolean;
  /** Higher comes first among equally good matches; 0 when absent. */
  rank?(ctx: PaletteContext): number;
  /** The palette closes afterwards unless the command opened the engine list. */
  run(ctx: PaletteContext, api: CommandApi): void;
}

/** Errors are not the palette's to show: the isle and the panel report the session. */
const quiet = (pending: Promise<unknown>) => {
  pending.catch(() => {});
};

/** Idle, or only held paragraphs translated: the whole page can still be translated. */
const canTranslate = ({ state }: PaletteContext) =>
  state.phase === 'idle' || state.scope === 'units';

export const COMMANDS: readonly Command[] = [
  {
    id: 'page.translate',
    title: () => message('popup.translatePage'),
    keywords: ['translate page', 'start'],
    when: canTranslate,
    rank: ({ state }) => (state.phase === 'idle' ? 1 : 0),
    run: (_ctx, { page }) => quiet(page.start()),
  },
  {
    id: 'page.restore',
    title: () => message('isle.modeOriginal'),
    keywords: ['show original', 'restore', 'stop'],
    // Held paragraphs too: one step undoes them all.
    when: ({ state }) => state.phase !== 'idle',
    run: (_ctx, { page }) => quiet(page.stop()),
  },
  {
    id: 'view.bilingual',
    title: () => message('isle.modeBilingual'),
    keywords: ['bilingual', 'mode'],
    when: ({ state }) => isActive(state) && state.mode !== 'bilingual',
    run: (_ctx, { page }) => quiet(page.setMode('bilingual')),
  },
  {
    id: 'view.translationOnly',
    title: () => message('isle.modeTranslation'),
    keywords: ['translation only', 'mode'],
    when: ({ state }) => isActive(state) && state.mode !== 'translation',
    run: (_ctx, { page }) => quiet(page.setMode('translation')),
  },
  {
    id: 'retry.failed',
    title: () => message('palette.retryFailed'),
    keywords: ['retry failed'],
    // The isle's own rule for its Retry button.
    when: ({ state }) => hasRetry(state),
    rank: () => 2,
    run: (_ctx, { page }) => quiet(page.retryFailed()),
  },
  {
    id: 'engine.switch',
    title: ({ state }) =>
      isActive(state) ? message('palette.switchEngine') : message('palette.translateWith'),
    keywords: ['engine', 'service', 'switch'],
    when: () => true,
    run: (_ctx, { engines }) => engines(),
  },
];

/** Lower case, trimmed; a leading `/` only says "commands", so it is dropped. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/^\//, '').trim().toLowerCase();
}

/**
 * The commands to list for `query`: available ones only, none at all once the session has
 * halted. With a query, title prefix matches come before other matches (title substrings and
 * keywords); then the context's rank, then table order.
 */
export function listCommands(
  ctx: PaletteContext,
  query: string,
  commands: readonly Command[] = COMMANDS,
): Command[] {
  if (ctx.state.halted) return [];
  const q = normalizeQuery(query);
  const found: { command: Command; tier: number; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    if (!command.when(ctx)) return;
    let tier = 0;
    if (q) {
      const title = command.title(ctx).toLowerCase();
      if (title.startsWith(q)) tier = 0;
      else if (title.includes(q) || command.keywords.some((keyword) => keyword.includes(q))) {
        tier = 1;
      } else return;
    }
    found.push({ command, tier, rank: command.rank?.(ctx) ?? 0, index });
  });
  found.sort((a, b) => a.tier - b.tier || b.rank - a.rank || a.index - b.index);
  return found.map((entry) => entry.command);
}
