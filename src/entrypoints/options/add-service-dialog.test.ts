// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddServiceDialog } from './AddServiceDialog';
import styles from './options.module.css';

// The "添加服务" dialog, with config writes and the permission prompt stubbed.

const { patch, requestHostPermission } = vi.hoisted(() => ({
  patch: vi.fn(async (_changes: unknown[]) => ({ ok: true as const, data: null })),
  requestHostPermission: vi.fn(async (_pattern: string) => true),
}));

vi.mock('@/lib/config/use-config', () => ({
  useConfig: () => ({ patch, reset: vi.fn(), state: { status: 'loading' } }),
}));
vi.mock('@/lib/host-permission', () => ({ requestHostPermission }));
vi.mock('./hooks', () => ({ admin: { setSecret: vi.fn(async () => ({ ok: true })) } }));
vi.mock('./notice', () => ({ useNotice: () => ({ saved: vi.fn(), failed: vi.fn() }) }));

const ACCESS_HINT = '添加时浏览器会询问是否允许访问这个地址';
const BASE_INVALID = '请填写 https 开头的地址，本地模型可用 http://localhost';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
const onAdded = vi.fn();

function render() {
  act(() =>
    root?.render(
      createElement(AddServiceDialog, {
        open: true,
        origin: null,
        existingIds: [],
        onClose: vi.fn(),
        onAdded,
      }),
    ),
  );
}

const dialog = () => host.querySelector('dialog') as HTMLDialogElement;
const byLabel = (text: string) => {
  const label = [...dialog().querySelectorAll('label')].find((item) => item.textContent === text);
  return dialog().querySelector<HTMLInputElement>(`[id="${label?.htmlFor}"]`) as HTMLInputElement;
};
const button = (text: string) =>
  [...dialog().querySelectorAll('button')].find((item) => item.textContent === text);
const preset = (text: string) =>
  [...dialog().querySelectorAll('label')]
    .find((item) => item.textContent === text)
    ?.querySelector('input') as HTMLInputElement;

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  patch.mockClear();
  requestHostPermission.mockClear();
  onAdded.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('AddServiceDialog', () => {
  it('lays the presets and fields on the shared dialog grid', () => {
    render();
    const grid = dialog().querySelector(`.${styles.formGrid}`);
    expect(grid?.querySelector('fieldset')?.className).toContain(styles.formWide);
    const rows = [...(grid?.querySelectorAll(`:scope > .${styles.formRow}`) ?? [])];
    expect(rows.map((row) => row.querySelector('label')?.textContent)).toEqual([
      '名称',
      'Base URL',
      'API Key',
      '模型',
    ]);
  });

  it('shows the access hint for a remote address, outside the alert', async () => {
    render();
    await act(async () => preset('OpenRouter').click());
    const footer = dialog().querySelector('footer');
    expect(footer?.textContent).toContain(ACCESS_HINT);
    expect(footer?.querySelector('[role="alert"]')?.textContent).toBe('');
  });

  it('moves the focus to an address refused on submit, described by its hint', async () => {
    render();
    await act(async () => preset('其他').click());
    await type(byLabel('Base URL'), 'ftp://example.com');
    await type(byLabel('模型'), 'gpt');
    const submit = button('添加') as HTMLButtonElement;
    submit.focus();
    await act(async () => submit.click());

    const base = byLabel('Base URL');
    expect(base.getAttribute('aria-invalid')).toBe('true');
    const described = base.getAttribute('aria-describedby');
    expect(described && dialog().querySelector(`[id="${described}"]`)?.textContent).toBe(
      BASE_INVALID,
    );
    expect(document.activeElement).toBe(base);
    expect(patch).not.toHaveBeenCalled();
  });

  it('adds the preset service, asking for access to its address', async () => {
    render();
    await type(byLabel('模型'), 'qwen3');
    await act(async () => (button('添加') as HTMLButtonElement).click());
    expect(requestHostPermission).toHaveBeenCalledWith('http://localhost/*');
    expect(patch).toHaveBeenCalledWith([
      {
        path: 'customProviders',
        key: expect.any(String),
        add: { name: expect.any(String), baseURL: 'http://localhost:11434/v1', model: 'qwen3' },
      },
    ]);
    expect(onAdded).toHaveBeenCalledWith(expect.any(String), true);
  });
});
