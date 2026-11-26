// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogShell } from './DialogShell';

// The dialog frame shared by the settings pages: opening, closing, the footer status line.

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
const onOpen = vi.fn();
const onClose = vi.fn();
const onSubmit = vi.fn();
const field = createRef<HTMLInputElement>();

interface Options {
  open?: boolean;
  busy?: boolean;
  error?: string;
  hint?: string;
  submitLabel?: string | null;
  onCancel?: () => void;
}

function render({
  open = true,
  busy = false,
  error,
  hint,
  submitLabel = '保存',
  onCancel,
}: Options = {}) {
  act(() =>
    root?.render(
      createElement(
        DialogShell,
        {
          open,
          origin: null,
          title: '标题',
          busy,
          initialFocus: field,
          onOpen,
          onClose,
          onSubmit,
          error,
          hint,
          cancelLabel: '取消',
          onCancel,
          submitLabel: submitLabel ?? undefined,
          submitDisabled: false,
        },
        createElement('input', { ref: field, required: true, defaultValue: '' }),
      ),
    ),
  );
}

const dialog = () => host.querySelector('dialog') as HTMLDialogElement;
const alert = () => dialog().querySelector('[role="alert"]');
const button = (text: string) =>
  [...dialog().querySelectorAll('button')].find((item) => item.textContent === text);

function press(target: Element, type: 'pointerdown' | 'click') {
  act(() => {
    target.dispatchEvent(
      type === 'click'
        ? new MouseEvent('click', { bubbles: true, cancelable: true })
        : new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
  });
}

function pressEscape(target: Element) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onOpen.mockClear();
  onClose.mockClear();
  onSubmit.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('DialogShell: opening', () => {
  it('resets the draft once per opening and focuses the given field', () => {
    render({ open: false });
    expect(dialog().open).toBe(false);
    render();
    expect(dialog().open).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field.current);
    render({ busy: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    render({ open: false });
    expect(dialog().open).toBe(false);
  });

  it('names the dialog after its title', () => {
    render();
    const id = dialog().getAttribute('aria-labelledby');
    expect(id && host.querySelector(`[id="${id}"]`)?.textContent).toBe('标题');
  });
});

describe('DialogShell: the status line', () => {
  it('keeps one alert mounted and only replaces its text', () => {
    render({ hint: '提示' });
    const mounted = alert();
    expect(mounted?.textContent).toBe('');
    expect(dialog().querySelector('footer')?.textContent).toContain('提示');

    render({ hint: '提示', error: '保存失败' });
    expect(alert()).toBe(mounted);
    expect(mounted?.textContent).toBe('保存失败');
    // The hint gives way to the error, and is never part of what gets announced.
    expect(dialog().querySelector('footer')?.textContent).not.toContain('提示');

    render({ hint: '提示' });
    expect(alert()).toBe(mounted);
    expect(mounted?.textContent).toBe('');
  });
});

describe('DialogShell: closing', () => {
  it('closes on a press that starts and ends on the backdrop', () => {
    render();
    press(dialog(), 'pointerdown');
    press(dialog(), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when a text selection is dragged out of a field onto the backdrop', () => {
    render();
    // The click of such a drag lands on the common ancestor: the dialog element.
    press(field.current as HTMLInputElement, 'pointerdown');
    press(dialog(), 'click');
    expect(onClose).not.toHaveBeenCalled();
    // The next real backdrop press still closes it.
    press(dialog(), 'pointerdown');
    press(dialog(), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the backdrop and the buttons while busy, and stops Esc at the key', () => {
    render({ busy: true });
    press(dialog(), 'pointerdown');
    press(dialog(), 'click');
    expect(onClose).not.toHaveBeenCalled();
    expect(button('取消')?.disabled).toBe(true);
    expect(dialog().querySelector<HTMLButtonElement>('button[aria-label]')?.disabled).toBe(true);
    // Stopped at the key, not only at `cancel`: Chrome stops honouring a prevented cancel after
    // the first one. That rule itself is only in a real browser: see ui.e2e.test.ts.
    expect(pressEscape(field.current as HTMLInputElement).defaultPrevented).toBe(true);
    // Also with the focus outside the dialog: Save, disabled while saving, can lose it.
    expect(pressEscape(document.body).defaultPrevented).toBe(true);
  });

  it('ignores a late close event that arrives after the dialog opened again', () => {
    render();
    // The native close event is queued; here it lands while the dialog is open again.
    act(() => {
      dialog().dispatchEvent(new Event('close'));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
    // Closed for real (Esc), it is passed on.
    act(() => {
      dialog().close();
      dialog().dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves Esc to the browser when idle', () => {
    render();
    expect(pressEscape(field.current as HTMLInputElement).defaultPrevented).toBe(false);
    expect(pressEscape(document.body).defaultPrevented).toBe(false);
  });
});

describe('DialogShell: submitting', () => {
  it('turns off the browser bubbles: an empty required field still reaches the page checks', () => {
    render();
    expect(dialog().querySelector('form')?.noValidate).toBe(true);
    act(() => button('保存')?.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('DialogShell: footer variants (M4-D)', () => {
  it('has no submit button without a submit label', () => {
    render({ submitLabel: null });
    expect(dialog().querySelector('button[type="submit"]')).toBeNull();
    expect(button('取消')).toBeDefined();
  });

  it('runs its own cancel action instead of closing when given one', () => {
    const back = vi.fn();
    render({ onCancel: back });
    act(() => button('取消')?.click());
    expect(back).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
