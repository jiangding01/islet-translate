// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { GlossaryState } from '@/lib/glossary/client';
import { type GlossaryEntry, glossaryBase, readGlossaryEntries } from '@/lib/glossary/types';
import { GlossaryPage } from './GlossaryPage';
import styles from './options.module.css';

// The glossary page's import, export and filter (M4-D), with storage and the background
// stubbed. The parsing itself is tested in src/lib/glossary/transfer.test.ts.

const client = vi.hoisted(() => ({
  stored: undefined as unknown,
  listener: undefined as ((state: GlossaryState) => void) | undefined,
  change: vi.fn(async (_change: unknown): Promise<unknown> => ({ ok: true, data: [] })),
}));
const notice = vi.hoisted(() => ({ saved: vi.fn(), failed: vi.fn() }));

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
vi.mock('./notice', () => ({ useNotice: () => notice }));

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
const GITHUB: GlossaryEntry = {
  id: 'term-cccccccc',
  source: 'GitHub',
  target: '',
  lang: '',
  caseSensitive: false,
};

/** New, update, same and invalid, one each (UTF-8, so no encoding switch). */
const MIXED = [
  'source,target,lang',
  'merge request,合并请求,zh-CN',
  'pull request,合并请求,zh-CN',
  'GitHub,,',
  ',something,zh-CN',
].join('\n');

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;

async function render(stored: unknown = { version: 1, entries: [PR, SONNET, GITHUB] }) {
  client.stored = stored;
  await act(async () => {
    root?.render(createElement(GlossaryPage, { config: createDefaultConfig('zh-CN') }));
  });
}

const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll('button')];
const button = (text: string, scope: ParentNode = host) =>
  buttons(scope).find((item) => item.textContent === text) as HTMLButtonElement;
const importDialog = () =>
  [...host.querySelectorAll('dialog')].find((item) =>
    item.textContent?.includes('导入术语'),
  ) as HTMLDialogElement;
const inImport = (text: string) => button(text, importDialog());
const rows = () =>
  [...(host.querySelector(`.${styles.glossaryList}`)?.children ?? [])] as HTMLLIElement[];
const filter = () => host.querySelector<HTMLInputElement>('input[type="search"]');
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const exportButton = () => button('导出');

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

async function key(element: Element, name: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

/** Waits for the file to be read (an async arrayBuffer) and the preview to render. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((done) => setTimeout(done)));
}

/** Picks a file in the import dialog's hidden file input. */
async function pick(content: string, name = 'glossary.csv') {
  const input = importDialog().querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function openImport() {
  await click(button('导入'));
  expect(importDialog().open).toBe(true);
}

/** Storage reports a new list, as watchGlossary does after a change. */
async function stored(entries: unknown[]) {
  await act(async () =>
    client.listener?.({ entries: readGlossaryEntries({ entries }), readOnly: false }),
  );
}

const stats = () =>
  [...importDialog().querySelectorAll(`.${styles.stat}`)].map((item) => item.textContent);
const submit = () =>
  importDialog().querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.change.mockReset();
  client.change.mockImplementation(async () => ({ ok: true, data: [] }));
  notice.saved.mockClear();
  notice.failed.mockClear();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GlossaryPage: filter', () => {
  it('filters by source or translation, case ignored, and says when nothing matches', async () => {
    await render();
    expect(filter()?.placeholder).toBe('筛选原文或译文');
    expect(filter()?.closest('label')?.textContent).toContain('筛选术语');
    await type(filter() as HTMLInputElement, 'GIT');
    expect(rows().map((row) => row.textContent?.slice(0, 6))).toEqual(['GitHub']);
    await type(filter() as HTMLInputElement, '拉取');
    expect(rows().map((row) => row.textContent?.slice(0, 6))).toEqual(['pull r']);
    await type(filter() as HTMLInputElement, 'zzz');
    expect(rows()).toEqual([]);
    expect(host.textContent).toContain('没有匹配的术语');
  });

  it('has no filter on an empty glossary', async () => {
    await render({ version: 1, entries: [] });
    expect(filter()).toBeNull();
  });
});

