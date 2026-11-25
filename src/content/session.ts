import type { ConfigV1, Engine, PageMode } from '@/lib/config/types';
import type { AppError } from '@/lib/errors';
import type { DetectedLanguages } from '@/lib/languages';
import type { PortClient, PortRequest } from '@/lib/messaging/port';
import type {
  PageState,
  PageStatus,
  TranslateChunk,
  TranslateDone,
  TranslateRequest,
} from '@/lib/messaging/protocol';
import { createPacer, discoverUnits, type Unit } from './discover';
import {
  HOLD_BLOCK_CHARS,
  HOST_TAGS,
  isInlineElement,
  isSingleLineLocked,
  isSkipped,
  OWN_TAG,
  protectedAncestor,
  type StyleReader,
  sourceLength,
} from './dom-rules';
import { errorText } from './error-text';
import { routeKeyOf, watchMutations } from './mutations';
import { pageIsInLanguage, sampleText } from './page-language';
import { createRenderer, inViewport, type Renderer } from './render';
import type { RegionKind } from './runtime-contract';
import { injectStyles, removeStyles } from './styles';

// One page-translation session: discovery → viewport queue → Port requests →
// renderer, plus new content and self-healing. Every async step re-checks the
// epoch, so a stopped or restarted session never writes stale results.

type TranslatePort = PortClient<TranslateRequest, TranslateChunk, TranslateDone>;

