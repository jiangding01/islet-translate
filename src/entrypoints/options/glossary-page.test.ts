// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import {
  type GlossaryEntry,
  MAX_GLOSSARY_ENTRIES,
  readGlossaryEntries,
} from '@/lib/glossary/types';
import { GlossaryPage } from './GlossaryPage';

// The glossary page (M4-C), with storage and the background stubbed.

const client = vi.hoisted(() => ({
  stored: undefined as unknown,
  listener: undefined as ((entries: GlossaryEntry[]) => void) | undefined,
  change: vi.fn(async (_change: unknown) => ({ ok: true as const, data: [] as GlossaryEntry[] })),
}));

vi.mock('@/lib/glossary/client', async () => {
  const { readGlossaryEntries: read } = await import('@/lib/glossary/types');
  return {
    readGlossary: async () => read(client.stored),
    watchGlossary: (callback: (entries: GlossaryEntry[]) => void) => {
      client.listener = callback;
      return () => {
        client.listener = undefined;
      };
    },
    changeGlossary: client.change,
  };
});
vi.mock('./notice', () => ({ useNotice: () => ({ saved: vi.fn(), failed: vi.fn() }) }));

const PR: GlossaryEntry = {
  id: 'term-aaaaaaaa',
  source: 'pull request',
  target: '拉取请求',
  lang: 'zh-CN',
  caseSensitive: false,
};
const SONNET: GlossaryEntry = {
  id: 'term-bbbbbbbb',
  source: 'Sonnet',
  target: '',
  lang: '',
  caseSensitive: true,
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;

async function render(entries: unknown[] = []) {
  client.stored = { version: 1, entries };
  await act(async () => {
    root?.render(createElement(GlossaryPage, { config: createDefaultConfig('zh-CN') }));
  });
}

const buttons = (text: string) =>
  [...host.querySelectorAll('button')].filter((item) => item.textContent === text);
const button = (text: string) => buttons(text)[0];
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const form = () => host.querySelector('form');
const inputs = () => [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])];
const sourceInput = () => inputs()[0] as HTMLInputElement;
const targetInput = () => inputs()[1] as HTMLInputElement;
const checkbox = () => form()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
const save = () =>
  [...(form()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '保存');

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The text of the error an input points to through aria-describedby. */
function describedError(input: HTMLElement) {
  const id = input.getAttribute('aria-describedby');
  return id ? host.querySelector(`[id="${id}"]`)?.textContent : undefined;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.change.mockClear();
  client.change.mockImplementation(async () => ({ ok: true as const, data: [] }));
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('GlossaryPage: list', () => {
  it('shows the empty state with its own add button', async () => {
    await render();
    expect(host.textContent).toContain('还没有术语。添加后，翻译时会按你的译法处理这些词');
    expect(buttons('添加术语')).toHaveLength(2);
    await click(buttons('添加术语')[1]);
    expect(form()).not.toBeNull();
    expect(host.textContent).not.toContain('还没有术语');
  });

  it('shows each entry with its translation or the keep tag, language and case', async () => {
    await render([PR, SONNET]);
    const rows = [...host.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows[0]).toContain('pull request→拉取请求简体中文');
    expect(rows[1]).toContain('Sonnet→保持原样Aa');
    expect(byLabel('编辑「pull request」')).not.toBeNull();
    expect(byLabel('删除「Sonnet」')).not.toBeNull();
  });

  it('skips malformed entries and follows storage changes', async () => {
    await render([PR, { ...SONNET, id: 'bad' }, { id: 'term-cccccccc', source: 'x' }, 'text']);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    await act(async () => client.listener?.(readGlossaryEntries({ entries: [PR, SONNET] })));
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });

  it(`disables adding at ${MAX_GLOSSARY_ENTRIES} entries and says why`, async () => {
    const many = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, index) => ({
      ...SONNET,
      id: `term-${String(index).padStart(8, '0')}`,
      source: `w${index}`,
    }));
    await render(many);
    expect(button('添加术语')?.disabled).toBe(true);
    expect(host.textContent).toContain('最多 500 条术语');
  });

  it('asks before deleting and removes on confirmation', async () => {
    await render([PR]);
    await click(byLabel('删除「pull request」'));
    expect(client.change).not.toHaveBeenCalled();
    expect(host.textContent).toContain('删除后无法恢复');
    await click(button('取消'));
    expect(host.textContent).not.toContain('删除后无法恢复');
    await click(byLabel('删除「pull request」'));
    await click(button('确认删除'));
    expect(client.change).toHaveBeenCalledWith({ type: 'remove', id: 'term-aaaaaaaa' });
  });
});

