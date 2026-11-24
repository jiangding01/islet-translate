import type { PageState } from '@/lib/messaging/protocol';
import { message } from '../i18n';
import { hasRetry, isActive } from '../page-state';
import type { PageActions, RegionKind } from '../runtime-contract';

// The palette's commands (docs/plans/m3c.md, "指令表"): plain data and pure functions, no DOM.
// Copy is looked up inside `title` only (docs/plans/i18n.md 4.2): evaluating this module
// must not call i18n.

/** What a command's availability and order depend on. */
export interface PaletteContext {
  state: PageState;
  /** The latest quick translation (PR3), once it has a translation to copy. */
  quick?: { copied: boolean };
}

/** What a command can do when it runs. */
export interface CommandApi {
  page: PageActions;
  /** Shows the engine list in place of the commands; the palette stays open. */
  engines(): void;
  /** Closes the palette, then asks the background to open the settings page. */
  openSettings(): void;
  /** Copies the quick translation; the palette stays open and says it was copied. */
  copy(): void;
  /**
   * Closes the palette without handing the focus back and starts the region picker (PR4;
   * `exclude`, PR5), which keeps that focus until the pick ends.
   */
  pickRegion(kind?: RegionKind): void;
}

export interface Command {
  id: string;
  title(ctx: PaletteContext): string;
  /** English aliases, lower case: they match in every UI language. */
  keywords: readonly string[];
  when(ctx: PaletteContext): boolean;
  /** Higher comes first among equally good matches; 0 when absent. */
  rank?(ctx: PaletteContext): number;
  /**
   * Listed first whenever it is available, whatever the query: the query is the text that
   * was translated, not a search for this command.
   */
  sticky?: true;
  /** The palette stays open afterwards. */
  stays?: true;
  /** The palette closes afterwards unless the command opened the engine list or `stays`. */
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
    id: 'quick.copy',
    title: ({ quick }) => message(quick?.copied ? 'card.copied' : 'card.copy'),
    keywords: ['copy'],
    when: ({ quick }) => !!quick,
    sticky: true,
    stays: true,
    run: (_ctx, { copy }) => copy(),
  },
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
  {
    id: 'region.translate',
    title: () => message('palette.regionTranslate'),
    keywords: ['region', 'area', 'section', 'pick'],
    // As "翻译此页": a page session translates the region already.
    when: canTranslate,
    run: (_ctx, { pickRegion }) => pickRegion(),
  },
  {
    id: 'region.exclude',
    title: () => message('palette.regionExclude'),
    keywords: ['exclude', 'skip', 'region', 'area'],
    // A page session only: held paragraphs and regions are translated one by one already.
    when: ({ state }) => isActive(state),
    run: (_ctx, { pickRegion }) => pickRegion('exclude'),
  },
  {
    id: 'options.open',
    title: () => message('palette.openSettings'),
    keywords: ['settings', 'options', 'preferences'],
    when: () => true,
    // Below every other command in every context (the others' rank is 0 to 2).
    rank: () => -1,
    run: (_ctx, { openSettings }) => openSettings(),
  },
];

/**
 * A leading `/` says "commands only". Chinese input methods type `／` or `、` for the same
 * key, so those count too. Matched after trimming the start.
 */
export const COMMAND_PREFIX = /^[/／、]/;

/** Lower case, trimmed; a leading command prefix only says "commands", so it is dropped. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(COMMAND_PREFIX, '').trim().toLowerCase();
}

/**
 * Where the lower-cased `query` (normalizeQuery) is in `label`, as `[start, end)` indexes into
 * `label` itself. Each character is lower-cased on its own and mapped back: "İ" lower-cases to
 * two code units, so indexes into `label.toLowerCase()` would not fit `label`.
 */
export function matchRange(label: string, query: string): [number, number] | undefined {
  if (!query) return undefined;
  let lower = '';
  /** For each code unit of `lower`: the character of `label` it came from, as [start, end). */
  const from: [number, number][] = [];
  for (const char of label) {
    const start = from.length ? (from[from.length - 1] as [number, number])[1] : 0;
    const piece = char.toLowerCase();
    for (let i = 0; i < piece.length; i += 1) from.push([start, start + char.length]);
    lower += piece;
  }
  const at = lower.indexOf(query);
  if (at < 0) return undefined;
  return [(from[at] as [number, number])[0], (from[at + query.length - 1] as [number, number])[1]];
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
    if (command.sticky) tier = -1;
    else if (q) {
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
