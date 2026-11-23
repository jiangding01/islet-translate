import type { PageState } from '@/lib/messaging/protocol';

// Readings of a page session's state shared by the isle and the palette, so the two never
// disagree on when a button or a command applies. Side-effect free: bundled into both
// on-demand modules.

/** A whole-page session that is still alive (not idle, halted or held paragraphs only). */
export function isActive(state: PageState): boolean {
  return state.phase !== 'idle' && !state.halted && state.scope !== 'units';
}

/** Failed paragraphs or an engine-level error: the dot turns coral and "Retry" shows. */
export function hasRetry(state: PageState): boolean {
  return state.failed > 0 || !!state.engineError;
}