describe('GlossaryPage: the form', () => {
  it('shows no empty hint when the source is only left, so one click on Cancel closes', async () => {
    await render();
    await click(button('添加术语'));
    // The source field is focused on open; leaving it untouched must not add a line that
    // pushes the buttons down under the pointer.
    await act(async () => {
      sourceInput().focus();
      sourceInput().blur();
    });
    expect(form()?.textContent).not.toContain('请填写原文');
    expect(sourceInput().getAttribute('aria-invalid')).toBe('false');
    await click(button('取消'));
    expect(form()).toBeNull();
  });

  it('adds a keep-as-is entry: no language without a translation', async () => {
    await render();
    await click(button('添加术语'));
    expect(save()?.disabled).toBe(true);
    expect(targetInput().placeholder).toBe('留空则保持原样');
    await type(sourceInput(), '  Sonnet ');
    expect(form()?.textContent).not.toContain('目标语言');
    await click(checkbox());
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'add',
      entry: { source: 'Sonnet', target: '', lang: '', caseSensitive: true },
    });
    expect(form()).toBeNull();
  });

  it('shows the language once there is a translation, set to the target language', async () => {
    await render();
    await click(button('添加术语'));
    await type(sourceInput(), 'pull request');
    await type(targetInput(), '拉取请求');
    expect(form()?.textContent).toContain('目标语言');
    const select = form()?.querySelector('[aria-labelledby$="-lang-label"]');
    expect(select?.textContent).toContain('简体中文');
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'add',
      entry: { source: 'pull request', target: '拉取请求', lang: 'zh-CN', caseSensitive: false },
    });
  });

  it('edits an entry in place of a new one', async () => {
    await render([PR]);
    await click(byLabel('编辑「pull request」'));
    expect(sourceInput().value).toBe('pull request');
    expect(targetInput().value).toBe('拉取请求');
    await type(targetInput(), '合并请求');
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'update',
      id: 'term-aaaaaaaa',
      entry: { source: 'pull request', target: '合并请求', lang: 'zh-CN', caseSensitive: false },
    });
  });

  it('ties field errors to their fields', async () => {
    await render();
    await click(button('添加术语'));
    await type(sourceInput(), 'x');
    await type(sourceInput(), '  ');
    expect(describedError(sourceInput())).toBe('请填写原文');
    expect(sourceInput().getAttribute('aria-invalid')).toBe('true');
    await type(sourceInput(), 'x'.repeat(201));
    expect(describedError(sourceInput())).toBe('原文最多 200 个字符');
    expect(save()?.disabled).toBe(true);
    await type(sourceInput(), 'x');
    await type(targetInput(), 'y'.repeat(201));
    expect(describedError(targetInput())).toBe('译文最多 200 个字符');
    expect(save()?.disabled).toBe(true);
  });

  it('shows a duplicate under the source field and other refusals as an alert', async () => {
    await render([SONNET]);
    await click(button('添加术语'));
    await type(sourceInput(), 'sonnet');
    client.change.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'config', code: 'config/glossary-duplicate', message: 'm', retryable: false },
    } as never);
    await click(save());
    expect(describedError(sourceInput())).toBe('已有相同原文的术语。');
    expect(form()).not.toBeNull();

    client.change.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'config', code: 'config/glossary-missing', message: 'm', retryable: false },
    } as never);
    await type(sourceInput(), 'Opus');
    await click(save());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('这条术语已被删除。');
  });
});

describe('GlossaryPage: focus', () => {
  const addButton = () => button('添加术语') as HTMLButtonElement;

  it('gives the focus back to the add button after saving, cancelling and deleting', async () => {
    await render([PR]);
    await click(addButton());
    expect(document.activeElement).toBe(sourceInput());
    await type(sourceInput(), 'Sonnet');
    await click(save());
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(addButton());

    await click(byLabel('编辑「pull request」'));
    await click(
      [...(form()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '取消'),
    );
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(addButton());

    await click(byLabel('删除「pull request」'));
    await click(button('确认删除'));
    expect(document.activeElement).toBe(addButton());
  });

  it('gives it to the delete button when its confirmation is cancelled', async () => {
    await render([PR]);
    await click(byLabel('删除「pull request」'));
    await click(button('取消'));
    expect(document.activeElement).toBe(byLabel('删除「pull request」'));
  });

  it('gives it to the section when the add button is disabled', async () => {
    const many = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, index) => ({
      ...SONNET,
      id: `term-${String(index).padStart(8, '0')}`,
      source: `w${index}`,
    }));
    await render(many);
    await click(byLabel('编辑「w0」'));
    await click(save());
    const section = host.querySelector('section');
    expect(section?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(section);
  });
});
