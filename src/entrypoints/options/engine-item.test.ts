// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1, Engine } from '@/lib/config/types';
import { EngineItem } from './EngineItem';

// The engine panel's thinking switch and extra request body (M4-A), with the background
// calls stubbed: `patch` (config writes) and `admin.test` (the connection test).

const { patch, test } = vi.hoisted(() => ({
  patch: vi.fn(async (_changes: unknown[]) => ({ ok: true as const, data: null })),
  test: vi.fn(async (_draft: unknown) => ({
    ok: true as const,
    data: { latencyMs: 5, text: '你好，世界。' },
  })),
}));

vi.mock('@/lib/config/use-config', () => ({
  useConfig: () => ({ patch, reset: vi.fn(), state: { status: 'loading' } }),
}));
vi.mock('./hooks', () => ({ admin: { test, setSecret: vi.fn() } }));
vi.mock('@/lib/host-permission', () => ({
  useHostPermission: () => true,
  requestHostPermission: vi.fn(),
}));
vi.mock('./notice', () => ({ useNotice: () => ({ saved: vi.fn(), failed: vi.fn() }) }));

const CUSTOM = 'custom-aaaaaaaa';
const MINIMUM = '该模型无法完全关闭思考，关闭时使用最低档。';
const INVALID = '需要是一个 JSON 对象，例如 {"key": "value"}。';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;

function configWith(edit: (config: ConfigV1) => void = () => undefined): ConfigV1 {
  const config = createDefaultConfig('zh-CN');
  config.customProviders[CUSTOM] = { name: 'A', baseURL: 'https://llm.example.com/v1', model: 'q' };
  edit(config);
  return config;
}

function render(engine: Engine, config: ConfigV1) {
  const custom = config.customProviders[engine];
  const element = createElement(EngineItem, {
    entry: { id: engine, name: engine, custom },
    config,
    isDefault: false,
    expanded: true,
    fresh: false,
    secret: { configured: true, last4: '1234' },
    onToggle: vi.fn(),
    onMakeDefault: vi.fn(),
    onSecretsChanged: vi.fn(),
    onDelete: vi.fn(async () => undefined),
  });
  act(() => root?.render(element));
}

const thinkingHint = () => {
  const group = host.querySelector('fieldset');
  const id = group?.getAttribute('aria-describedby');
  return group ? (host.querySelector(`[id="${id}"]`)?.textContent ?? '') : undefined;
};
const textarea = () => host.querySelector('textarea');
const baseInput = () => host.querySelector<HTMLInputElement>('input[id$="-base"]');
const BASE_INVALID = '请填写 https 开头的地址，本地模型可用 http://localhost';
/** Text of the elements an input's aria-describedby points at. */
const descriptions = (element: Element | null) =>
  (element?.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => host.querySelector(`[id="${id}"]`)?.textContent);
const testButton = () =>
  [...host.querySelectorAll('button')].find((button) => button.textContent === '测试连接');

async function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  patch.mockClear();
  test.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('EngineItem: thinking switch', () => {
  it('shows the switch only when the rule table covers the saved model and address', () => {
    render('openai', configWith());
    expect(thinkingHint()).toContain(MINIMUM);
    render(
      'openai',
      configWith((config) => {
        config.providers.openai.model = 'gpt-5.1';
      }),
    );
    expect(thinkingHint()).not.toContain(MINIMUM);
    render(
      'openai',
      configWith((config) => {
        config.providers.openai.model = 'gpt-4o';
      }),
    );
    expect(thinkingHint()).toBeUndefined();
    render(
      'openai',
      configWith((config) => {
        config.providers.openai.baseURL = 'https://proxy.example.com/v1';
      }),
    );
    expect(thinkingHint()).toBeUndefined();
  });

  it('follows the saved Gemini model, and always shows it for DeepSeek', () => {
    render('gemini', configWith());
    expect(thinkingHint()).toBeUndefined();
    render(
      'gemini',
      configWith((config) => {
        config.providers.gemini.model = 'gemini-2.5-flash';
      }),
    );
    expect(thinkingHint()).not.toContain(MINIMUM);
    render(
      'gemini',
      configWith((config) => {
        config.providers.gemini.model = 'gemini-2.5-pro';
      }),
    );
    expect(thinkingHint()).toContain(MINIMUM);
    render('deepseek', configWith());
    expect(thinkingHint()).not.toContain(MINIMUM);
    render('google', configWith());
    expect(thinkingHint()).toBeUndefined();
    render(CUSTOM, configWith());
    expect(thinkingHint()).toBeUndefined();
  });

  it('writes the thinking switch of its own engine', () => {
    render('openai', configWith());
    act(() => host.querySelector<HTMLInputElement>('fieldset input')?.click());
    expect(patch).toHaveBeenLastCalledWith([{ path: 'providers.openai.thinking', value: true }]);
  });

  it('tests with the saved thinking switch', async () => {
    render(
      'gemini',
      configWith((config) => {
        config.providers.gemini.model = 'gemini-2.5-flash';
        config.providers.gemini.thinking = true;
      }),
    );
    await act(async () => testButton()?.click());
    expect(test).toHaveBeenLastCalledWith(
      expect.objectContaining({ engine: 'gemini', model: 'gemini-2.5-flash', thinking: true }),
    );
  });
});

