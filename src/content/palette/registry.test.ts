import { describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import type { PageState } from '@/lib/messaging/protocol';
import { IDLE_PAGE_STATE, type PageActions } from '../runtime-contract';
import { COMMANDS, listCommands, normalizeQuery, type PaletteContext } from './registry';

const ctxOf = (state: Partial<PageState>): PaletteContext => ({
  state: { ...IDLE_PAGE_STATE, ...state },
});
const ids = (ctx: PaletteContext, query = '') => listCommands(ctx, query).map((c) => c.id);

describe('availability and order (empty input)', () => {
  // Quick translate (PR3) adds the seventh context: its result is not part of PR1's context.
  it.each([
    ['idle', {}, ['page.translate', 'engine.switch']],
    [
      'a whole-page session in bilingual mode',
      { phase: 'running', engine: 'google' },
      ['page.restore', 'view.translationOnly', 'engine.switch'],
    ],
    [
      'a finished session showing translations only',
      { phase: 'done', mode: 'translation' },
      ['page.restore', 'view.bilingual', 'engine.switch'],
    ],
    [
      'failed paragraphs (retry first)',
      { phase: 'done', failed: 3 },
      ['retry.failed', 'page.restore', 'view.translationOnly', 'engine.switch'],
    ],
    [
      'an engine-level error (retry first)',
      {
        phase: 'running',
        engineError: appError('provider', 'provider/unauthorized', 'x'),
      },
      ['retry.failed', 'page.restore', 'view.translationOnly', 'engine.switch'],
    ],
    [
      'held paragraphs only (a local session)',
      { phase: 'done', scope: 'units' },
      ['page.translate', 'page.restore', 'engine.switch'],
    ],
    ['a halted session: nothing at all', { phase: 'running', halted: true }, []],
  ] as [string, Partial<PageState>, string[]][])('%s', (_label, state, expected) => {
    expect(ids(ctxOf(state))).toEqual(expected);
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

  it('normalizes: trimmed, lower case, a leading slash only filters', () => {
    expect(normalizeQuery('  /Retry ')).toBe('retry');
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

  it('puts title prefix matches before other matches, then rank, then table order', () => {
    // 显示原文… starts with 显示; nothing else does. 翻译 is inside two titles.
    expect(ids(running, '显示')).toEqual(['page.restore']);
    expect(ids(running, '翻译')).toEqual(['page.restore', 'engine.switch']);
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
    return { page, engines: vi.fn() };
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
