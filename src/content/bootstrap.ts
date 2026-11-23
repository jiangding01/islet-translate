import { appError } from '@/lib/errors';
import { handle } from '@/lib/messaging/handle';
import type { onMessage, PageInfo, PageState } from '@/lib/messaging/protocol';
import {
  IDLE_PAGE_STATE,
  type PageActions,
  type PageRuntimeDeps,
  type PageRuntimeFactory,
  type PaletteRuntimeDeps,
  type PaletteRuntimeFactory,
  type SelectionRuntimeDeps,
  type SelectionRuntimeFactory,
  type SelectionSnapshot,
} from './runtime-contract';
import { decideOpen } from './selection/open';
import type { PageSession } from './session';

// The always-loaded half of the content script: answers popup/background messages and
// loads the page runtime only when a session is actually needed (the selection runtime only
// when a dot or card is, the palette runtime only when the palette is). The state of
// `page.loaded` is the session state: none / loading / ready. A failed load clears
// it so nothing pins the failure; Chrome caches a failed module import per URL, so in
// practice recovery needs a page reload, which the page-unreachable message asks for.

export interface BootstrapDeps {
  onMessage: typeof onMessage;
  pageInfo(): PageInfo;
  loadFactory(): Promise<PageRuntimeFactory>;
  runtime: PageRuntimeDeps;
  selection: {
    loadFactory(): Promise<SelectionRuntimeFactory>;
    runtime: SelectionRuntimeDeps;
    /** The top document's selection, extracted; undefined when there is none. */
    read(): SelectionSnapshot | undefined;
    /** `document.hasFocus()`. */
    hasFocus(): boolean;
    /**
     * Whether the extension context is still valid (`browser.runtime.id` is set). After an
     * update or reload the old page's script lives on with every extension API dead.
     */
    alive?(): boolean;
    /**
     * The context is gone for good: stop watching the selection and the hold key. Called
     * once; a loaded selection runtime is then told to hide its dot, and a loaded palette
     * to close.
     */
    onContextLost?(): void;
  };
  palette: {
    loadFactory(): Promise<PaletteRuntimeFactory>;
    /** The bootstrap adds its page action table (`page`). */
    runtime: Omit<PaletteRuntimeDeps, 'page'>;
  };
}

/** The error Chrome throws from extension APIs once the context is invalidated. */
const CONTEXT_INVALIDATED = /context invalidated/i;

