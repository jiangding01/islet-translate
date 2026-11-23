// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { restoreFocus, saveFocus } from './focus';

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

function selectText(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

describe('saveFocus / restoreFocus', () => {
  it('gives the focus back to the element that had it', () => {
    document.body.innerHTML = '<input id="a"><button id="b">x</button>';
    const input = document.getElementById('a') as HTMLInputElement;
    input.focus();
    const saved = saveFocus(document);
    (document.getElementById('b') as HTMLElement).focus();
    restoreFocus(document, saved);
    expect(document.activeElement).toBe(input);
  });

  it('does not focus an element that left the document', () => {
    document.body.innerHTML = '<input id="a"><button id="b">x</button>';
    const input = document.getElementById('a') as HTMLInputElement;
    input.focus();
    const saved = saveFocus(document);
    const button = document.getElementById('b') as HTMLElement;
    button.focus();
    input.remove();
    restoreFocus(document, saved);
    expect(document.activeElement).toBe(button);
  });

  it('puts the page selection back', () => {
    document.body.innerHTML = '<p id="p">Some selected words</p><input id="i">';
    const paragraph = document.getElementById('p') as HTMLElement;
    selectText(paragraph);
    const saved = saveFocus(document);
    document.getSelection()?.removeAllRanges();
    restoreFocus(document, saved);
    expect(document.getSelection()?.toString()).toBe('Some selected words');
  });

  it('skips a selection whose nodes were removed', () => {
    document.body.innerHTML = '<p id="p">Gone soon</p>';
    const paragraph = document.getElementById('p') as HTMLElement;
    selectText(paragraph);
    const saved = saveFocus(document);
    document.getSelection()?.removeAllRanges();
    paragraph.remove();
    restoreFocus(document, saved);
    expect(document.getSelection()?.rangeCount).toBe(0);
  });

  it('gives a frame the focus back as an element (the frame keeps its own focus)', () => {
    document.body.innerHTML = '<iframe id="f"></iframe><button id="b">x</button>';
    const frame = document.getElementById('f') as HTMLIFrameElement;
    const saved = { element: frame as Element };
    let focused = 0;
    frame.focus = () => {
      focused += 1;
    };
    restoreFocus(document, saved);
    expect(focused).toBe(1);
  });

  it('leaves a text field its own caret: no page selection is set over it', () => {
    document.body.innerHTML = '<p id="p">Text</p><input id="a">';
    selectText(document.getElementById('p') as HTMLElement);
    const input = document.getElementById('a') as HTMLInputElement;
    const saved = { element: input as Element, range: document.getSelection()?.getRangeAt(0) };
    document.getSelection()?.removeAllRanges();
    restoreFocus(document, saved);
    expect(document.activeElement).toBe(input);
    expect(document.getSelection()?.rangeCount).toBe(0);
  });
});
