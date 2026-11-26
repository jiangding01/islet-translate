// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import { type ConfigV1, MAX_CUSTOM_STYLES } from '@/lib/config/types';
import { customStyleEntries, StylesPage } from './StylesPage';

// The translation styles page (M4-B), with config writes stubbed.

const { patch } = vi.hoisted(() => ({
  patch: vi.fn(async (_changes: unknown[]) => ({ ok: true as const, data: null })),
}));

vi.mock('@/lib/config/use-config', () => ({
  useConfig: () => ({ patch, reset: vi.fn(), state: { status: 'loading' } }),
}));
vi.mock('./notice', () => ({ useNotice: () => ({ saved: vi.fn(), failed: vi.fn() }) }));

const PRESET_NAMES = ['通用', '技术文档', '学术论文', '口语化', '文学意译'];
const GOOGLE_NOTE = '当前默认引擎是 Google 翻译，风格只在使用 AI 引擎时生效';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;

function configWith(edit: (config: ConfigV1) => void = () => undefined): ConfigV1 {
  const config = createDefaultConfig('zh-CN');
  edit(config);
  return config;
}

function render(config: ConfigV1) {
  act(() => root?.render(createElement(StylesPage, { config })));
}

const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const cardNames = () => radios().map((radio) => radio.parentElement?.children[1]?.textContent);
const checked = () => radios().find((radio) => radio.checked)?.value;
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent === text);
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const dialog = () => host.querySelector('dialog');

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  patch.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('StylesPage: cards', () => {
  it('shows the five presets in order, inside one radio group, with the current one checked', () => {
    render(configWith());
    expect(cardNames()).toEqual(PRESET_NAMES);
    expect(host.querySelector('fieldset legend')?.textContent).toBe('翻译风格');
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
    expect(checked()).toBe('general');
    render(
      configWith((config) => {
        config.translation.style = 'literary';
      }),
    );
    expect(checked()).toBe('literary');
  });

  it('patches the style when a card is chosen, and not when it is already chosen', async () => {
    render(configWith());
    await click(radios().find((radio) => radio.value === 'tech'));
    expect(patch).toHaveBeenCalledWith([{ path: 'translation.style', value: 'tech' }]);
    patch.mockClear();
    await click(radios().find((radio) => radio.value === 'general'));
    expect(patch).not.toHaveBeenCalled();
  });

  it('shows custom styles after the presets, with edit and delete buttons outside the label', () => {
    render(
      configWith((config) => {
        config.customStyles['style-aaaaaaaa'] = { name: '简洁', description: '多用短句' };
      }),
    );
    expect(cardNames()).toEqual([...PRESET_NAMES, '简洁']);
    const edit = byLabel('编辑「简洁」');
    const remove = byLabel('删除「简洁」');
    expect(edit).not.toBeNull();
    expect(remove).not.toBeNull();
    expect(edit?.closest('label')).toBeNull();
    expect(remove?.closest('label')).toBeNull();
  });

  it('skips malformed custom entries', () => {
    render(
      configWith((config) => {
        const records = config.customStyles as Record<string, unknown>;
        records['style-aaaaaaaa'] = { name: '好', description: 'ok' };
        records['style-bbbbbbbb'] = { name: '缺说明' };
        records['style-cccccccc'] = { name: 1, description: 'x' };
        records['style-dddddddd'] = 'text';
        records['custom-aaaaaaaa'] = { name: '错的前缀', description: 'x' };
      }),
    );
    expect(cardNames()).toEqual([...PRESET_NAMES, '好']);
    expect(customStyleEntries(configWith())).toEqual([]);
  });

  it('shows the Google note only while Google is the default engine', () => {
    render(configWith());
    expect(host.textContent).toContain(GOOGLE_NOTE);
    render(
      configWith((config) => {
        config.translation.engine = 'openai';
      }),
    );
    expect(host.textContent).not.toContain(GOOGLE_NOTE);
  });

  it(`disables adding at ${MAX_CUSTOM_STYLES} custom styles and says why`, () => {
    render(configWith());
    expect(button('添加风格')?.hasAttribute('disabled')).toBe(false);
    render(
      configWith((config) => {
        for (let index = 0; index < MAX_CUSTOM_STYLES; index += 1) {
          config.customStyles[`style-${String(index).padStart(8, '0')}`] = {
            name: `s${index}`,
            description: 'd',
          };
        }
      }),
    );
    expect(button('添加风格')?.hasAttribute('disabled')).toBe(true);
    expect(host.textContent).toContain('最多 10 个自定义风格');
  });
});