describe('GlossaryPage: export', () => {
  it('opens a menu the keyboard can walk, and Esc closes it back on the button', async () => {
    await render();
    expect(exportButton().getAttribute('aria-haspopup')).toBe('menu');
    await key(exportButton(), 'ArrowDown');
    expect(menu()).not.toBeNull();
    expect(exportButton().getAttribute('aria-expanded')).toBe('true');
    const items = [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])];
    expect(items.map((item) => item.textContent)).toEqual([
      '导出为 CSV可用 Excel、Numbers 打开编辑',
      '导出为 JSON适合备份或换设备导入',
    ]);
    expect(document.activeElement).toBe(items[0]);
    await key(menu() as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key(menu() as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await key(menu() as HTMLElement, 'End');
    expect(document.activeElement).toBe(items[1]);
    await key(menu() as HTMLElement, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(exportButton());
  });

  it('closes on a press outside', async () => {
    await render();
    await click(exportButton());
    expect(menu()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('downloads the four fields as CSV, revokes the URL later and says so', async () => {
    await render({ version: 1, entries: [{ ...PR, note: 'not exported' }] });
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:test';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await click(exportButton());
    await click(button('导出为 CSV可用 Excel、Numbers 打开编辑'));
    expect(names[0]).toMatch(/^islet-glossary-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
    vi.useRealTimers();
    const text = await (blobs[0] as Blob).text();
    expect(text).toContain('"pull request","拉取请求","zh-CN","false"');
    expect(text).not.toContain('not exported');
    expect(text).not.toContain('term-');
    expect(notice.saved).toHaveBeenCalledWith('已导出');
    expect(menu()).toBeNull();

    await click(exportButton());
    await click(button('导出为 JSON适合备份或换设备导入'));
    expect(names[1]).toMatch(/\.json$/);
    const json = JSON.parse(await (blobs[1] as Blob).text());
    expect(json.entries).toEqual([
      { source: 'pull request', target: '拉取请求', lang: 'zh-CN', caseSensitive: false },
    ]);
  });

  it('is disabled without entries; import and export are disabled when read-only', async () => {
    await render({ version: 1, entries: [] });
    expect(exportButton().disabled).toBe(true);
    expect(button('导入').disabled).toBe(false);

    act(() => root?.unmount());
    root = createRoot(host);
    await render({ version: 2, entries: [PR] });
    const reason = '术语库由更新版本的扩展写入，当前版本不能修改。';
    expect(exportButton().disabled).toBe(true);
    expect(button('导入').disabled).toBe(true);
    expect(button('导入').title).toBe(reason);
    expect(host.textContent).toContain(reason);
  });
});

describe('GlossaryPage: import', () => {
  it('goes from choosing a file to its preview, and back', async () => {
    await render();
    await openImport();
    expect(importDialog().textContent).toContain('把文件拖到这里，或');
    expect(importDialog().textContent).toContain('按当前目标语言（简体中文）导入');
    // Choosing: cancel only, no import button yet.
    expect(submit()).toBeNull();
    expect(inImport('取消')).toBeDefined();
    const input = importDialog().querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.csv,.tsv,.txt,.json');
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    await click(inImport('选择文件'));
    expect(clicked).toHaveBeenCalled();

    await pick(MIXED);
    expect(importDialog().textContent).toContain('glossary.csv · 5 行 · UTF-8');
    expect(importDialog().textContent).toContain('第 1 行作为表头');
    expect(stats()).toEqual(['1新增', '1覆盖', '1不变', '1无效']);
    expect(importDialog().textContent).toContain('拉取请求 → 合并请求');
    expect(importDialog().textContent).toContain('1 处无效，不会导入：');
    expect(importDialog().textContent).toContain('第 5 行：原文为空');
    expect(submit().textContent).toBe('导入 2 条');
    expect(submit().disabled).toBe(false);

    await click(inImport('重新选择'));
    expect(importDialog().textContent).toContain('把文件拖到这里，或');
    expect(submit()).toBeNull();
  });

  it('disables the import on a blocking error and says why', async () => {
    await render();
    await openImport();
    await pick('a,"b\nc,d');
    const alert = importDialog().querySelector(`.${styles.banner}[role="alert"]`);
    expect(alert?.textContent).toBe('CSV 第 1 行引号不完整');
    expect(submit().disabled).toBe(true);
  });

  it('refuses a file over 1 MB without reading it', async () => {
    await render();
    await openImport();
    const input = importDialog().querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'big.csv');
    Object.defineProperty(file, 'size', { value: 1024 * 1024 + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(importDialog().textContent).toContain('文件超过 1 MB');
    expect(submit().disabled).toBe(true);
  });

  it('says when the glossary already holds everything, without an error', async () => {
    await render();
    await openImport();
    await pick('GitHub\nSonnet,,,true');
    expect(stats()).toEqual(['0新增', '0覆盖', '2不变', '0无效']);
    expect(importDialog().querySelector(`.${styles.banner}[role="alert"]`)).toBeNull();
    expect(importDialog().textContent).toContain('术语库已包含文件里的全部术语');
    expect(submit().disabled).toBe(true);
  });

  it('writes the whole list once, then notes it, clears the filter, flashes and refocuses', async () => {
    await render();
    await type(filter() as HTMLInputElement, 'pull');
    await openImport();
    await pick(MIXED);
    const added = { id: 'term-dddddddd', source: 'merge request', target: '合并请求' };
    const updated = { ...PR, target: '合并请求' };
    const after = [updated, SONNET, GITHUB, { ...added, lang: 'zh-CN', caseSensitive: false }];
    client.change.mockResolvedValueOnce({ ok: true, data: after });
    await click(submit());
    expect(client.change).toHaveBeenCalledWith({
      type: 'import',
      base: glossaryBase([PR, SONNET, GITHUB]),
      entries: [
        {
          id: PR.id,
          source: 'pull request',
          target: '合并请求',
          lang: 'zh-CN',
          caseSensitive: false,
        },
        { id: SONNET.id, source: 'Sonnet', target: '', lang: '', caseSensitive: true },
        { id: GITHUB.id, source: 'GitHub', target: '', lang: '', caseSensitive: false },
        { source: 'merge request', target: '合并请求', lang: 'zh-CN', caseSensitive: false },
      ],
    });
    expect(importDialog().open).toBe(false);
    expect(notice.saved).toHaveBeenCalledWith('已导入 2 条（新增 1，覆盖 1）');
    expect(filter()?.value).toBe('');
    await stored(after);
    // The closed dialog does not take its own write for a change made elsewhere.
    expect(importDialog().textContent).not.toContain('术语库刚被修改过');
    const flashing = rows().filter((row) =>
      row.className.split(' ').includes(styles.rowFlash as string),
    );
    expect(flashing.map((row) => row.textContent?.slice(0, 6))).toEqual(['pull r', 'merge ']);
    expect(document.activeElement).toBe(button('导入'));
  });

  it('previews again when the background says the glossary changed', async () => {
    await render();
    await openImport();
    await pick(MIXED);
    expect(stats()).toEqual(['1新增', '1覆盖', '1不变', '1无效']);
    // GitHub went away elsewhere: the row that was unchanged is new now.
    client.stored = { version: 1, entries: [PR, SONNET] };
    client.change.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'config', code: 'config/glossary-stale', message: 'Stale', retryable: false },
    });
    await click(submit());
    await settle();
    expect(importDialog().open).toBe(true);
    expect(stats()).toEqual(['2新增', '1覆盖', '0不变', '1无效']);
    expect(importDialog().textContent).toContain('术语库刚被修改过，已按最新内容重新预览。');
    // The stale refusal is the page's own copy, not an error line.
    expect(importDialog().querySelector('footer [role="alert"]')?.textContent).toBe('');
    expect(submit().textContent).toBe('导入 3 条');
  });

  it('focuses the file button again when reopened after a preview', async () => {
    await render();
    await openImport();
    await pick(MIXED);
    await click(importDialog().querySelector('header button'));
    expect(importDialog().open).toBe(false);
    await openImport();
    await settle();
    expect(document.activeElement).toBe(inImport('选择文件'));
  });

  it('previews again when storage changes while the preview shows', async () => {
    await render();
    await openImport();
    await pick(MIXED);
    await stored([{ ...PR, target: '别的译法' }, SONNET, GITHUB]);
    expect(importDialog().textContent).toContain('别的译法 → 合并请求');
    expect(importDialog().textContent).toContain('术语库刚被修改过，已按最新内容重新预览。');
  });

  it('shows a refused write in the footer and keeps the dialog open', async () => {
    await render();
    await openImport();
    await pick(MIXED);
    client.change.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'config',
        code: 'config/glossary-write-failed',
        message: 'quota',
        retryable: true,
      },
    });
    await click(submit());
    expect(importDialog().open).toBe(true);
    expect(importDialog().querySelector('footer [role="alert"]')?.textContent).toBe(
      '保存失败，请重试。',
    );
  });
});

