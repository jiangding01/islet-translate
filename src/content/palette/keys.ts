// The palette input's keys (docs/plans/m3c.md decision 4), as a pure function so the rules
// are tested without a DOM. Everything else typed is text for the input.

/** `back`: Escape (closes one layer); `parent`: back to the commands from the engine list. */
export type KeyAction = 'up' | 'down' | 'run' | 'back' | 'parent' | 'stay';

/**
 * What a keydown in the input means, or undefined for plain typing. While an input method
 * is composing (`isComposing`, or the 229 "Process" key some send first), every key is the
 * input method's: Enter commits the text, the arrows pick a candidate, Escape cancels.
 */
export function keyAction(
  event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>,
  /** In the engine list with nothing typed: ← and Backspace go back to the commands. */
  emptySubList = false,
): KeyAction | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (emptySubList && (event.key === 'ArrowLeft' || event.key === 'Backspace')) return 'parent';
  switch (event.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Enter':
      return 'run';
    case 'Escape':
      return 'back';
    // Focus stays inside the palette: there is nothing else to tab to.
    case 'Tab':
      return 'stay';
    default:
      return undefined;
  }
}

/** The next enabled row from `from` (-1: none yet) moving by `step`, wrapping; -1 if none. */
export function moveActive(disabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = disabled.length;
  for (let i = 1; i <= n; i += 1) {
    const at = (((from + step * i) % n) + n) % n;
    if (!disabled[at]) return at;
  }
  return -1;
}
