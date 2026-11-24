import { describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import type { PageState } from '@/lib/messaging/protocol';
import { IDLE_PAGE_STATE, type PageActions } from '../runtime-contract';
import {
  COMMAND_PREFIX,
  COMMANDS,
  listCommands,
  matchRange,
  normalizeQuery,
  type PaletteContext,
} from './registry';

const ctxOf = (state: Partial<PageState>): PaletteContext => ({
  state: { ...IDLE_PAGE_STATE, ...state },
});
const ids = (ctx: PaletteContext, query = '') => listCommands(ctx, query).map((c) => c.id);

describe('availability and order (empty input)', () => {
  // The seventh context, after a quick translation, is below (it needs a result in `ctx`).
  it.each([
    ['idle', {}, ['page.translate', 'engine.switch', 'region.translate', 'options.open']],
    [
      'a whole-page session in bilingual mode',
      { phase: 'running', engine: 'google' },
      ['page.restore', 'view.translationOnly', 'engine.switch', 'region.exclude', 'options.open'],
    ],
    [
      'a finished session showing translations only',
      { phase: 'done', mode: 'translation' },
      ['page.restore', 'view.bilingual', 'engine.switch', 'region.exclude', 'options.open'],
    ],
    [
      'failed paragraphs (retry first)',
      { phase: 'done', failed: 3 },
      [
        'retry.failed',
        'page.restore',
        'view.translationOnly',
        'engine.switch',
        'region.exclude',
        'options.open',
      ],
    ],
    [
      'an engine-level error (retry first)',
      {
        phase: 'running',
        engineError: appError('provider', 'provider/unauthorized', 'x'),
      },
      [
        'retry.failed',
        'page.restore',
        'view.translationOnly',
        'engine.switch',
        'region.exclude',
        'options.open',
      ],
    ],
    [
      'held paragraphs only (a local session)',
      { phase: 'done', scope: 'units' },
      ['page.translate', 'page.restore', 'engine.switch', 'region.translate', 'options.open'],
    ],
    ['a halted session: nothing at all', { phase: 'running', halted: true }, []],
  ] as [string, Partial<PageState>, string[]][])('%s', (_label, state, expected) => {
    expect(ids(ctxOf(state))).toEqual(expected);
  });

  it('after a quick translation: “复制译文” first, whatever the query', () => {
    const ctx: PaletteContext = { state: { ...IDLE_PAGE_STATE }, quick: { copied: false } };
    expect(ids(ctx)).toEqual([
      'quick.copy',
      'page.translate',
      'engine.switch',
      'region.translate',
      'options.open',
    ]);
    // The input is the text that was translated: it matches no title, the copy row stays.
    expect(ids(ctx, 'hello world')).toEqual(['quick.copy']);
    expect(ids({ ...ctx, state: { ...IDLE_PAGE_STATE, phase: 'done', failed: 1 } })[0]).toBe(
      'quick.copy',
    );
    // No result, no copy row; a halted session offers nothing.
    expect(ids(ctxOf({}), 'copy')).toEqual([]);
    expect(ids({ ...ctx, state: { ...IDLE_PAGE_STATE, phase: 'running', halted: true } })).toEqual(
      [],
    );
  });

  it('titles the copy command “已复制” for a moment after copying', () => {
    const copy = COMMANDS.find((c) => c.id === 'quick.copy');
    expect(copy?.title({ state: IDLE_PAGE_STATE, quick: { copied: false } })).toBe('复制译文');
    expect(copy?.title({ state: IDLE_PAGE_STATE, quick: { copied: true } })).toBe('已复制');
    expect(copy?.stays).toBe(true);
  });

  it('offers “选择要翻译的区域” when idle or with held paragraphs only, as “翻译此页”', () => {
    const region = COMMANDS.find((c) => c.id === 'region.translate');
    expect(region?.title(ctxOf({}))).toBe('选择要翻译的区域');
    expect(region?.when(ctxOf({}))).toBe(true);
    expect(region?.when(ctxOf({ phase: 'running', scope: 'units' }))).toBe(true);
    expect(region?.when(ctxOf({ phase: 'running' }))).toBe(false);
    expect(region?.when(ctxOf({ phase: 'done' }))).toBe(false);
    // Found by its title and by English keywords.
    expect(ids(ctxOf({}), '/区域')).toEqual(['region.translate']);
    expect(ids(ctxOf({}), 'area')).toEqual(['region.translate']);
  });

  it('offers “选择不翻译的区域” only while the whole page is translated, as the view commands', () => {
    const region = COMMANDS.find((c) => c.id === 'region.exclude');
    expect(region?.title(ctxOf({}))).toBe('选择不翻译的区域');
    expect(region?.when(ctxOf({ phase: 'running' }))).toBe(true);
    expect(region?.when(ctxOf({ phase: 'done', failed: 2 }))).toBe(true);
    expect(region?.when(ctxOf({}))).toBe(false);
    expect(region?.when(ctxOf({ phase: 'running', scope: 'units' }))).toBe(false);
    expect(region?.when(ctxOf({ phase: 'running', halted: true }))).toBe(false);
    // The two region commands never show together: the same query finds the one available.
    expect(ids(ctxOf({ phase: 'done' }), '/区域')).toEqual(['region.exclude']);
    expect(ids(ctxOf({ phase: 'done' }), 'area')).toEqual(['region.exclude']);
    expect(ids(ctxOf({ phase: 'done' }), 'exclude')).toEqual(['region.exclude']);
  });

  it('titles the engine command by state: switch while translating, translate with … when idle', () => {
    const engine = COMMANDS.find((c) => c.id === 'engine.switch');
    expect(engine?.title(ctxOf({ phase: 'running' }))).toBe('切换翻译服务…');
    expect(engine?.title(ctxOf({}))).toBe('用…翻译此页');
    expect(engine?.title(ctxOf({ phase: 'done', scope: 'units' }))).toBe('用…翻译此页');
  });
});

describe('matching', () => {
  const running = ctxOf({ phase: 'running' });

  it('finds “打开设置” by its title and English keywords, and keeps it last', () => {
    expect(COMMANDS.find((c) => c.id === 'options.open')?.title(running)).toBe('打开设置');
    expect(ids(running, '设置')).toEqual(['options.open']);
    expect(ids(running, 'Settings')).toEqual(['options.open']);
    expect(ids(ctxOf({}), 'options')).toEqual(['options.open']);
    // 翻译 is in two titles; the settings command is not one of them.
    expect(ids(ctxOf({ phase: 'done', failed: 2 }), '').at(-1)).toBe('options.open');
  });

  it('normalizes: trimmed, lower case, a leading slash only filters', () => {
    expect(normalizeQuery('  /Retry ')).toBe('retry');
    // Chinese input methods type a full-width slash or “、” for the slash key.
    expect(normalizeQuery('／设置')).toBe('设置');
    expect(normalizeQuery('、设置')).toBe('设置');
    expect(COMMAND_PREFIX.test('、')).toBe(true);
    expect(COMMAND_PREFIX.test('a/')).toBe(false);
    expect(normalizeQuery('/ 只看')).toBe('只看');
    expect(normalizeQuery('a/b')).toBe('a/b');
  });

  it('matches title substrings and English keywords, in any UI language', () => {
    expect(ids(running, '只看')).toEqual(['view.translationOnly']);
    expect(ids(running, '/只看')).toEqual(['view.translationOnly']);
    expect(ids(running, 'ENGINE')).toEqual(['engine.switch']);
    expect(ids(ctxOf({}), 'translate')).toEqual(['page.translate']);
    expect(ids(running, 'zzz')).toEqual([]);
  });

  it('finds the match in the original label even when lower-casing changes its length', () => {
    // "İ" lower-cases to two code units ("i̇"): indexes into the lower-cased label would be off.
    expect(matchRange('İleri Çeviri', 'leri')).toEqual([1, 5]);
    expect(matchRange('İleri', normalizeQuery('İl'))).toEqual([0, 2]);
    expect(matchRange('Open AI', 'ai')).toEqual([5, 7]);
    expect(matchRange('Google', 'zz')).toBeUndefined();
    expect(matchRange('Google', '')).toBeUndefined();
  });

  it('puts title prefix matches before other matches, then rank, then table order', () => {
    // 显示原文… starts with 显示; nothing else does. 翻译 is inside three titles.
    expect(ids(running, '显示')).toEqual(['page.restore']);
    expect(ids(running, '翻译')).toEqual(['page.restore', 'engine.switch', 'region.exclude']);
    // "mode" is a keyword of both views; only the one not current is offered.
    expect(ids(running, 'mode')).toEqual(['view.translationOnly']);
  });
});

describe('running', () => {
  function api() {
    const page: PageActions = {
      getState: vi.fn(async () => IDLE_PAGE_STATE),
      start: vi.fn(async () => IDLE_PAGE_STATE),
      stop: vi.fn(async () => IDLE_PAGE_STATE),
      toggle: vi.fn(async () => IDLE_PAGE_STATE),
      setMode: vi.fn(async () => IDLE_PAGE_STATE),
      retryFailed: vi.fn(async () => IDLE_PAGE_STATE),
    };
    return { page, engines: vi.fn(), openSettings: vi.fn(), copy: vi.fn(), pickRegion: vi.fn() };
  }
  const run = (id: string, ctx = ctxOf({ phase: 'running' })) => {
    const a = api();
    COMMANDS.find((c) => c.id === id)?.run(ctx, a);
    return a;
  };

  it('calls the matching page action, and the engine command opens the engine list', () => {
    expect(run('page.translate', ctxOf({})).page.start).toHaveBeenCalledOnce();
    expect(run('page.restore').page.stop).toHaveBeenCalledOnce();
    expect(run('view.bilingual').page.setMode).toHaveBeenCalledWith('bilingual');
    expect(run('view.translationOnly').page.setMode).toHaveBeenCalledWith('translation');
    expect(run('retry.failed').page.retryFailed).toHaveBeenCalledOnce();
    const engine = run('engine.switch');
    expect(engine.engines).toHaveBeenCalledOnce();
    expect(engine.page.start).not.toHaveBeenCalled();
    const settings = run('options.open');
    expect(settings.openSettings).toHaveBeenCalledOnce();
    expect(settings.engines).not.toHaveBeenCalled();
    expect(
      run('quick.copy', { state: IDLE_PAGE_STATE, quick: { copied: false } }).copy,
    ).toHaveBeenCalledOnce();
    const region = run('region.translate', ctxOf({}));
    expect(region.pickRegion).toHaveBeenCalledOnce();
    expect(region.page.start).not.toHaveBeenCalled();
    const exclude = run('region.exclude');
    expect(exclude.pickRegion).toHaveBeenCalledWith('exclude');
    expect(exclude.page.stop).not.toHaveBeenCalled();
  });

  it('swallows a rejected action (the isle and the panel report the session)', async () => {
    const a = api();
    vi.mocked(a.page.stop).mockRejectedValue(new Error('gone'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    COMMANDS.find((c) => c.id === 'page.restore')?.run(ctxOf({ phase: 'done' }), a);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
