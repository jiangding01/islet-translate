import { describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import type { Outcome } from '@/lib/messaging/port';
import type { TranslateChunk, TranslateDone, TranslateRequest } from '@/lib/messaging/protocol';
import {
  type CardPort,
  createCardRequests,
  MAX_SOURCE_LENGTH,
  type RequestEvent,
  reliableLanguage,
  wantsPhonetic,
} from './request';

/** A port whose requests the test answers by hand. */
function fakePort() {
  const sent: {
    payload: TranslateRequest;
    chunk: (chunk: TranslateChunk) => void;
    finish: (outcome: Outcome<TranslateDone>) => void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const port: CardPort = {
    request(payload, onChunk) {
      let finish: (outcome: Outcome<TranslateDone>) => void = () => {};
      const outcome = new Promise<Outcome<TranslateDone>>((resolve) => {
        finish = resolve;
      });
      const cancel = vi.fn(() => finish({ status: 'cancelled' }));
      sent.push({ payload, chunk: (chunk) => onChunk?.(chunk), finish, cancel });
      return { id: String(sent.length), outcome, cancel };
    },
    cancelAll: vi.fn(),
    dispose: vi.fn(),
  };
  return { port, sent };
}

function setup() {
  const { port, sent } = fakePort();
  let source: string | undefined;
  const requests = createCardRequests({ port, currentSource: () => source });
  const events: RequestEvent[] = [];
  const start = (
    text: string,
    extra: { force?: boolean; engine?: 'google'; phonetic?: boolean; target?: 'en' } = {},
  ) => {
    source = text;
    return requests.translate({ source: text, ...extra }, (event) => events.push(event));
  };
  return { port, sent, requests, events, start, setSource: (next: string) => (source = next) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const final = (
  text: string,
  disposition: 'translated' | 'unchanged' | 'same-language' = 'translated',
) => ({ id: 's', text, disposition, cached: false }) as TranslateChunk;

describe('card requests (plan 1.2)', () => {
  it('sends exactly the source, one item, streamed, from auto', () => {
    const t = setup();
    t.start('map');
    expect(t.sent[0]?.payload).toEqual({
      items: [{ id: 's', text: 'map' }],
      source: 'auto',
      stream: true,
    });
    t.start('the whole sentence.', { force: true, engine: 'google' });
    expect(t.sent[1]?.payload).toMatchObject({ force: true, engine: 'google' });
    expect(t.sent[1]?.payload.items[0]?.text).toBe('the whole sentence.');
    expect(t.sent[1]?.payload.target).toBeUndefined();
  });

  it('asks for another target only when told to (the palette’s reversed direction)', () => {
    const t = setup();
    t.start('今天天气很好', { force: true, target: 'en' });
    expect(t.sent[0]?.payload).toMatchObject({ force: true, target: 'en' });
  });

  it('takes the reliably detected top language, or nothing', () => {
    expect(
      reliableLanguage({
        isReliable: true,
        languages: [
          { language: 'ja', percentage: 20 },
          { language: 'zh', percentage: 80 },
        ],
      }),
    ).toBe('zh');
    expect(
      reliableLanguage({ isReliable: false, languages: [{ language: 'zh', percentage: 99 }] }),
    ).toBeUndefined();
    expect(reliableLanguage(undefined)).toBeUndefined();
  });

  it('numbers requests and cancels the previous one before sending', () => {
    const t = setup();
    expect(t.start('one')).toBe(1);
    expect(t.start('two')).toBe(2);
    expect(t.sent[0]?.cancel).toHaveBeenCalledOnce();
    expect(t.requests.current()).toBe(2);
  });

  it('drops frames of a request that is no longer the current one', async () => {
    const t = setup();
    t.start('first');
    const late = t.sent[0];
    t.start('second');
    t.events.length = 0;
    late?.chunk({ id: 's', delta: '第一' });
    late?.chunk(final('第一个'));
    late?.finish({ status: 'error', error: appError('network', 'network/timeout', 'x') });
    await flush();
    expect(t.events).toEqual([]);
  });

  it('drops frames whose source is no longer the card’s', () => {
    const t = setup();
    t.start('first');
    t.setSource('something else');
    t.events.length = 0;
    t.sent[0]?.chunk({ id: 's', delta: 'x' });
    t.sent[0]?.chunk(final('x'));
    expect(t.events).toEqual([]);
  });

  it('accumulates deltas; a reset empties them (no repeats); the final text replaces them', () => {
    const t = setup();
    t.start('hello');
    const r = t.sent[0];
    r?.chunk({ id: 's', delta: '你' });
    r?.chunk({ id: 's', delta: '好' });
    r?.chunk({ id: 's', reset: true });
    r?.chunk({ id: 's', delta: '你好' });
    r?.chunk(final('你好。'));
    expect(t.events).toEqual([
      { kind: 'loading' },
      { kind: 'partial', text: '你' },
      { kind: 'partial', text: '你好' },
      { kind: 'loading' },
      { kind: 'partial', text: '你好' },
      { kind: 'done', text: '你好。', disposition: 'translated' },
    ]);
  });

  it('reports the disposition with the final text', () => {
    const t = setup();
    t.start('你好世界');
    t.sent[0]?.chunk(final('你好世界', 'same-language'));
    expect(t.events.at(-1)).toEqual({
      kind: 'done',
      text: '你好世界',
      disposition: 'same-language',
    });
  });

  it('a failure after deltas is an error event (the card clears the partial text)', () => {
    const t = setup();
    t.start('hello');
    t.sent[0]?.chunk({ id: 's', delta: '半截' });
    const error = appError('provider', 'provider/server-error', 'x');
    t.sent[0]?.chunk({ id: 's', error });
    expect(t.events.at(-1)).toEqual({ kind: 'error', error });
  });

  it('never sends more than 2000 characters', () => {
    const t = setup();
    expect(t.start('a'.repeat(MAX_SOURCE_LENGTH + 1))).toBe(0);
    expect(t.sent).toHaveLength(0);
    expect(t.events).toEqual([{ kind: 'too-long' }]);
    t.start('a'.repeat(MAX_SOURCE_LENGTH));
    expect(t.sent).toHaveLength(1);
  });

  it('retries once on a disconnected port (service worker restart), from scratch', async () => {
    const t = setup();
    t.start('hello');
    t.sent[0]?.chunk({ id: 's', delta: '你' });
    const lost = appError('network', 'network/port-disconnected', 'x', { retryable: true });
    t.sent[0]?.finish({ status: 'error', error: lost });
    await flush();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.payload).toEqual(t.sent[0]?.payload);
    expect(t.events.slice(-1)).toEqual([{ kind: 'loading' }]);
    t.sent[1]?.finish({ status: 'error', error: lost });
    await flush();
    expect(t.sent).toHaveLength(2);
    expect(t.events.at(-1)).toEqual({ kind: 'error', error: lost });
  });

  it('maps an invalidated context to the page-unreachable message', async () => {
    const t = setup();
    t.start('hello');
    t.sent[0]?.finish({
      status: 'error',
      error: appError('internal', 'internal/context-invalidated', 'x'),
    });
    await flush();
    expect(t.events.at(-1)).toMatchObject({
      kind: 'error',
      error: { code: 'network/page-unreachable' },
    });
  });

  it('cancel drops what is in flight; dispose closes the port', async () => {
    const t = setup();
    t.start('hello');
    t.requests.cancel();
    expect(t.sent[0]?.cancel).toHaveBeenCalled();
    t.events.length = 0;
    t.sent[0]?.chunk(final('x'));
    expect(t.events).toEqual([]);
    t.requests.dispose();
    expect(t.port.dispose).toHaveBeenCalled();
  });
});

describe('phonetic (single English words)', () => {
  const base = { source: 'map', target: 'zh-CN', detected: 'en', pageLanguage: '' };

  it.each([
    ['a word detected as English', base, true],
    ['a word with punctuation, any case', { ...base, source: '“Maps,”' }, true],
    ['a regional English tag', { ...base, detected: 'en-GB' }, true],
    ['an unknown target (config not read yet)', { ...base, target: undefined }, true],
    [
      'undetected, on a page declaring English',
      { ...base, detected: undefined, pageLanguage: 'en-US' },
      true,
    ],
    [
      'undetected, on a page declaring English with _',
      { ...base, detected: undefined, pageLanguage: 'EN_us' },
      true,
    ],
    ['undetected, on a page declaring nothing', { ...base, detected: undefined }, true],
    [
      'undetected, on a Chinese page (Google results in Chinese)',
      { ...base, detected: undefined, pageLanguage: 'zh-CN' },
      true,
    ],
    ['undetected, on a Japanese page', { ...base, detected: undefined, pageLanguage: 'ja' }, true],
    [
      'undetected, on a French page',
      { ...base, detected: undefined, pageLanguage: 'fr-FR' },
      false,
    ],
    ['undetected, on a German page', { ...base, detected: undefined, pageLanguage: 'de' }, false],
    [
      'detected as another language on an English page',
      { ...base, detected: 'fr', pageLanguage: 'en' },
      false,
    ],
    ['an English target', { ...base, target: 'en' }, false],
    ['two words', { ...base, source: 'paper map' }, false],
    ['a hyphenated word', { ...base, source: 'well-known' }, false],
    ['a non-Latin word', { ...base, source: '地图' }, false],
  ])('%s → %s', (_name, args, expected) => {
    expect(wantsPhonetic(args)).toBe(expected);
  });

  it('asks for it in the payload only when told to', () => {
    const t = setup();
    t.start('map');
    expect(t.sent[0]?.payload.phonetic).toBeUndefined();
    t.start('map', { phonetic: true });
    expect(t.sent[1]?.payload).toMatchObject({ phonetic: true, stream: true });
  });

  it('passes the phonetic on before and after the final chunk, without ending anything', async () => {
    const t = setup();
    t.start('absented', { phonetic: true });
    const request = t.sent[0];
    request?.chunk({ id: 's', phonetic: { uk: 'ˈæbsənt', us: 'ˈæbsənt' }, lemma: 'absent' });
    request?.chunk({ id: 's', delta: '缺' });
    request?.chunk(final('缺席'));
    request?.chunk({ id: 's', phonetic: { us: 'æbˈsentɪd' } });
    request?.finish({ status: 'done', data: { total: 1, failed: 0 } });
    await flush();
    expect(t.events).toEqual([
      { kind: 'loading' },
      { kind: 'phonetic', uk: 'ˈæbsənt', us: 'ˈæbsənt', lemma: 'absent' },
      { kind: 'partial', text: '缺' },
      { kind: 'done', text: '缺席', disposition: 'translated' },
      { kind: 'phonetic', uk: undefined, us: 'æbˈsentɪd', lemma: undefined },
    ]);
  });

  it('drops the phonetic of a request the card moved on from', () => {
    const t = setup();
    t.start('map', { phonetic: true });
    const late = t.sent[0];
    t.start('road', { phonetic: true });
    t.events.length = 0;
    late?.chunk({ id: 's', phonetic: { uk: 'mæp' } });
    expect(t.events).toEqual([]);
  });
});
