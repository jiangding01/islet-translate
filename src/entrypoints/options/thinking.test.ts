// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigChange } from '@/lib/config/types';
import { createGetMessage, loadLocales } from '../../../scripts/i18n-messages.mjs';
import { ThinkingRow } from './EngineItem';

// The DeepSeek "thinking mode" switch in the engine panel (only DeepSeek has the field:
// see engine-fields.test.ts).

async function useEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

const row = (thinking: boolean, change = vi.fn()) =>
  createElement(ThinkingRow, { thinking, change });

function parse(html: string) {
  const host = new DOMParser().parseFromString(html, 'text/html').body;
  const group = host.querySelector('fieldset');
  const segments = [...(group?.querySelectorAll('label') ?? [])];
  const byAttribute = (name: string) => {
    const id = group?.getAttribute(name);
    return id ? host.querySelector(`[id="${id}"]`)?.textContent : undefined;
  };
  return {
    labels: segments.map((label) => label.textContent),
    checked: segments.map((label) => (label.querySelector('input') as HTMLInputElement).checked),
    name: byAttribute('aria-labelledby'),
    hint: byAttribute('aria-describedby'),
  };
}

describe('ThinkingRow', () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
  });

  it('draws on and off with the default (off) selected, and explains the cost', () => {
    const view = parse(
      renderToStaticMarkup(row(createDefaultConfig('zh-CN').providers.deepseek.thinking)),
    );
    expect(view.name).toBe('思考模式');
    expect(view.labels).toEqual(['开', '关']);
    expect(view.checked).toEqual([false, true]);
    expect(view.hint).toBe('开启后模型会先推理再翻译，译文可能更准确，但明显更慢，也更费 token。');
  });

  it('has English copy', async () => {
    await useEnglish();
    const view = parse(renderToStaticMarkup(row(true)));
    expect(view.name).toBe('Thinking mode');
    expect(view.labels).toEqual(['On', 'Off']);
    expect(view.checked).toEqual([true, false]);
  });

  it('writes providers.deepseek.thinking when a choice is clicked', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const change = vi.fn<(next: ConfigChange) => void>();
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root?.render(row(false, change)));
    const inputs = host.querySelectorAll('input');
    act(() => inputs[0]?.click());
    expect(change).toHaveBeenLastCalledWith({ path: 'providers.deepseek.thinking', value: true });
    act(() => root?.render(row(true, change)));
    act(() => inputs[1]?.click());
    expect(change).toHaveBeenLastCalledWith({ path: 'providers.deepseek.thinking', value: false });
  });
});