export interface ViewportObserver {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface SessionDeps {
  win: Window;
  port: TranslatePort;
  getConfig(): Promise<ConfigV1>;
  /** Live config updates while a session runs (the translation style can change). */
  watchConfig?(callback: (config: ConfigV1) => void): () => void;
  reportStatus(status: PageStatus): void;
  /**
   * Whether the extension is still reachable. When it is not (reloaded or updated under the
   * page), the session halts at its next notification; no port error is needed.
   */
  alive?(): boolean;
  /** `i18n.detectLanguage` for the auto-start language check; rejects when unavailable. */
  detectLanguage(text: string): Promise<DetectedLanguages>;
  createReadStyle(): StyleReader;
  /** IntersectionObserver with rootMargin 1000px; injectable for tests. */
  createViewport(onChange: (targets: Element[], visible: boolean[]) => void): ViewportObserver;
  createMutationWatch?: typeof watchMutations;
  /**
   * Runs `callback` on the next frame and returns a canceller; subscribers are notified
   * through it, so a burst of changes pushes once per frame. Defaults to rAF.
   */
  scheduleFrame?(callback: () => void): () => void;
  /** Tests only: how long a paragraph waits before its loading dot shows (default 600 ms). */
  loadingDelayMs?: number;
  /** Tests only: the loading dots' scan interval (default 300 ms). */
  loadingScanMs?: number;
  /** Tests only: whether the element touches the real viewport (default: its rect). */
  inViewport?(el: Element): boolean;
}

export interface PageSession {
  start(options?: { engine?: Engine }): Promise<PageState>;
  /**
   * "总是翻译此站": starts unless a session is already running or the page is already in
   * the target language (then nothing starts and nothing is reported).
   */
  autoStart(): Promise<PageState>;
  stop(): Promise<PageState>;
  toggle(): Promise<PageState>;
  setMode(mode: PageMode): Promise<PageState>;
  retryFailed(): PageState;
  /**
   * Hold-to-toggle: the paragraph at this viewport point is restored (and left alone until
   * the user stops) if translated, else translated at once, a failed one retried. With no
   * session it starts one for held paragraphs only (`scope: 'units'`). Ignored once halted
   * and until a page session's first scan is registered.
   */
  toggleAt(point: { x: number; y: number }): Promise<void>;
  /**
   * The palette's region picker (docs/plans/m3c.md, PR4/PR5). `translate`: every paragraph in
   * `root` is translated as held paragraphs are (a `scope: 'units'` session, started here when
   * idle, added to otherwise), under the page scan's rules; paragraphs held away there come
   * back. Changes nothing once halted, during a page session, or for a region over the hold
   * limit. `exclude`: a page session leaves `root` alone until it stops or the route changes
   * (a hold inside lets the region back in); what it shows there goes at once. Changes nothing
   * once halted, without a page session, or for a region left alone already. Resolves to
   * whether anything changed (paragraphs added to the translation, a region left alone).
   */
  region(kind: RegionKind, root: Element): Promise<boolean>;
  state(): PageState;
  /**
   * Called with the current state at most once per frame after anything visible changed.
   * Not called on subscribe; read `state()` for the initial value. Returns an unsubscriber.
   */
  subscribe(listener: (state: PageState) => void): () => void;
}

const BATCH_ITEMS = 50;
const BATCH_CHARS = 8000;
const MAX_IN_FLIGHT = 6;
const FLUSH_DEBOUNCE_MS = 50;
const RENDER_COALESCE_MS = 16;
const SCROLL_QUIET_MS = 150;
const RETRY_DELAYS_MS = [500, 1000, 2000];
const LOOP_WINDOW_MS = 10_000;
const LOOP_LIMIT = 3;
const VIEWPORT_CHUNK = 500;
const LOADING_DELAY_MS = 600;
const LOADING_SCAN_MS = 300;

/** Engine-level problems: shown once, the session pauses instead of failing every paragraph. */
export function isEngineLevel(error: AppError): boolean {
  return (
    error.code.startsWith('config/') ||
    error.code === 'provider/unauthorized' ||
    error.code === 'provider/quota-exceeded' ||
    error.code === 'provider/local-origin-rejected'
  );
}

export function createPageSession(deps: SessionDeps): PageSession {
  const { win, port } = deps;
  const doc = win.document;
  const now = () => Date.now();
  const loadingDelay = deps.loadingDelayMs ?? LOADING_DELAY_MS;
  const loadingScan = deps.loadingScanMs ?? LOADING_SCAN_MS;
  /** The real viewport, not the 1000px prefetch margin the observer reports. */
  const inView = deps.inViewport ?? ((el: Element) => inViewport(el, win));
  const watch = deps.createMutationWatch ?? watchMutations;
  const scheduleFrame =
    deps.scheduleFrame ??
    ((callback: () => void) => {
      const handle = win.requestAnimationFrame(callback);
      return () => win.cancelAnimationFrame(handle);
    });

  let epoch = 0;
  let phase: PageState['phase'] = 'idle';
  /** 'units': held paragraphs only, no page scan; a start or toggle grows it into the page. */
  let scope: 'units' | 'page' = 'page';
  let halted = false;
  let engine: Engine | undefined;
  let engineError: AppError | undefined;
  let config: ConfigV1 | undefined;
  let renderer: Renderer | undefined;
  let viewport: ViewportObserver | undefined;
  let stopWatching: (() => void) | undefined;
  let stopWatchingConfig: (() => void) | undefined;
  let sheet: HTMLStyleElement | undefined;
  /** This session's own Port requests: stop cancels these, never other features' requests. */
  const requests = new Set<PortRequest<TranslateDone>>();
  let readStyle: StyleReader = deps.createReadStyle();
  let lastScroll = Number.NEGATIVE_INFINITY;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * From the page scan until the first request: the viewport's first report is the first
   * screen, sent at once, not after the debounce (the scan's own flush often runs before it).
   */
  let eager = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  let inFlight = 0;
  let stopping: Promise<unknown> | undefined;
  /** Elements changed during the first scan, held until it is registered; undefined after. */
  let held: Element[] | undefined;
  /**
   * "Not this paragraph" (hold-to-toggle): source texts by unit root, since a rescan makes
   * new Unit objects. Kept across rescans; a user stop forgets them.
   */
  let excluded = new WeakMap<Element, Set<string>>();
  /**
   * "选择不翻译的区域": regions a page session leaves alone, and the route they were picked on.
   * A stop or another route forgets them; undefined while there are none.
   */
  let excludedRoots: WeakSet<Element> | undefined;
  let excludedRoute = '';
  /** `el` is in a region left alone: it or an ancestor below the body was picked. */
  const inExcludedRegion = (el: Element | null) => {
    for (; excludedRoots && el && el !== doc.body; el = el.parentElement) {
      if (excludedRoots.has(el)) return true;
    }
    return false;
  };
  /** Too-long units found in a region left alone: no note, no count until it comes back. */
  const unnoted = new Set<Unit>();
  /** Held away (this text at this root), or in a region left alone. */
  const isExcluded = (unit: Unit) =>
    excluded.get(unit.root)?.has(unit.seg.text) === true || inExcludedRegion(unit.root);

  const unitsByRoot = new Map<Element, Unit[]>();
  const ids = new Map<Unit, string>();
  const byId = new Map<string, Unit>();
  const pending = new Set<Unit>();
  const sent = new Set<Unit>();
  const settled = new Set<Unit>();
  const failed = new Set<Unit>();
  /** Units of a failed request waiting for their delayed retry: neither pending nor sent. */
  const waiting = new Set<Unit>();
  const translations = new Map<string, string>();
  const reinserts = new Map<string, number[]>();
  /** Texts a page keeps throwing our translation away for: left alone for the session. */
  const abandoned = new Set<string>();
  /** Roots the viewport observer last reported inside the 1000px margin. */
  const visibleRoots = new Set<Element>();
  const queued = new Set<Unit>();
  /**
   * When each unfinished unit (pending, sent or waiting) was first wanted. Kept across a
   * pause and a retry, so a paragraph that has waited long shows its dot at once on resume.
   */
  const wantedAt = new Map<Unit, number>();
  /** Units whose loading dot was asked for; a translation or failure replaces it on its own. */
  const shown = new Set<Unit>();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const toRender: { unit: Unit; translation: string }[] = [];
  /** Handed to the renderer, written on its next frame: about to show, like `queued`. */
  const writing = new Set<Unit>();

  const listeners = new Set<(state: PageState) => void>();
  let cancelFrame: (() => void) | undefined;

  /** Coalesces to one push per frame; listeners read the state when the frame fires. */
  function notify() {
    if (!halted && deps.alive?.() === false) halt();
    if (cancelFrame || listeners.size === 0) return;
    cancelFrame = scheduleFrame(() => {
      cancelFrame = undefined;
      const snapshot = state();
      for (const listener of [...listeners]) listener(snapshot);
    });
  }

  function subscribe(listener: (state: PageState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        cancelFrame?.();
        cancelFrame = undefined;
      }
    };
  }

  const onScroll = () => {
    lastScroll = now();
  };

  function status(): PageStatus {
    if (phase === 'idle') return 'idle';
    if (engineError || failed.size > 0) return 'error';
    return pending.size > 0 || inFlight > 0 || waiting.size > 0 ? 'running' : 'done';
  }

  function report() {
    notify();
    ensureScan();
    if (phase === 'idle' || halted) return;
    phase = pending.size > 0 || inFlight > 0 || waiting.size > 0 ? 'running' : 'done';
    // Held paragraphs alone leave the toolbar dot off.
    if (scope === 'page') deps.reportStatus(status());
  }

  function state(): PageState {
    let translated = 0;
    let skipped = 0;
    for (const units of unitsByRoot.values()) {
      for (const unit of units) {
        if (unit.skipped && !unnoted.has(unit)) skipped += 1;
        if (renderer?.has(unit)) translated += 1;
      }
    }
    return {
      phase,
      mode: renderer?.mode ?? config?.page.mode ?? 'bilingual',
      translated,
      failed: failed.size,
      engineError,
      engine,
      ...(skipped > 0 ? { skipped } : {}),
      ...(halted ? { halted: true as const } : {}),
      ...(scope === 'units' ? { scope } : {}),
    };
  }

  function idOf(unit: Unit): string {
    let id = ids.get(unit);
    if (!id) {
      id = `u${nextId++}`;
      ids.set(unit, id);
      byId.set(id, unit);
    }
    return id;
  }

  /** Repeated re-insertion of the same text means a framework fight: give up on it. */
  function allowReinsert(text: string): boolean {
    const at = now();
    const recent = (reinserts.get(text) ?? []).filter((time) => at - time < LOOP_WINDOW_MS);
    if (recent.length >= LOOP_LIMIT) {
      abandoned.add(text);
      console.warn('[islet-translate] a page keeps removing a translation; leaving it alone');
      return false;
    }
    recent.push(at);
    reinserts.set(text, recent);
    return true;
  }

  const unfinished = (unit: Unit) => pending.has(unit) || sent.has(unit) || waiting.has(unit);

  /** A unit is done waiting and its dot is not wanted any more (the dot goes with it). */
  function release(unit: Unit) {
    wantedAt.delete(unit);
    shown.delete(unit);
    renderer?.hideLoading(unit);
  }

  /** The reply is in: the renderer swaps the dot for the translation or failure itself. */
  function answered(unit: Unit) {
    wantedAt.delete(unit);
    shown.delete(unit);
  }

  function hideAllLoading() {
    renderer?.hideAllLoading();
    shown.clear();
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
  }

  function hasUnfinishedWanted(): boolean {
    for (const unit of wantedAt.keys()) if (unfinished(unit)) return true;
    return false;
  }

  /** Fixed-interval scan: runs only while something is unfinished and the session can progress. */
  function ensureScan() {
    if (scanTimer !== undefined || !renderer) return;
    if (phase === 'idle' || halted || engineError) return;
    if (!hasUnfinishedWanted()) return;
    const current = epoch;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      if (current !== epoch) return;
      scanLoading();
      ensureScan();
    }, loadingScan);
  }

  function scanLoading() {
    if (!renderer || phase === 'idle' || halted || engineError) return;
    const at = now();
    for (const [unit, since] of wantedAt) {
      if (shown.has(unit) || at - since < loadingDelay) continue;
      // Held paragraphs and regions have no viewport observer: the real viewport alone decides.
      const near = scope === 'units' || visibleRoots.has(unit.root);
      if (!unfinished(unit) || !near || !inView(unit.root)) continue;
      shown.add(unit);
      void renderer.showLoading(unit);
    }
    for (const unit of [...shown]) {
      if (unfinished(unit) && inView(unit.root)) continue;
      shown.delete(unit);
      renderer.hideLoading(unit);
    }
  }

  function queueRender(unit: Unit, translation: string) {
    queued.add(unit);
    toRender.push({ unit, translation });
    scheduleRender();
  }

  /**
   * A unit came into range (or the reader held Ctrl over it: `chosen` skips the single-line
   * rule): render from memory, or queue it for the network.
   */
  function want(unit: Unit, chosen = false): boolean {
    // Too long: counted and marked in the page, never sent (before any cache lookup).
    if (unit.skipped || isExcluded(unit)) return false;
    // The author pinned it to one line: no request, no loading dots, no count.
    if (!chosen && isSingleLineLocked(unit, readStyle)) return false;
    if (
      queued.has(unit) ||
      sent.has(unit) ||
      waiting.has(unit) ||
      settled.has(unit) ||
      failed.has(unit) ||
      renderer?.has(unit)
    ) {
      return false;
    }
    const cached = translations.get(unit.seg.text);
    if (cached !== undefined) {
      queueRender(unit, cached);
      return false;
    }
    if (pending.has(unit)) return false;
    pending.add(unit);
    if (!wantedAt.has(unit)) wantedAt.set(unit, now());
    ensureScan();
    return true;
  }

  function register(units: Unit[]) {
    let added = false;
    for (const unit of units) {
      // Held paragraphs alone: a too-long one is not marked (the page scan does that).
      if (abandoned.has(unit.seg.text) || (unit.skipped && scope === 'units')) continue;
      const list = unitsByRoot.get(unit.root);
      if (list) list.push(unit);
      else {
        unitsByRoot.set(unit.root, [unit]);
        viewport?.observe(unit.root);
      }
      // Already-observed roots get no new observer callback: queue them here (`want` leaves
      // held-away paragraphs and regions left alone out).
      if (visibleRoots.has(unit.root) && want(unit)) added = true;
      // Nothing to wait for: the note goes in at once, in or out of the viewport; in a region
      // left alone, once the region comes back (readmit).
      if (!unit.skipped) continue;
      if (inExcludedRegion(unit.root)) unnoted.add(unit);
      else void renderer?.skip(unit);
    }
    if (added) scheduleFlush();
  }

  function scheduleRender() {
    if (renderTimer !== undefined) return;
    const current = epoch;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (current !== epoch || !renderer) return;
      // Held away (or its region left alone) while it waited: the translation stays in
      // memory only. Forgotten meanwhile (no longer queued): its source changed, nothing goes in.
      const ready = toRender
        .splice(0)
        .filter(({ unit }) => queued.delete(unit) && !isExcluded(unit));
      if (ready.length === 0) return;
      for (const { unit } of ready) writing.add(unit);
      void renderer
        .insert(ready)
        .finally(() => {
          for (const { unit } of ready) writing.delete(unit);
        })
        .then(
          (stale) => {
            if (current !== epoch) return;
            for (const unit of stale) {
              forget(unit);
              void rescan([unit.root]);
            }
            report();
          },
          // A write that failed shows nothing: only its claim (above) had to go.
          () => undefined,
        );
    }, RENDER_COALESCE_MS);
  }

  function scheduleFlush(immediate = false) {
    if (flushTimer !== undefined) {
      if (!immediate) return;
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(flush, immediate ? 0 : FLUSH_DEBOUNCE_MS);
  }

  /** Queues what came into range and lets go of what left; whether anything changed. */
  function onViewport(targets: Element[], visible: boolean[]): boolean {
    let changed = false;
    targets.forEach((target, index) => {
      const inRange = visible[index] === true;
      if (inRange) visibleRoots.add(target);
      else visibleRoots.delete(target);
      for (const unit of unitsByRoot.get(target) ?? []) {
        if (inRange) {
          if (want(unit)) changed = true;
        } else if (pending.delete(unit)) {
          changed = true;
          release(unit);
        }
      }
    });
    return changed;
  }

  function onViewportChunked(targets: Element[], visible: boolean[]) {
    if (targets.length <= VIEWPORT_CHUNK) {
      if (onViewport(targets, visible)) scheduleFlush(eager);
      return;
    }
    // A first callback on a huge page can carry tens of thousands of entries.
    const current = epoch;
    let offset = 0;
    let changed = false;
    const step = () => {
      if (current !== epoch) return;
      if (
        onViewport(
          targets.slice(offset, offset + VIEWPORT_CHUNK),
          visible.slice(offset, offset + VIEWPORT_CHUNK),
        )
      )
        changed = true;
      offset += VIEWPORT_CHUNK;
      const more = offset < targets.length;
      // The first screen goes out at once, but only after the last slice: one flush, ranked
      // as a whole, as when every slice waited for the debounce.
      if (changed && !(more && eager)) scheduleFlush(eager && !more);
      if (more) setTimeout(step, 0);
    };
    step();
  }

  function flush() {
    flushTimer = undefined;
    if (phase === 'idle' || halted || engineError || !config) return;
    if (pending.size === 0) {
      report();
      return;
    }
    const scrolling = now() - lastScroll < SCROLL_QUIET_MS;
    // Read all positions in one pass, then order: visible, below, above.
    const ranked = [...pending]
      .map((unit) => ({ unit, rect: unit.root.getBoundingClientRect() }))
      .map(({ unit, rect }) => {
        const visible = rect.bottom > 0 && rect.top < win.innerHeight;
        const band = visible ? 0 : rect.top >= win.innerHeight ? 1 : 2;
        return { unit, band, top: rect.top };
      })
      .filter((entry) => !scrolling || entry.band === 0)
      .sort((a, b) => a.band - b.band || (a.band === 2 ? b.top - a.top : a.top - b.top));
    let index = 0;
    while (index < ranked.length && inFlight < MAX_IN_FLIGHT) {
      const batch: Unit[] = [];
      let chars = 0;
      while (index < ranked.length && batch.length < BATCH_ITEMS) {
        const entry = ranked[index] as (typeof ranked)[number];
        const size = entry.unit.seg.text.length;
        if (batch.length > 0 && chars + size > BATCH_CHARS) break;
        batch.push(entry.unit);
        chars += size;
        index += 1;
      }
      send(batch, 0);
    }
    if (scrolling && pending.size > 0) scheduleFlush();
    report();
  }

  function send(batch: Unit[], attempt: number) {
    if (!config || batch.length === 0) return;
    const current = epoch;
    eager = false;
    for (const unit of batch) {
      pending.delete(unit);
      sent.add(unit);
    }
    inFlight += 1;
    // The engine this request went to: the session may switch while it is out.
    const used = engine;
    const items = batch.map((unit) => ({ id: idOf(unit), text: unit.seg.text }));
    /**
     * Units this request still owes a final chunk. A revoked one may be on its way again in
     * another request by the time this one ends: that `sent` is not this request's to undo.
     */
    const open = new Set(batch);
    const request = port.request(
      {
        items,
        target: config.language.target,
        source: config.language.source,
        engine: used,
      },
      (chunk) => {
        if (current !== epoch) return;
        // Stream increments and phonetics belong to selection cards; page requests never
        // ask for them.
        if ('delta' in chunk || 'reset' in chunk || 'phonetic' in chunk) return;
        // Before `sent.delete`: the unit may be on its way again, and must stay there. The
        // source comes from this request, so a unit forgotten meanwhile still clears memory.
        if ('revoked' in chunk) {
          const source = items.find((item) => item.id === chunk.id)?.text;
          revoke(byId.get(chunk.id), source, chunk.revoked);
          return;
        }
        const unit = byId.get(chunk.id);
        if (!unit) return;
        sent.delete(unit);
        open.delete(unit);
        if ('error' in chunk) {
          // Held away (or its region left alone) while it was out: nothing to show, nothing
          // to resend, nothing counted.
          if (isExcluded(unit)) return;
          if (isEngineLevel(chunk.error)) engineFailed(chunk.error, [unit], used);
          else markFailed(unit, chunk.error);
          return;
        }
        if (chunk.disposition !== 'translated') {
          settled.add(unit);
          release(unit);
          return;
        }
        translations.set(unit.seg.text, chunk.text);
        failed.delete(unit);
        answered(unit);
        // Held away (or its region left alone) while it was out: memory only. Never queued, so
        // a hold right after does not take it for one about to show and hold it away again.
        if (!isExcluded(unit)) queueRender(unit, chunk.text);
      },
    );
    requests.add(request);
    void request.outcome.then((outcome) => {
      requests.delete(request);
      if (current !== epoch) return;
      inFlight -= 1;
      // Units the request never answered for (request-level failure or cancel).
      const unanswered = batch.filter((unit) => open.has(unit) && sent.has(unit));
      for (const unit of unanswered) sent.delete(unit);
      // A done request that left units unanswered: nothing is coming for them any more.
      if (outcome.status === 'done') for (const unit of unanswered) release(unit);
      if (outcome.status === 'error') onRequestError(outcome.error, unanswered, attempt, used);
      else if (outcome.status === 'cancelled') for (const unit of unanswered) pending.add(unit);
      // Halted just now: nothing more to send or report.
      if (current !== epoch) return;
      scheduleFlush();
      report();
    });
  }

  /**
   * The background took back a translation it sent early (its AI batch failed the check as
   * a whole). It goes wherever it shows or is about to: from the request's own unit in any
   * case, and, when memory holds it for `source`, from memory and every unit with that text
   * (units on their way, waiting, failed or settled show none of it and are left alone).
   * What goes is asked for again, a batch of its own in the background.
   */
  function revoke(unit: Unit | undefined, source: string | undefined, revoked: string) {
    const shows = (u: Unit) => !!renderer?.has(u) || queued.has(u) || writing.has(u);
    const gone = new Set<Unit>();
    if (unit && shows(unit)) gone.add(unit);
    if (source !== undefined && translations.get(source) === revoked) {
      translations.delete(source);
      for (const units of unitsByRoot.values()) {
        for (const u of units) if (u.seg.text === source && shows(u)) gone.add(u);
      }
    }
    for (const u of gone) {
      queued.delete(u);
      // Its entry still waiting there would render before a new one.
      for (let at = toRender.length - 1; at >= 0; at -= 1) {
        if (toRender[at]?.unit === u) toRender.splice(at, 1);
      }
      renderer?.drop(u);
      // It was shown, so the single-line rule is past; held away or in a region left alone,
      // it is only taken out.
      if (want(u, true) && inView(u.root)) showNow(u);
    }
    scheduleFlush();
    report();
  }

  /** A whole request failed: never turn that into per-paragraph errors directly. */
  function onRequestError(
    error: AppError,
    units: Unit[],
    attempt: number,
    used: Engine | undefined,
  ) {
    if (error.code === 'internal/context-invalidated') {
      halt();
      return;
    }
    if (isEngineLevel(error)) {
      engineFailed(error, units, used);
      return;
    }
    if (error.code === 'validation/payload-too-large' && units.length > 1) {
      const half = Math.ceil(units.length / 2);
      send(units.slice(0, half), attempt);
      send(units.slice(half), attempt);
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      for (const unit of units) markFailed(unit, error);
      return;
    }
    const current = epoch;
    for (const unit of units) waiting.add(unit);
    setTimeout(() => {
      if (current !== epoch) return;
      // Units forgotten while they waited (removed, rescanned) stay gone.
      const alive = units.filter((unit) => waiting.delete(unit));
      if (engineError) {
        // Paused meanwhile: back to the queue for the resume, if still in range; the rest
        // queue again when the viewport reports them. Retries count from 0 again.
        for (const unit of alive) {
          if (visibleRoots.has(unit.root)) pending.add(unit);
          else release(unit);
        }
      } else send(alive, attempt + 1);
      report();
    }, delay);
  }

  function markFailed(unit: Unit, error: AppError) {
    failed.add(unit);
    answered(unit);
    void renderer?.fail(unit, () => retry([unit]), errorText(error));
    report();
  }

  /**
   * An engine-level error pauses the session only if it came from the engine in use:
   * one from an engine switched away from ("这次先用") just sends those paragraphs again.
   */
  function engineFailed(error: AppError, units: Unit[], used: Engine | undefined) {
    if (used === engine) {
      pause(error, units);
      return;
    }
    for (const unit of units) pending.add(unit);
    scheduleFlush();
  }

  function pause(error: AppError, units: Unit[]) {
    // Held paragraphs alone have no island to say it: each paragraph's failure note does.
    if (scope === 'units') {
      for (const unit of units) markFailed(unit, error);
      return;
    }
    if (!engineError) engineError = error;
    for (const unit of units) pending.add(unit);
    // No reply is coming and the island shows the error: no dots until the pause is lifted.
    hideAllLoading();
    report();
  }

  /** The reader just asked for it (retry, hold): its dot shows at once, not after the delay. */
  function showNow(unit: Unit) {
    if (renderer && !engineError && !shown.has(unit)) {
      shown.add(unit);
      void renderer.showLoading(unit);
    }
  }

  function retry(units: Unit[]) {
    if (halted) return;
    for (const unit of units) {
      failed.delete(unit);
      pending.add(unit);
      if (!wantedAt.has(unit)) wantedAt.set(unit, now());
      // The failure note swaps for the dot.
      showNow(unit);
    }
    ensureScan();
    scheduleFlush(true);
  }

  /** The nearest block: a rescan's area, or a held paragraph's. */
  function blockOf(element: Element): Element | null {
    let el: Element | null = element;
    while (el && el !== doc.body && isInlineElement(el, readStyle)) el = el.parentElement;
    return el;
  }

  /**
   * The registered unit a freshly discovered one stands for (same root, shape and text,
   * still in the page), so its translation and state carry over; `kept` ones are taken.
   * The fresh unit was just segmented from the page, so the old one needs no segmenting
   * again (a whole-page rescan would do it for every unit in one task): the same text is
   * the same digest, a block's text is its children's, and a run must still be the same
   * nodes. Our own `et-tr` is in a run's nodes or not, and never in its text.
   */
  function known(unit: Unit, kept?: Set<Unit>): Unit | undefined {
    if (!unit.root.isConnected) return;
    const source = (nodes: Node[]) => nodes.filter((node) => node.nodeName !== OWN_TAG);
    const nodes = source(unit.nodes);
    return (unitsByRoot.get(unit.root) ?? []).find((other) => {
      if (kept?.has(other) || other.kind !== unit.kind || other.seg.text !== unit.seg.text)
        return false;
      if (other.kind === 'block') return true;
      const was = source(other.nodes);
      return was.length === nodes.length && was.every((node, index) => node === nodes[index]);
    });
  }

  /**
   * Units found again in `root` keep their registered selves (and translations); the rest
   * of the area's old units go, new ones register. Old units in this area that were not
   * found again: their text changed, their shape changed (a run became a block), or they
   * left. Only a root that was not rediscovered at all may be merely hidden (a dialog marks
   * the page aria-hidden or inert for a while): its still-present, unchanged units are kept.
   */
  function settle(root: Element, found: Unit[]) {
    const kept = new Set<Unit>();
    const fresh = found.filter((unit) => {
      const existing = known(unit, kept);
      if (existing) kept.add(existing);
      return !existing;
    });
    const foundRoots = new Set(found.map((unit) => unit.root));
    for (const [unitRoot, units] of [...unitsByRoot]) {
      if (unitRoot.isConnected && !root.contains(unitRoot)) continue;
      const mayBeHidden = unitRoot.isConnected && !foundRoots.has(unitRoot);
      for (const unit of [...units]) {
        if (kept.has(unit)) continue;
        if (mayBeHidden && renderer?.isCurrent(unit)) continue;
        forget(unit);
      }
    }
    register(fresh);
  }

  /** Re-discovers changed areas; keeps units whose text and nodes are unchanged. */
  async function rescan(elements: Element[]) {
    if (!renderer || phase === 'idle' || halted) return;
    const current = epoch;
    const roots = new Set<Element>();
    for (const element of elements) {
      // Drafts only enter units through discovery, so blocking here is enough; existing
      // units are left alone so the editor's DOM is not touched while the user types.
      if (protectedAncestor(element, doc.body)) continue;
      const el = blockOf(element);
      if (el?.isConnected) roots.add(el);
    }
    for (const root of roots) {
      if (!root.isConnected) continue;
      const found = await discoverUnits(root, {
        readStyle,
        pace: createPacer(),
        cancelled: () => current !== epoch,
      });
      if (current !== epoch) return;
      settle(root, found);
    }
    // Translations a framework threw away come back from memory, a few times at most.
    for (const unit of renderer.detached()) {
      forget(unit);
      if (allowReinsert(unit.seg.text) && unit.root.isConnected) await rescan([unit.root]);
      if (current !== epoch) return;
    }
    report();
  }

  function forget(unit: Unit) {
    const list = unitsByRoot.get(unit.root);
    if (list) {
      const index = list.indexOf(unit);
      if (index >= 0) list.splice(index, 1);
    }
    pending.delete(unit);
    sent.delete(unit);
    waiting.delete(unit);
    settled.delete(unit);
    failed.delete(unit);
    queued.delete(unit);
    writing.delete(unit);
    unnoted.delete(unit);
    wantedAt.delete(unit);
    shown.delete(unit);
    renderer?.drop(unit);
    // Long-lived pages: nothing may keep a gone unit (and its detached DOM) alive.
    const id = ids.get(unit);
    if (id !== undefined) byId.delete(id);
    ids.delete(unit);
    if (list?.length === 0) {
      unitsByRoot.delete(unit.root);
      if (!unit.root.isConnected) {
        visibleRoots.delete(unit.root);
        viewport?.unobserve(unit.root);
      }
    }
  }

  const isOwn = (node: Node): boolean => {
    let current: Node | null = node;
    while (current) {
      const name = current.nodeName;
      if (name === OWN_TAG || HOST_TAGS.includes(name)) return true;
      if (current === sheet) return true;
      current = current.parentNode;
    }
    return false;
  };

  const isLoadingDot = (node: Node): boolean =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).nodeName === OWN_TAG &&
    (node as Element).getAttribute('data-et-state') === 'loading';

  /** Context invalidated (extension updated): stop quietly, keep what is on the page. */
  function halt() {
    halted = true;
    epoch += 1;
    hideAllLoading();
    notify();
    viewport?.disconnect();
    stopWatching?.();
    try {
      stopWatchingConfig?.();
    } catch {
      // Its unsubscribe needs the extension (`storage.onChanged`), which is gone.
    }
    win.removeEventListener('scroll', onScroll, true);
  }

  function clearState() {
    for (const timer of [flushTimer, renderTimer]) if (timer !== undefined) clearTimeout(timer);
    flushTimer = undefined;
    renderTimer = undefined;
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    wantedAt.clear();
    shown.clear();
    unitsByRoot.clear();
    ids.clear();
    byId.clear();
    pending.clear();
    sent.clear();
    waiting.clear();
    settled.clear();
    failed.clear();
    queued.clear();
    writing.clear();
    visibleRoots.clear();
    translations.clear();
    reinserts.clear();
    abandoned.clear();
    toRender.length = 0;
    inFlight = 0;
    engineError = undefined;
    excludedRoots = undefined;
    unnoted.clear();
  }

  function start(options: { engine?: Engine } = {}): Promise<PageState> {
    return begin(options);
  }

  async function begin(options: { engine?: Engine }, units = false): Promise<PageState> {
    if (halted) return state();
    // Held paragraphs alone grow into the page in place: their translations and
    // requests carry on (no clearState, no new epoch).
    const grow = phase !== 'idle' && scope === 'units' && !units;
    if (
      options.engine !== undefined &&
      phase !== 'idle' &&
      (options.engine !== engine || engineError !== undefined)
    ) {
      // "这次先用 Google": switch the running session's engine and resend what is left.
      // The same engine while paused (engineError) still clears the pause.
      engine = options.engine;
      engineError = undefined;
      retry([...failed]);
      scheduleFlush(true);
      notify();
      if (!grow) return state();
    }
    if (phase !== 'idle' && !grow) return state();
    if (!grow) epoch += 1;
    const current = epoch;
    // A failed start (config unreadable) leaves nothing behind, but only its own: a
    // stale start failing late must not stop the session that replaced it.
    try {
      if (grow) {
        // Running from this moment: the isle and the dot must not take it for done.
        scope = 'page';
        phase = 'running';
        held = [];
        notify();
        deps.reportStatus('running');
        const { language } = await deps.getConfig();
        if (current !== epoch) return state();
        // Other languages since (or the held session is still setting up): the held
        // translations go, the page starts anew.
        if (
          !stopWatching ||
          language.target !== config?.language.target ||
          language.source !== config.language.source
        ) {
          await stop();
          return await begin(options);
        }
        readStyle = deps.createReadStyle();
        return await scan(current);
      }
      scope = units ? 'units' : 'page';
      clearState();
      phase = 'running';
      notify();
      // A restore still fading out must finish before new styles go in.
      if (stopping) await stopping;
      if (current !== epoch) return state();
      engine = options.engine;
      if (!units) deps.reportStatus('running');
      // Subscribe before reading: a change made while the config loads or the page is
      // scanned must not be lost. Only the style follows the setting live; language and
      // engine stay fixed for the session so one page never mixes two target languages.
      // Until the renderer exists a new style is only remembered.
      let style: ConfigV1['page']['style'] | undefined;
      stopWatchingConfig = deps.watchConfig?.((next) => {
        if (current !== epoch) return;
        // Held paragraphs alone follow the settings: other languages end them, another
        // default engine takes the next requests.
        if (scope === 'units' && config) {
          const { target, source } = next.language;
          if (target !== config.language.target || source !== config.language.source) {
            void stop();
            return;
          }
          engine = next.translation.engine;
        }
        if (next.page.style === style) return;
        style = next.page.style;
        renderer?.setStyle(style);
      });
      config = await deps.getConfig();
      if (current !== epoch) return state();
      // The session's engine is fixed from here: a later change of the default engine
      // does not reach this page. Only "这次先用" (above) can change it. Set after the
      // epoch check so a pick made while the config was loading is kept.
      engine ??= config.translation.engine;
      readStyle = deps.createReadStyle();
      sheet = injectStyles(doc);
      style ??= config.page.style;
      renderer = createRenderer({
        win,
        style,
        target: config.language.target,
        // Always the current reader: it is refreshed on every mutation round.
        readStyle: (el) => readStyle(el),
      });
      await renderer.setMode(config.page.mode);
      if (current !== epoch) return state();
      // The mode now comes from the config, not the default: push it right away.
      notify();
      win.addEventListener('scroll', onScroll, { capture: true, passive: true });
      // Watch before the initial scan: the scan yields to the page, and content added to
      // a container it has already passed would otherwise be seen by nobody. Dirty
      // elements are held until the scan is registered, then rescanned in one go
      // (rescanning during the scan would register the same text twice).
      // A start that came while this one was setting up scans the page: hold for it.
      held = scope === 'page' ? [] : undefined;
      stopWatching = watch({
        root: doc.body,
        isOwn,
        ignoreRemoved: (node) => isLoadingDot(node) || !!renderer?.removedByUs(node),
        routeKey: () => routeKeyOf(win.location),
        onDirty: (elements) => {
          leaveRoute();
          if (held) {
            held.push(...elements);
            return;
          }
          // Fresh computed styles for each round: cached ones go stale on live pages.
          readStyle = deps.createReadStyle();
          // Held paragraphs alone: nothing new is found, changed ones lose their translation.
          if (scope === 'units') prune();
          else void rescan(elements);
        },
      });
      return units ? state() : await scan(current);
    } catch (error) {
      if (current === epoch) await stop();
      throw error;
    }
  }

  /** The page scan: every unit registers, and held paragraphs keep their translation. */
  async function scan(current: number): Promise<PageState> {
    viewport = deps.createViewport(onViewportChunked);
    eager = true;
    for (const root of unitsByRoot.keys()) viewport.observe(root);
    const found = await discoverUnits(doc.body, {
      readStyle,
      pace: createPacer(),
      cancelled: () => current !== epoch,
    });
    if (current !== epoch) return state();
    settle(doc.body, found);
    // The extension may have gone while the page was being scanned: halt now (notify
    // checks) rather than rescan or flush with an extension that is gone.
    notify();
    if (current !== epoch) return state();
    const dirty = held ?? [];
    held = undefined;
    if (dirty.length > 0) {
      readStyle = deps.createReadStyle();
      void rescan(dirty);
    }
    scheduleFlush(true);
    return state();
  }

  /** Held paragraphs alone: a translation whose source changed or was thrown away goes. */
  function prune() {
    if (!renderer || halted) return;
    for (const units of [...unitsByRoot.values()]) {
      for (const unit of [...units]) if (!renderer.isCurrent(unit)) forget(unit);
    }
    for (const unit of renderer.detached()) forget(unit);
    report();
  }

  async function stop(): Promise<PageState> {
    if (phase === 'idle') return state();
    epoch += 1;
    for (const request of requests) request.cancel();
    requests.clear();
    try {
      stopWatchingConfig?.();
    } catch {
      // Same as halt: the unsubscribe may need an extension that is already gone.
    }
    stopWatchingConfig = undefined;
    viewport?.disconnect();
    viewport = undefined;
    stopWatching?.();
    stopWatching = undefined;
    win.removeEventListener('scroll', onScroll, true);
    const rendererToRestore = renderer;
    const sheetToRemove = sheet;
    sheet = undefined;
    clearState();
    excluded = new WeakMap();
    phase = 'idle';
    engine = undefined;
    // Held paragraphs alone never lit the dot.
    if (scope === 'page') deps.reportStatus('idle');
    scope = 'page';
    renderer = undefined;
    notify();
    const done = (async () => {
      await rendererToRestore?.restoreAll();
      removeStyles(sheetToRemove);
    })();
    stopping = done;
    await done;
    if (stopping === done) stopping = undefined;
    return state();
  }

  /** The block a held paragraph is looked for in, unless it holds too much source text. */
  function holdBlock(el: Element): Element | undefined {
    const block = blockOf(el);
    if (block && sourceLength(block) <= HOLD_BLOCK_CHARS) return block;
  }

  async function toggleAt({ x, y }: { x: number; y: number }) {
    if (halted) return;
    // Fresh layout reads for the block the paragraph is looked for in.
    readStyle = deps.createReadStyle();
    const range = doc.caretRangeFromPoint(x, y);
    let hit = range?.startContainer;
    // Between an element's children (a mixed block): the child at the caret.
    if (range && hit?.nodeType === 1) {
      hit = hit.childNodes[range.startOffset] ?? hit.lastChild ?? hit;
    }
    const el = hit?.nodeType === 1 ? (hit as Element) : hit?.parentElement;
    if (!hit || !el || !doc.body.contains(el)) return;
    // On a translation (or failure note): the unit it belongs to.
    const own = el.closest(OWN_TAG);
    if (!own) {
      // The whole-page scan's rules, so a held paragraph is one the scan could find.
      for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
        if (isSkipped(node)) return;
      }
    }
    // No session yet: one for held paragraphs only, if there is a paragraph to look for.
    const began = phase === 'idle';
    if (began) {
      if (own || !holdBlock(el)) return;
      // Its own session: `begin` bumps the epoch before its first await. Stopped and replaced
      // by another meanwhile, it is not this hold's any more.
      const starting = begin({}, true);
      const mine = epoch;
      await starting;
      if (epoch !== mine) return;
    }
    if (!renderer || phase === 'idle' || halted || held) return;
    // In a region left alone: the whole region (every one around the point) comes back. The
    // rest of it in range asks again once the held paragraph is dealt with, as a hold of its
    // own (asking first would make it look "on its way", and the hold would restore it).
    let freed: Element | undefined;
    for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
      if (excludedRoots?.delete(node)) freed = node;
    }
    const mine = epoch;
    try {
      await hold(el, hit, own, began);
    } finally {
      // Stopped or halted meanwhile: nothing more goes into the page.
      if (freed && epoch === mine && !halted) readmit(freed);
    }
  }

  /** toggleAt's own work on the paragraph at the point (`el`, `hit`), the session ready. */
  async function hold(el: Element, hit: Node, own: Element | null, began: boolean) {
    if (!renderer) return;
    const current = epoch;
    const contains = (unit: Unit) => unit.nodes.some((node) => node.contains(hit));
    /** The registered unit holding the point (an unchanged one, or any). */
    const holder = (unchanged: boolean) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const found = unitsByRoot
          .get(node)
          ?.find((it) => contains(it) && (!unchanged || renderer?.isCurrent(it)));
        if (found) return found;
      }
    };
    let unit = own ? renderer.unitOf(own) : undefined;
    /** Registered just now by the catch-up rescan: pending there is not "on its way". */
    let fresh = false;
    if (!own) {
      // That unit, whatever the layout says now (a span may have become a block since).
      unit = holder(true);
      if (!unit) {
        const block = holdBlock(el);
        if (!block) return;
        // The page changed since the last rescan: catch up (the same reconciliation, old
        // units go and new ones register), then take the unit that holds the point now.
        await rescan([block]);
        if (current !== epoch) return;
        unit = holder(false);
        fresh = true;
      }
    }
    if (!unit) {
      // Begun for nothing (a too-long paragraph, say): leave no trace, unless a start has
      // grown the session into the page meanwhile (that keeps the epoch).
      if (began && scope === 'units') await stop();
      return;
    }
    const { root, seg } = unit;
    if (renderer.has(unit) || queued.has(unit) || (!fresh && unfinished(unit))) {
      // Translated, about to be, or on its way: restore it and leave it alone.
      for (const set of [pending, sent, waiting, queued]) set.delete(unit);
      release(unit);
      renderer.drop(unit);
      excluded.set(root, (excluded.get(root) ?? new Set()).add(seg.text));
    } else if (failed.has(unit)) retry([unit]);
    else {
      excluded.get(root)?.delete(seg.text);
      // Pending already when the catch-up rescan found it in range.
      if (want(unit, true) || pending.has(unit)) {
        showNow(unit);
        scheduleFlush(true);
      }
    }
    report();
  }

  /**
   * Paragraphs let back in (in `area`, or anywhere): those in range ask again, too-long ones
   * found while left alone get their note. One that left the page is the rescan's to forget.
   */
  function readmit(area?: Element) {
    let added = false;
    for (const [root, units] of unitsByRoot) {
      if (!root.isConnected || (area && !area.contains(root))) continue;
      for (const unit of units) {
        if (isExcluded(unit)) continue;
        if (unnoted.delete(unit)) void renderer?.skip(unit);
        else if (visibleRoots.has(root) && want(unit)) added = true;
      }
    }
    if (added) scheduleFlush();
  }

  /**
   * Another route (a single-page app; its content changes with it): the regions left alone
   * were picked on the last one, and a container kept across routes comes back.
   */
  function leaveRoute() {
    if (excludedRoots && routeKeyOf(win.location) !== excludedRoute) {
      excludedRoots = undefined;
      readmit();
    }
  }

  /**
   * "选择不翻译的区域" (PR5): the page session leaves `root` alone. What is there goes now, as a
   * hold restores a paragraph: not sent, its translation, failure note and dot taken out (a
   * "too long" note stays: it is no translation). A request already out still answers, into
   * memory only. Whether `root` was not left alone already.
   */
  function exclude(root: Element): boolean {
    if (halted || phase === 'idle' || scope !== 'page' || root === doc.body) return false;
    // Picked on a new route the page watch has not seen yet: the last route's regions go first.
    leaveRoute();
    if (!doc.body.contains(root) || inExcludedRegion(root)) return false;
    excludedRoots ??= new WeakSet();
    excludedRoots.add(root);
    excludedRoute = routeKeyOf(win.location);
    for (const [unitRoot, units] of unitsByRoot) {
      if (!root.contains(unitRoot)) continue;
      for (const unit of units) {
        if (unit.skipped) continue;
        for (const set of [pending, sent, waiting, queued, failed]) set.delete(unit);
        release(unit);
        renderer?.drop(unit);
      }
    }
    report();
    return true;
  }

  async function region(kind: RegionKind, root: Element): Promise<boolean> {
    if (kind === 'exclude') return exclude(root);
    if (halted || (phase !== 'idle' && scope === 'page')) return false;
    // The picker checked the size already; the page may have grown since.
    if (root === doc.body || !doc.body.contains(root) || sourceLength(root) > HOLD_BLOCK_CHARS) {
      return false;
    }
    // Fresh layout reads, as the picker's: the rescan's block must not reach past `root`.
    readStyle = deps.createReadStyle();
    const began = phase === 'idle';
    let mine = epoch;
    if (began) {
      // `begin` bumps the epoch before its first await: from then on, that session is ours.
      const starting = begin({}, true);
      mine = epoch;
      await starting;
    }
    // Stopped (and maybe replaced) meanwhile, or grown into the page: not ours to change.
    if (epoch !== mine || !renderer || phase === 'idle' || halted || scope !== 'units') {
      return false;
    }
    // The same reconciliation as a hold: old units there go, new ones register.
    await rescan([root]);
    if (epoch !== mine || scope !== 'units') return false;
    let added = false;
    for (const [unitRoot, units] of unitsByRoot) {
      if (!root.contains(unitRoot)) continue;
      for (const unit of units) {
        // Held away before: picked again, it comes back.
        excluded.get(unitRoot)?.delete(unit.seg.text);
        const was = queued.has(unit);
        if (failed.has(unit)) {
          retry([unit]);
          added = true;
        } else if (want(unit)) {
          // No `chosen`: a paragraph pinned to one line stays as the page scan leaves it.
          added = true;
          // Asked for just now: the dot shows at once on what is on screen.
          if (inView(unit.root)) showNow(unit);
          // From memory: queued for rendering, no request.
        } else if (!was && queued.has(unit)) added = true;
      }
    }
    if (!added) {
      // Begun for nothing: leave no trace (still ours: no await since the check above).
      if (began) await stop();
      return false;
    }
    scheduleFlush(true);
    report();
    return true;
  }

  return {
    start,
    stop,
    toggleAt,
    region,
    async autoStart() {
      // Held paragraphs alone grow into the page like a start.
      if (phase !== 'idle' && scope !== 'units') return state();
      const { language } = await deps.getConfig();
      const inTarget = await pageIsInLanguage(language.target, {
        declared: doc.documentElement.lang,
        sample: () => sampleText(doc.body),
        detect: deps.detectLanguage,
      });
      // Detection is async: the user may have started the page meanwhile.
      if (inTarget || (phase !== 'idle' && scope !== 'units')) return state();
      return start();
    },
    // Held paragraphs alone: the page shortcut or menu grows them into the page.
    toggle: () => (phase === 'idle' || scope === 'units' ? start() : stop()),
    async setMode(mode) {
      if (!renderer || phase === 'idle') return state();
      await renderer.setMode(mode);
      notify();
      return state();
    },
    retryFailed() {
      if (engineError) {
        engineError = undefined;
        scheduleFlush(true);
      }
      retry([...failed]);
      notify();
      return state();
    },
    state,
    subscribe,
  };
}