describe('StylesPage: deleting', () => {
  const withCustom = (current: boolean) =>
    configWith((config) => {
      config.customStyles['style-aaaaaaaa'] = { name: '简洁', description: '多用短句' };
      if (current) config.translation.style = 'style-aaaaaaaa';
    });

  it('asks first, with the plain note, and removes on confirmation', async () => {
    render(withCustom(false));
    await click(byLabel('删除「简洁」'));
    expect(patch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('删除后无法恢复');
    expect(host.textContent).not.toContain('这是当前使用的风格');
    await click(button('取消'));
    expect(host.textContent).not.toContain('删除后无法恢复');
    await click(byLabel('删除「简洁」'));
    await click(button('确认删除'));
    expect(patch).toHaveBeenCalledWith([
      { path: 'customStyles', key: 'style-aaaaaaaa', remove: true },
    ]);
  });

  it('says the current style falls back to general', async () => {
    render(withCustom(true));
    await click(byLabel('删除「简洁」'));
    expect(host.textContent).toContain('这是当前使用的风格，删除后改用「通用」');
    expect(host.textContent).not.toContain('删除后无法恢复');
  });
});

describe('StylesPage: the dialog', () => {
  const save = () =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === '保存');
  const nameInput = () => dialog()?.querySelector('input') as HTMLInputElement;
  const descriptionInput = () => dialog()?.querySelector('textarea') as HTMLTextAreaElement;

  it('shows no empty hint when a field is only left, so one click on Cancel closes', async () => {
    render(configWith());
    await click(button('添加风格'));
    // Leaving the empty fields must not add lines that push Cancel down under the pointer.
    await act(async () => {
      nameInput().focus();
      descriptionInput().focus();
      descriptionInput().blur();
    });
    expect(dialog()?.textContent).not.toContain('请填写');
    const cancel = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (item) => item.textContent === '取消',
    );
    await click(cancel);
    expect(dialog()?.open).toBe(false);
  });

  it('keeps saving disabled until both fields have text, and counts the description', async () => {
    render(configWith());
    await click(button('添加风格'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('添加风格');
    expect(save()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain('0 / 500');
    // No empty hint on a fresh dialog.
    expect(dialog()?.textContent).not.toContain('请填写名称');

    await type(nameInput(), '   ');
    expect(save()?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain('请填写名称');
    await type(descriptionInput(), ' \n ');
    expect(dialog()?.textContent).toContain('请填写风格说明');
    expect(dialog()?.textContent).toContain('3 / 500');

    await type(nameInput(), ' 简洁 ');
    await type(descriptionInput(), '多用短句😀');
    expect(dialog()?.textContent).toContain('6 / 500');
    expect(dialog()?.textContent).not.toContain('请填写');
    expect(save()?.disabled).toBe(false);
    expect(nameInput().maxLength).toBe(20);
    expect(descriptionInput().maxLength).toBe(500);

    await click(save());
    const [changes] = patch.mock.calls[0] ?? [];
    expect(changes).toEqual([
      {
        path: 'customStyles',
        key: expect.stringMatching(/^style-[a-z0-9]{8}$/),
        add: { name: '简洁', description: '多用短句😀' },
      },
    ]);
  });

  it('edits a custom style in place', async () => {
    render(
      configWith((config) => {
        config.customStyles['style-aaaaaaaa'] = { name: '简洁', description: '多用短句' };
      }),
    );
    await click(byLabel('编辑「简洁」'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('编辑风格');
    expect(nameInput().value).toBe('简洁');
    expect(descriptionInput().value).toBe('多用短句');
    await type(descriptionInput(), '更短');
    await click(save());
    expect(patch).toHaveBeenCalledWith([
      {
        path: 'customStyles',
        key: 'style-aaaaaaaa',
        update: { name: '简洁', description: '更短' },
      },
    ]);
    // The closing dialog keeps its title while it fades out.
    expect(dialog()?.querySelector('h2')?.textContent).toBe('编辑风格');
  });

  it('ties each empty hint to its field for screen readers', async () => {
    render(configWith());
    await click(button('添加风格'));
    expect(nameInput().getAttribute('aria-describedby')).toBeNull();
    await type(nameInput(), ' ');
    await type(descriptionInput(), ' ');
    const describedBy = (element: Element) =>
      (element.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent);
    expect(describedBy(nameInput())).toEqual(['请填写名称']);
    expect(describedBy(descriptionInput())).toEqual(['请填写风格说明', '1 / 500']);
  });

  it('stays open and shows the error when the style was removed elsewhere', async () => {
    render(
      configWith((config) => {
        config.customStyles['style-aaaaaaaa'] = { name: '简洁', description: '多用短句' };
      }),
    );
    patch.mockResolvedValueOnce({
      ok: false,
      error: { code: 'config/style-missing', message: 'Custom style not found' },
    } as never);
    await click(byLabel('编辑「简洁」'));
    await type(descriptionInput(), '更短');
    await click(save());
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.textContent).toContain('这个风格已被删除');
  });

  it('refuses a new style once the limit is reached elsewhere, without writing', async () => {
    const config = configWith((value) => {
      for (let index = 0; index < MAX_CUSTOM_STYLES - 1; index += 1) {
        value.customStyles[`style-aaaaaaa${index}`] = { name: `S${index}`, description: 'x' };
      }
    });
    render(config);
    await click(button('添加风格'));
    await type(nameInput(), '新的');
    await type(descriptionInput(), '多用短句');
    // Another page adds the tenth style while this dialog is open.
    render(
      configWith((value) => {
        Object.assign(value.customStyles, config.customStyles);
        value.customStyles['style-bbbbbbbb'] = { name: 'B', description: 'x' };
      }),
    );
    await click(save());
    expect(patch).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain(`最多 ${MAX_CUSTOM_STYLES} 个自定义风格`);
  });
});
