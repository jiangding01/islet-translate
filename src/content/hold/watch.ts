import type { ConfigV1, HoldKey } from '@/lib/config/types';
import { PALETTE_TAG } from '../dom-rules';
import { deepActiveElement, isOwnNode } from '../selection/watch';

// The always-loaded half of hold-to-toggle (M3b plan, sections 4 and 6): holding the chosen
// modifier (Ctrl or Alt, `page.holdKey`) with the pointer at rest asks for the paragraph
// under it to be toggled. Only the pointer position and the key state are kept here;
// nothing reads the page or loads anything. The whole trigger rule lives in this file so it
// can be replaced on its own.

/**
 * How long the key (Ctrl or Alt) must be held with the pointer at rest. 400 ms (the plan's first value)
 * proved easy to trigger by accident on a real Mac (2026-11-20); 600 ms is the plan's
 * fallback. Next step if that is still too eager: a double press of the modifier.
 */
export const HOLD_MS = 600;
/** Pointer travel (summed) while held that restarts the count. */
export const STILL_PX = 6;

const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/;

/**
 * Focus where the key starts a text shortcut (Ctrl+A, Ctrl+←, ⌥←): a text field or editable
 * content. A focused checkbox, slider or button takes no typing, so it does not count. Focus
 * in the palette (its input, behind a closed shadow root: the host is what shows) is typing.
 */
function isTypingFocus(doc: Document): boolean {
  const active = deepActiveElement(doc);
  if (active?.nodeName === PALETTE_TAG) return true;
  if (active?.nodeName === 'INPUT') return TEXT_INPUT.test((active as HTMLInputElement).type);
  return (
    active?.nodeName === 'TEXTAREA' || (active as HTMLElement | null)?.isContentEditable === true
  );
}

export interface HoldWatchDeps {
  doc: Document;
  /** The key was held still at this viewport point; called once per press. */
  onHold(point: { x: number; y: number }): void;
  /**
   * `page.holdKey` decides the key; nothing is listened to until it is read, or when off.
   * If the read fails, nothing is listened to until a change is pushed.
   */
  getConfig(): Promise<ConfigV1>;
  watchConfig(callback: (config: ConfigV1) => void): () => void;
  /**
   * Whether an event came from the user; page scripts can forge the rest. Defaults to
   * `event.isTrusted` (test DOMs dispatch only untrusted events).
   */
  isTrusted?(event: Event): boolean;
}

export interface HoldWatch {
  start(): void;
  stop(): void;
}

export function createHoldWatch({
  doc,
  onHold,
  getConfig,
  watchConfig,
  isTrusted = (event) => event.isTrusted,
}: HoldWatchDeps): HoldWatch {
  const win = doc.defaultView;
  /** The last pointer position; unknown until the pointer moves (again, after a blur). */
  let point: { x: number; y: number } | undefined;
  /** The last pointer event's buttons: key events carry none. */
  let buttons = 0;
  /** What the pointer last moved over; looked at only when it matters. */
  let over: EventTarget | null = null;
  /** `fired` or `done` (voided): nothing more until the key is released. */
  let press: 'up' | 'timing' | 'fired' | 'done' = 'up';
  let moved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /** The key listened to (Alt when true, Ctrl when false); undefined while not listening. */
  let alt: boolean | undefined;
  let unwatch: (() => void) | undefined;

  const end = (next: typeof press) => {
    clearTimeout(timer);
    timer = undefined;
    press = next;
  };
  const voidPress = () => {
    if (press === 'timing') end('done');
  };
  /** Over the isle or the selection card, or typing somewhere: not a paragraph toggle. */
  const busy = () => isOwnNode(over as Node | null) || isTypingFocus(doc);
  const count = () => {
    clearTimeout(timer);
    moved = 0;
    timer = setTimeout(() => {
      const at = busy() ? undefined : point;
      end(at ? 'fired' : 'done');
      if (at) onHold(at);
    }, HOLD_MS);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTrusted(event)) return;
    if (event.key !== (alt ? 'Alt' : 'Control')) return voidPress();
    // A repeat is the key held from before (Ctrl+Tab back to this tab): not a new press.
    if (press !== 'up' || event.repeat) return;
    if (
      !point ||
      buttons !== 0 ||
      // Joining other modifiers (⌃⌘Space, ⌃⇧⌘4, Shift then Ctrl+Tab): a shortcut.
      event.shiftKey ||
      (alt ? event.ctrlKey : event.altKey) ||
      event.metaKey ||
      event.isComposing ||
      event.keyCode === 229 ||
      busy()
    ) {
      press = 'done';
      return;
    }
    press = 'timing';
    count();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== (alt ? 'Alt' : 'Control')) return;
    // Windows moves focus to Chrome's menu button when a lone Alt is released.
    if (alt && press === 'fired') event.preventDefault();
    end('up');
  };
  const onMove = (event: PointerEvent) => {
    if (!isTrusted(event)) return;
    buttons = event.buttons;
    over = event.target;
    if (point) moved += Math.hypot(event.clientX - point.x, event.clientY - point.y);
    point = { x: event.clientX, y: event.clientY };
    // The key is not down after all: its keyup was lost.
    if (!(alt ? event.altKey : event.ctrlKey)) end('up');
    else if (press === 'timing' && moved > STILL_PX) count();
  };
  const onDown = (event: PointerEvent) => {
    buttons = event.buttons;
    voidPress();
  };
  const onUp = (event: PointerEvent) => {
    buttons = event.buttons;
  };
  const onOut = (event: PointerEvent) => {
    if (event.relatedTarget) return;
    point = undefined;
    voidPress();
  };
  /** Focus or the tab went away: keys may be lost, and the pointer may be anywhere now. */
  const onLost = () => {
    point = undefined;
    end('up');
  };

  const listen = { capture: true, passive: true } as const;
  const docEvents = [
    ['keydown', onKeyDown],
    ['pointermove', onMove],
    ['pointerdown', onDown],
    ['pointerup', onUp],
    ['pointerout', onOut],
    ['wheel', voidPress],
    ['visibilitychange', onLost],
  ] as [string, EventListener][];
  /** Listens to the key `holdKey` names, switching or detaching as it changes. */
  const use = (holdKey: HoldKey) => {
    const next = holdKey === 'off' ? undefined : holdKey === 'alt';
    if (next === alt) return;
    const method = next === undefined ? 'removeEventListener' : 'addEventListener';
    // Attach when starting to listen, detach when stopping; a key switch keeps them.
    if ((alt === undefined) !== (next === undefined)) {
      for (const [type, listener] of docEvents) doc[method](type, listener, listen);
      // Not passive: a fired press's keyup is prevented.
      doc[method]('keyup', onKeyUp as EventListener, true);
      win?.[method]('blur', onLost, listen);
    }
    alt = next;
    point = undefined;
    end('up');
  };

  return {
    start() {
      if (running) return;
      running = true;
      let pushed = false;
      try {
        // Subscribe first so a change between the read and the subscription is not lost.
        unwatch = watchConfig((config) => {
          pushed = true;
          if (running) use(config.page.holdKey);
        });
      } catch {
        // Extension context already gone: the read below fails too.
      }
      getConfig().then(
        // A setting pushed while the read was out is newer than the read.
        (config) => running && !pushed && use(config.page.holdKey),
        // Unread: stay detached until a change is pushed.
        () => {},
      );
    },
    stop() {
      if (!running) return;
      running = false;
      // Detach first: once the extension is reloaded, unsubscribing throws.
      use('off');
      try {
        unwatch?.();
      } catch {
        // Nothing left to unsubscribe from.
      }
      unwatch = undefined;
    },
  };
}