describe('EngineItem: extra request body', () => {
  it('is offered for OpenAI and custom providers only', () => {
    for (const engine of ['openai', CUSTOM] as const) {
      render(engine, configWith());
      expect(textarea()).not.toBeNull();
      const label = host.querySelector(`label[for="${textarea()?.id}"]`);
      expect(label?.textContent).toBe('额外请求参数（JSON）');
    }
    for (const engine of ['google', 'deepseek', 'gemini'] as const) {
      render(engine, configWith());
      expect(textarea()).toBeNull();
    }
  });

  it('refuses invalid JSON on blur: shows the error, saves nothing, blocks the test', async () => {
    render('openai', configWith());
    const field = textarea() as HTMLTextAreaElement;
    await type(field, '{"a": ');
    expect(testButton()?.disabled).toBe(true);
    await blur(field);
    expect(host.textContent).toContain(INVALID);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(patch).not.toHaveBeenCalled();
    await type(field, '[1]');
    await blur(field);
    expect(patch).not.toHaveBeenCalled();
    expect(testButton()?.disabled).toBe(true);
  });

  it('saves valid JSON as typed, and tests with the draft', async () => {
    render('openai', configWith());
    const field = textarea() as HTMLTextAreaElement;
    const text = '{\n  "service_tier": "flex"\n}';
    await type(field, text);
    expect(testButton()?.disabled).toBe(false);
    await blur(field);
    expect(host.textContent).not.toContain(INVALID);
    expect(patch).toHaveBeenLastCalledWith([{ path: 'providers.openai.extraBody', value: text }]);
    await act(async () => testButton()?.click());
    expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ extraBody: text }));
  });

  it('updates only the extra body of a custom provider, and stores blank as empty', async () => {
    render(
      CUSTOM,
      configWith((config) => {
        config.customProviders[CUSTOM] = {
          name: 'A',
          baseURL: 'https://llm.example.com/v1',
          model: 'q',
          extraBody: '{"think": false}',
        };
      }),
    );
    const field = textarea() as HTMLTextAreaElement;
    expect(field.value).toBe('{"think": false}');
    await type(field, '{"top_k": 5}');
    await blur(field);
    expect(patch).toHaveBeenLastCalledWith([
      { path: 'customProviders', key: CUSTOM, update: { extraBody: '{"top_k": 5}' } },
    ]);
    await type(field, '   ');
    await blur(field);
    expect(patch).toHaveBeenLastCalledWith([
      { path: 'customProviders', key: CUSTOM, update: { extraBody: '' } },
    ]);
  });

  it('ties the error to the field it is about', async () => {
    render('openai', configWith());
    const field = textarea() as HTMLTextAreaElement;
    expect(descriptions(field)).not.toContain(INVALID);
    await type(field, '{oops');
    await blur(field);
    expect(descriptions(field)).toEqual([INVALID, expect.stringContaining('不要在这里填写密钥')]);
    const base = baseInput() as HTMLInputElement;
    expect(descriptions(base)).toEqual([]);
    await type(base, 'ftp://example.com');
    await blur(base);
    expect(base.getAttribute('aria-invalid')).toBe('true');
    expect(descriptions(base)).toEqual([BASE_INVALID]);
  });

  it('keeps an invalid draft and its error when another field is saved meanwhile', async () => {
    render('openai', configWith());
    const field = textarea() as HTMLTextAreaElement;
    await type(field, '{oops');
    await blur(field);
    const base = baseInput() as HTMLInputElement;
    await type(base, 'ftp://example.com');
    await blur(base);
    // The model is saved (here or in another tab): the config the item gets changes.
    render(
      'openai',
      configWith((config) => {
        config.providers.openai.model = 'gpt-5.1';
      }),
    );
    expect(field.value).toBe('{oops');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(descriptions(field)).toContain(INVALID);
    expect(base.value).toBe('ftp://example.com');
    expect(base.getAttribute('aria-invalid')).toBe('true');
    expect(descriptions(base)).toEqual([BASE_INVALID]);
    expect(testButton()?.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
    // Once fixed, the drafts save and the errors go.
    await type(field, '{"a": 1}');
    await blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(patch).toHaveBeenLastCalledWith([
      { path: 'providers.openai.extraBody', value: '{"a": 1}' },
    ]);
  });

  it('drops an old test result when the extra body draft changes', async () => {
    render('openai', configWith());
    await act(async () => testButton()?.click());
    expect(host.textContent).toContain('你好，世界。');
    await type(textarea() as HTMLTextAreaElement, '{"a": 1}');
    expect(host.textContent).not.toContain('你好，世界。');
  });
});
