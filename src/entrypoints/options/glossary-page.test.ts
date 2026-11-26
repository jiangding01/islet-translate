// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { GlossaryState } from '@/lib/glossary/client';
import {
  type GlossaryEntry,
  MAX_GLOSSARY_ENTRIES,
  readGlossaryEntries,
} from '@/lib/glossary/types';
import { GlossaryPage } from './GlossaryPage';
import styles from './options.module.css';

// The glossary page (M4-C, redesigned in M4: rows on a shared grid, a dialog to add and edit),
// with storage and the background stubbed.

const client = vi.hoisted(() => ({
  stored: undefined as unknown,
  listener: undefined as ((state: GlossaryState) => void) | undefined,
  change: vi.fn(async (_change: unknown) => ({ ok: true as const, data: [] as GlossaryEntry[] })),
}));

vi.mock('@/lib/glossary/client', async () => {
  const { readGlossaryEntries: read, isReadOnlyGlossary } = await import('@/lib/glossary/types');
  return {
    readGlossary: async () => ({
      entries: read(client.stored),
      readOnly: isReadOnlyGlossary(client.stored),
    }),
    watchGlossary: (callback: (state: GlossaryState) => void) => {
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
const dialog = () => host.querySelector('dialog') as HTMLDialogElement;
const isOpen = () => dialog().open;
const inputs = () => [...dialog().querySelectorAll<HTMLInputElement>('input')];
const sourceInput = () => inputs()[0] as HTMLInputElement;
const targetInput = () => inputs()[1] as HTMLInputElement;
const checkbox = () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]');
const inDialog = (text: string) =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === text);
const save = () => inDialog('保存');
/** The glossary list (the import dialog, always mounted, has lists of its own). */
const glossaryList = () => host.querySelector(`.${styles.glossaryList}`);
const rows = () => [...(glossaryList()?.children ?? [])] as HTMLLIElement[];
const row = (index: number) => rows()[index] as HTMLLIElement;
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...SONNET,
    id: `term-${String(index).padStart(8, '0')}`,
    source: `w${index}`,
  }));