export interface Bootstrap {
  /**
   * Loads the page runtime and lets it start unless the page is already in the target
   * language or a session is already running; the auto-start entry point.
   */
  autoStart(): Promise<void>;
  /** Shows the selection dot, loading the selection runtime on first use; never throws. */
  showDot(selection: SelectionSnapshot): void;
  /** Removes the dot; does nothing when the selection runtime was never loaded. */
  hideDot(): void;
  /**
   * Ctrl was held over this viewport point: toggles the paragraph there. With no session,
   * loads the page runtime, which then translates held paragraphs only.
   */
  holdToggle(point: { x: number; y: number }): void;
}

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  let contextLost = false;

  /** Whether the extension context is gone; the first time, the watches stop. */
  function isContextLost(cause?: unknown): boolean {
    if (contextLost) return true;
    const dead =
      deps.selection.alive?.() === false ||
      (cause !== undefined && CONTEXT_INVALIDATED.test(String(cause)));
    if (!dead) return false;
    contextLost = true;
    deps.selection.onContextLost?.();
    // The watch is stopped now, so no later hideDot would reach the runtime: a dot (or a
    // parked one, waiting to scroll back) would outlive the extension. Nor could the
    // shortcut close the palette any more.
    hideDot();
    closePalette();
    return true;
  }

  /**
   * An on-demand runtime, loaded on first use. A failed load is forgotten so the next use
   * tries again. A load failing on an invalidated context marks the context lost (no
   * warning): the dot, the hold key and the palette shortcut check `isContextLost` first and
   * never load again; the page and card messages still try, and fail the same way.
   */
  function lazy<T>(name: string, create: () => Promise<T>) {
    const slot: { loaded?: Promise<T>; load(): Promise<T> } = {
      load() {
        if (slot.loaded) return slot.loaded;
        let pending: Promise<T> | undefined;
        pending = (async () => {
          // Defer one tick so a synchronous failure cannot clear the cache before it is set.
          await Promise.resolve();
          try {
            return await create();
          } catch (cause) {
            if (slot.loaded === pending) slot.loaded = undefined;
            // The extension was updated or reloaded: expected, and nothing will load again.
            if (!isContextLost(cause)) {
              console.warn(`[islet-translate] ${name} runtime failed to load`, cause);
            }
            throw appError('network', 'network/page-unreachable', `${name} runtime failed to load`);
          }
        })();
        slot.loaded = pending;
        return pending;
      },
    };
    return slot;
  }

  // The session itself: none / loading / ready is `page.loaded`.
  const page = lazy('page', async () => (await deps.loadFactory())(deps.runtime));
  const load = page.load;

  const card = lazy('selection', async () =>
    (await deps.selection.loadFactory())(deps.selection.runtime),
  );

  function hideDot() {
    card.loaded?.then((runtime) => runtime.hideDot()).catch(() => {});
  }

  /** Closes the palette, if it was ever loaded (the card is about to open). */
  function closePalette() {
    palette.loaded?.then((runtime) => runtime.close()).catch(() => {});
  }

  /** Never loads: with no session, the answer is the idle state. */
  async function withSession(
    run: (session: PageSession) => PageState | Promise<PageState>,
  ): Promise<PageState> {
    if (!page.loaded) return { ...IDLE_PAGE_STATE };
    return run(await page.loaded);
  }

  // One table for the panel's and the shortcut's messages and for the palette.
  const actions: PageActions = {
    getState: () => withSession((session) => session.state()),
    // Answers as soon as the session is running, so the panel can close at once;
    // discovery continues in the page.
    async start(args) {
      const session = await load();
      session.start(args ?? {}).catch(() => {
        // A failed start already restored the page; the panel shows idle next time.
      });
      return session.state();
    },
    stop: () => withSession((session) => session.stop()),
    toggle: async () => (await load()).toggle(),
    setMode: (mode) => withSession((session) => session.setMode(mode)),
    retryFailed: () => withSession((session) => session.retryFailed()),
  };

  const palette = lazy('palette', async () =>
    (await deps.palette.loadFactory())({ ...deps.palette.runtime, page: actions }),
  );

  deps.onMessage('page.getInfo', handle(deps.pageInfo));
  for (const name of Object.keys(actions) as (keyof PageActions)[]) {
    deps.onMessage(
      `page.${name}` as 'page.start',
      handle(({ data }) => actions[name](data as never)),
    );
  }

  // One floating layer at a time (docs/plans/m3c.md decision 5): opening the palette closes
  // the card and the dot, opening the card closes the palette.
  deps.onMessage(
    'palette.toggle',
    handle(async () => {
      if (isContextLost()) {
        throw appError('network', 'network/page-unreachable', 'Extension context invalidated');
      }
      card.loaded
        ?.then((runtime) => {
          runtime.close();
          runtime.hideDot();
        })
        .catch(() => {});
      (await palette.load()).toggle();
      return null;
    }),
  );

  // Handled in the top frame only (the content script runs nowhere else).
  deps.onMessage(
    'selection.open',
    handle(async ({ data }) => {
      const decision = decideOpen({
        selectionText: data?.selectionText,
        frameId: data?.frameId,
        hasFocus: deps.selection.hasFocus(),
        top: deps.selection.read(),
      });
      switch (decision.kind) {
        case 'ignore':
          break;
        case 'close':
          // Nothing to close unless the runtime was ever loaded.
          if (card.loaded) (await card.loaded).close();
          break;
        case 'top':
          closePalette();
          (await card.load()).open({
            source: decision.selection.source,
            selection: decision.selection,
          });
          break;
        case 'detached':
          closePalette();
          (await card.load()).open({ source: decision.source });
          break;
      }
      return null;
    }),
  );

  return {
    showDot(selection) {
      if (isContextLost()) return;
      card
        .load()
        .then((runtime) => runtime.showDot(selection))
        .catch(() => {
          // Already logged; a dot is a convenience.
        });
    },
    hideDot,
    holdToggle(point) {
      if (isContextLost()) return;
      load()
        .then((session) => {
          if (!session.state().halted) return session.toggleAt(point);
        })
        .catch(() => {
          // A failed load was already reported; a toggle is a convenience.
        });
    },
    async autoStart() {
      await (await load()).autoStart();
    },
  };
}