describe('GlossaryPage: dropping files', () => {
  function drop(target: EventTarget, files: File[], folder = false) {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files,
        items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: folder }) })),
        dropEffect: 'none',
      },
    });
    target.dispatchEvent(event);
    return event;
  }
  const zone = () => importDialog().querySelector(`.${styles.drop}`) as HTMLElement;

  it('keeps files dropped anywhere on the page from opening while the dialog is open', async () => {
    await render();
    const before = new Event('dragover', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    await openImport();
    const over = new Event('dragover', { cancelable: true });
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(drop(document.body, [new File(['a'], 'a.csv')]).defaultPrevented).toBe(true);
    // Outside the drop area, nothing is read.
    await settle();
    expect(submit()).toBeNull();
    await click(inImport('取消'));
    const after = new Event('drop', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('reads one file dropped on the drop area, and refuses several or a folder', async () => {
    await render();
    await openImport();
    await act(async () => {
      drop(zone(), [new File(['a'], 'a.csv'), new File(['b'], 'b.csv')]);
    });
    expect(importDialog().textContent).toContain('一次只能导入一个文件');
    await act(async () => {
      drop(zone(), [new File([''], 'folder')], true);
    });
    expect(importDialog().textContent).toContain('一次只能导入一个文件');
    expect(submit()).toBeNull();
    await act(async () => {
      drop(zone(), [new File([MIXED], 'one.csv')]);
    });
    await settle();
    expect(importDialog().textContent).toContain('one.csv · 5 行 · UTF-8');
  });
});