/** Storage reports a new list, as watchGlossary does after a change. */
async function stored(entries: unknown[]) {
  await act(async () =>
    client.listener?.({ entries: readGlossaryEntries({ entries }), readOnly: false }),
  );
}

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
  it('shows the empty state in the card, with the header button as the only add button', async () => {
    await render();
    expect(host.textContent).toContain('还没有术语。添加后，翻译时会按你的译法处理这些词');
    expect(buttons('添加术语')).toHaveLength(1);
    expect(glossaryList()).toBeNull();
    // No count on an empty glossary.
    expect(host.textContent).not.toContain('/ 500');
    await click(button('添加术语'));
    expect(isOpen()).toBe(true);
    expect(dialog().querySelector('h2')?.textContent).toBe('添加术语');
  });

  it('shows each entry with its translation or the keep tag, language and case', async () => {
    await render([PR, SONNET]);
    expect(host.querySelector('h2')?.textContent).toBe('术语');
    expect(host.textContent).toContain('2 / 500');
    // The count stays visible in narrow windows, unlike plain head hints.
    const count = [...host.querySelectorAll('span')].find((item) => item.textContent === '2 / 500');
    expect(count?.className).toBe(styles.headHintKeep);
    expect(rows().map((row) => row.textContent)).toEqual([
      'pull request拉取请求简体中文',
      // "Aa" is hidden from screen readers, which read the words instead.
      'Sonnet保持原样Aa区分大小写',
    ]);
    const aa = [...row(1).querySelectorAll('span')].find((span) => span.textContent === 'Aa');
    expect(aa?.getAttribute('aria-hidden')).toBe('true');
    expect(aa?.nextElementSibling?.className).toBe(styles.visuallyHidden);
    // Edit and delete are always there (not only on hover), named after the entry.
    expect(byLabel('编辑「pull request」')).not.toBeNull();
    expect(byLabel('删除「Sonnet」')).not.toBeNull();
  });

  it('lays every row on the list grid as a subgrid, so the columns line up', async () => {
    await render([PR, SONNET]);
    const list = glossaryList();
    expect(list?.className).toBe(styles.glossaryList);
    for (const row of rows()) {
      expect(row.className.split(' ')).toContain(styles.glossaryRow);
      // Source, arrow, translation, language and case, actions: five cells, one per column.
      expect(row.children).toHaveLength(5);
    }
    const css = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/options/options.module.css'),
      'utf8',
    );
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('glossaryList')).toContain(
      'grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr) auto auto;',
    );
    expect(rule('glossaryRow')).toContain('grid-column: 1 / -1;');
    expect(rule('glossaryRow')).toContain('grid-template-columns: subgrid;');
    // Long text wraps onto two lines at most, and breaks even without spaces.
    expect(rule('glossaryText')).toContain('-webkit-line-clamp: 2;');
    expect(rule('glossaryText')).toContain('overflow-wrap: anywhere;');
  });

  it('keeps long text whole in the DOM', async () => {
    const long = { ...PR, source: 'a'.repeat(200), target: 'b'.repeat(200) };
    await render([long]);
    expect(row(0).textContent).toContain('a'.repeat(200));
    expect(row(0).textContent).toContain('b'.repeat(200));
  });

  it('skips malformed entries and follows storage changes', async () => {
    await render([PR, { ...SONNET, id: 'bad' }, { id: 'term-cccccccc', source: 'x' }, 'text']);
    expect(rows()).toHaveLength(1);
    await stored([PR, SONNET]);
    expect(rows()).toHaveLength(2);
  });

  it(`disables adding at ${MAX_GLOSSARY_ENTRIES} entries and says why`, async () => {
    await render(many(MAX_GLOSSARY_ENTRIES));
    expect(button('添加术语')?.disabled).toBe(true);
    expect(host.textContent).toContain('500 / 500');
    expect(host.textContent).toContain('最多 500 条术语。');
  });

  it('asks before deleting, in place under the row, and removes on confirmation', async () => {
    await render([PR]);
    await click(byLabel('删除「pull request」'));
    expect(client.change).not.toHaveBeenCalled();
    expect(byLabel('删除「pull request」')?.getAttribute('aria-expanded')).toBe('true');
    expect(row(0).textContent).toContain('删除后无法恢复');
    await click(button('取消'));
    expect(host.textContent).not.toContain('删除后无法恢复');
    await click(byLabel('删除「pull request」'));
    await click(button('确认删除'));
    expect(client.change).toHaveBeenCalledWith({ type: 'remove', id: 'term-aaaaaaaa' });
  });

  it('adds the new entry at the end and flashes its row once', async () => {
    await render([PR]);
    const added = { ...SONNET, id: 'term-cccccccc' };
    client.change.mockResolvedValueOnce({ ok: true, data: [PR, added] });
    await click(button('添加术语'));
    await type(sourceInput(), 'Sonnet');
    await click(save());
    await stored([PR, added]);
    expect(rows().map((row) => row.textContent?.slice(0, 6))).toEqual(['pull r', 'Sonnet']);
    expect(row(1).className.split(' ')).toContain(styles.rowFlash);
    expect(row(0).className.split(' ')).not.toContain(styles.rowFlash);
    await act(async () => {
      row(1).dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(row(1).className.split(' ')).not.toContain(styles.rowFlash);
  });
});

