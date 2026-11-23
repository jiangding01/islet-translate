import { deepActiveElement } from '../selection/watch';

// What the palette takes from the page when it opens and hands back when it closes
// (docs/plans/m3c.md decision 4): the focused element and the selection.

export interface SavedFocus {
  /** The focused element (inside open shadow roots; an iframe when focus is in a frame). */
  element: Element | null;
  /** A copy of the page's selection, when there was one. */
  range?: Range;
}

export function saveFocus(doc: Document): SavedFocus {
  let range: Range | undefined;
  try {
    const selection = doc.getSelection();
    if (selection && selection.rangeCount > 0) range = selection.getRangeAt(0).cloneRange();
  } catch {
    // No readable selection: nothing to hand back.
  }
  return { element: deepActiveElement(doc), range };
}

/** A text field keeps its own caret: the page selection is not put back over it. */
const isTextControl = (element: Element | null) =>
  element?.nodeName === 'INPUT' || element?.nodeName === 'TEXTAREA';

/**
 * Focuses the saved element again (not when it left the document: focus then stays where
 * the browser puts it) and restores the selection if its nodes are still there. An iframe
 * gets the focus back as an element; the frame keeps its own focused element.
 */
export function restoreFocus(doc: Document, saved: SavedFocus): void {
  const { element, range } = saved;
  if (element?.isConnected && element !== doc.body) {
    try {
      (element as HTMLElement).focus?.({ preventScroll: true });
    } catch {
      // Not focusable any more.
    }
  }
  if (!range || isTextControl(element)) return;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return;
  try {
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // The page's selection could not be set: leave it.
  }
}