describe('GlossaryPage: the dialog', () => {
  it('shows no empty hint when the source is only left, so one click on Cancel closes', async () => {
    await render();
    await click(button('添加术语'));
    // The source field is focused on open; leaving it untouched must not add a line that
    // pushes the buttons down under the pointer.
    await act(async () => {
      sourceInput().focus();
      sourceInput().blur();
    });
    expect(dialog().textContent).not.toContain('请填写原文');
    expect(sourceInput().getAttribute('aria-invalid')).toBe('false');
    await click(inDialog('取消'));
    expect(isOpen()).toBe(false);
  });

  it('adds a keep-as-is entry: no language without a translation', async () => {
    await render();
    await click(button('添加术语'));
    expect(save()?.disabled).toBe(true);
    expect(targetInput().placeholder).toBe('留空则保持原样');
    await type(sourceInput(), '  Sonnet ');
    expect(dialog().textContent).not.toContain('目标语言');
    await click(checkbox());
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'add',
      entry: { source: 'Sonnet', target: '', lang: '', caseSensitive: true },
    });
    expect(isOpen()).toBe(false);
  });

  it('shows the language once there is a translation, set to the target language', async () => {
    await render();
    await click(button('添加术语'));
    await type(sourceInput(), 'pull request');
    await type(targetInput(), '拉取请求');
    expect(dialog().textContent).toContain('目标语言');
    const select = dialog().querySelector('[aria-labelledby$="-lang-label"]');
    expect(select?.textContent).toContain('简体中文');
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'add',
      entry: { source: 'pull request', target: '拉取请求', lang: 'zh-CN', caseSensitive: false },
    });
  });

  it('edits an entry in place of a new one, and starts afresh when adding next', async () => {
    await render([PR]);
    await click(byLabel('编辑「pull request」'));
    expect(dialog().querySelector('h2')?.textContent).toBe('编辑术语');
    expect(sourceInput().value).toBe('pull request');
    expect(targetInput().value).toBe('拉取请求');
    await type(targetInput(), '合并请求');
    await click(save());
    expect(client.change).toHaveBeenCalledWith({
      type: 'update',
      id: 'term-aaaaaaaa',
      entry: { source: 'pull request', target: '合并请求', lang: 'zh-CN', caseSensitive: false },
    });
    expect(isOpen()).toBe(false);
    // The closing dialog keeps its title while it fades out.
    expect(dialog().querySelector('h2')?.textContent).toBe('编辑术语');

    await click(button('添加术语'));
    expect(dialog().querySelector('h2')?.textContent).toBe('添加术语');
    expect(sourceInput().value).toBe('');
    expect(targetInput().value).toBe('');
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

  it('shows a duplicate under the source field after saving, and other refusals as an alert', async () => {
    await render([SONNET]);
    await click(button('添加术语'));
    await type(sourceInput(), 'sonnet');
    // Nothing is checked before saving: the background decides.
    expect(sourceInput().getAttribute('aria-describedby')).toBeNull();
    client.change.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'config', code: 'config/glossary-duplicate', message: 'm', retryable: false },
    } as never);
    save()?.focus();
    await click(save());
    expect(describedError(sourceInput())).toBe('已有相同原文的术语。');
    expect(sourceInput().getAttribute('aria-invalid')).toBe('true');
    // The focus moves to the source, so a screen reader reads it with the hint.
    expect(document.activeElement).toBe(sourceInput());
    expect(isOpen()).toBe(true);
    // Editing the source clears it.
    await type(sourceInput(), 'Opus');
    expect(sourceInput().getAttribute('aria-describedby')).toBeNull();

    client.change.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'config', code: 'config/glossary-missing', message: 'm', retryable: false },
    } as never);
    await click(save());
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('这条术语已被删除。');
    expect(isOpen()).toBe(true);
  });
});

describe('GlossaryPage: focus', () => {
  const addButton = () => button('添加术语') as HTMLButtonElement;

  it('gives the focus back to the button that opened the dialog', async () => {
    await render([PR]);
    await click(addButton());
    expect(document.activeElement).toBe(sourceInput());
    await type(sourceInput(), 'Sonnet');
    await click(save());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(addButton());

    await click(byLabel('编辑「pull request」'));
    expect(document.activeElement).toBe(sourceInput());
    await click(inDialog('取消'));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byLabel('编辑「pull request」'));
  });

  it('gives it to the add button after deleting', async () => {
    await render([PR, SONNET]);
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

  it('gives it to the section when the opening button is gone or disabled', async () => {
    // The 500th entry disables the add button that opened the dialog.
    await render(many(MAX_GLOSSARY_ENTRIES - 1));
    await click(addButton());
    await type(sourceInput(), 'last');
    await click(save());
    await stored(many(MAX_GLOSSARY_ENTRIES));
    const section = host.querySelector('section');
    expect(section?.getAttribute('tabindex')).toBe('-1');
    expect(addButton().disabled).toBe(true);
    expect(document.activeElement).toBe(section);

    // An entry deleted elsewhere while its dialog was open.
    await click(byLabel('编辑「w0」'));
    await stored(many(MAX_GLOSSARY_ENTRIES).slice(1));
    await click(inDialog('取消'));
    expect(document.activeElement).toBe(section);
  });
});
