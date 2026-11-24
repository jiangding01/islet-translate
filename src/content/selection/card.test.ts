// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultConfig } from '@/lib/config/defaults';
import type { ConfigV1 } from '@/lib/config/types';
import { withUserMessage } from '@/lib/error-messages';
import { appError } from '@/lib/errors';
import type { DetectedLanguages } from '@/lib/languages';
import type { Outcome } from '@/lib/messaging/port';
import type {
  EngineOptions,
  TranslateChunk,
  TranslateDone,
  TranslateRequest,
} from '@/lib/messaging/protocol';
import { createGetMessage, loadLocales } from '../../../scripts/i18n-messages.mjs';
import type { SelectionRuntime, SelectionSnapshot } from '../runtime-contract';
import { type CardEnv, createSelectionCard } from './card';
import { extractText } from './extract';
import { normalizeSelectionText } from './open';
import type { CardPort } from './request';
import { SETTLE_MS, START_TIMEOUT_MS } from './speech';

const ENGINES: EngineOptions = {
  configured: 'deepseek',
  options: [
    { id: 'google', name: 'Google 翻译', short: 'G', ready: true },
    { id: 'openai', name: 'OpenAI', short: 'AI', ready: false, note: '未配置密钥' },
    { id: 'deepseek', name: 'DeepSeek', short: 'DS', ready: true },
  ],
};

/** Google with a two-part icon (one part in the text color); the others without one. */
const WITH_ICONS: EngineOptions = {
  ...ENGINES,
  options: ENGINES.options.map((option) =>
    option.id === 'google'
      ? {
          ...option,
          icon: {
            viewBox: '0 0 24 24',
            paths: [{ d: 'M0 0h9z', fill: '#4285F4' }, { d: 'M1 1h9z' }],
          },
        }
      : option,
  ),
};

const RECT = { left: 100, top: 200, right: 300, bottom: 224 };

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

function fakeSynth(voices: unknown[]) {
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => voices,
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      synth.speaking = true;
      utterance.onstart?.({} as SpeechSynthesisEvent);
    }),
    cancel: vi.fn(() => {
      synth.speaking = false;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return synth;
}

interface Options {
  detection?: DetectedLanguages;
  voices?: unknown[];
  trusted?: boolean;
  background?: string;
  writeClipboard?: (text: string) => Promise<void>;
  config?: (config: ConfigV1) => void;
}

const cleanups: (() => void)[] = [];

function setup(options: Options = {}) {
  const frames = new Map<number, () => void>();
  let handle = 0;
  let clock = 0;
  const config = createDefaultConfig('zh-CN');
  config.translation.engine = 'deepseek';
  options.config?.(config);
  const { port, sent } = fakePort();
  const synth = fakeSynth(options.voices ?? ['voice']);
  let trusted = options.trusted ?? true;
  const deps = {
    getConfig: vi.fn(async () => config),
    watchConfig: vi.fn(() => vi.fn()),
    listEngines: vi.fn(async () => ENGINES),
    detectLanguage: vi.fn(
      async (): Promise<DetectedLanguages> =>
        options.detection ?? { isReliable: true, languages: [{ language: 'en', percentage: 98 }] },
    ),
  };
  const env: CardEnv = {
    win: window,
    raf: (callback) => {
      frames.set(++handle, callback);
      return handle;
    },
    cancelRaf: (id) => {
      frames.delete(id);
    },
    now: () => clock,
    matchMedia: () => ({ matches: false }),
    elementsFromPoint: () => [document.body],
    getComputedStyle: () =>
      ({
        position: 'static',
        bottom: 'auto',
        backgroundColor: options.background ?? 'rgb(255, 255, 255)',
        colorScheme: 'normal',
      }) as CSSStyleDeclaration,
    shadowMode: 'open',
    isTrusted: () => trusted,
    speech: {
      synth,
      createUtterance: (text) =>
        ({
          text,
          lang: '',
          onstart: null,
          onend: null,
          onerror: null,
        }) as unknown as SpeechSynthesisUtterance,
    },
    writeClipboard: options.writeClipboard ?? vi.fn(async () => {}),
  };
  const card: SelectionRuntime = createSelectionCard({ deps, port, env });
  cleanups.push(() => card.dispose());

  /** Runs animation frames until the shape rests (or `max` frames). */
  const run = (max = 200) => {
    for (let i = 0; i < max && frames.size > 0; i += 1) {
      const batch = [...frames.values()];
      frames.clear();
      clock += 16;
      for (const callback of batch) callback();
    }
  };
  const host = () => document.querySelector('et-selection') as HTMLElement | null;
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    host()?.shadowRoot?.querySelector(selector) as T | null;
  const view = () => $('.r')?.getAttribute('data-view') ?? 'gone';
  const click = (selector: string) =>
    $(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return {
    card,
    deps,
    port,
    sent,
    synth,
    config,
    run,
    host,
    $,
    view,
    click,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    advance: (ms: number) => {
      clock += ms;
      return vi.advanceTimersByTimeAsync(ms);
    },
  };
}

/** A selection of `node` (or a text node's [start, end)) as the bootstrap snapshots it. */
function snapshotOf(node: Node, start?: number, end?: number): SelectionSnapshot {
  const range = document.createRange();
  if (start !== undefined) {
    range.setStart(node, start);
    range.setEnd(node, end ?? (node as Text).data.length);
  } else range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return {
    source: normalizeSelectionText(selection?.toString() ?? ''),
    rect: { ...RECT },
    // The bottom right of the last character, as the watch takes it.
    anchor: { x: RECT.right, y: RECT.bottom },
    range: range.cloneRange(),
  };
}

const SENTENCE = 'A paper map never tells you where to go.';

function page() {
  document.body.innerHTML = `<p id="p">${SENTENCE}</p><p id="q">It shows you everything at once and lets you decide.</p>`;
  return {
    p: (document.getElementById('p') as HTMLElement).firstChild as Text,
    q: (document.getElementById('q') as HTMLElement).firstChild as Text,
  };
}

const final = (
  text: string,
  disposition: 'translated' | 'unchanged' | 'same-language' = 'translated',
) => ({ id: 's', text, disposition, cached: false }) as TranslateChunk;

/** Shows the dot for `snapshot` and waits for the language check. */
async function dot(t: ReturnType<typeof setup>, snapshot: SelectionSnapshot) {
  t.card.showDot(snapshot);
  await t.advance(0);
  t.run();
}

beforeEach(() => {
  vi.useFakeTimers();
  const proto = Range.prototype as unknown as Record<string, unknown>;
  const original = proto.getClientRects;
  proto.getClientRects = () => [{ ...RECT, width: 200, height: 24, x: 100, y: 200 }];
  cleanups.push(() => {
    proto.getClientRects = original;
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = '';
  for (const element of [...document.documentElement.children]) {
    if (element !== document.head && element !== document.body) element.remove();
  }
  vi.useRealTimers();
});

describe('hard rules (plan 1.2)', () => {
  it('request text === source line === extraction, for a word, half a sentence and a sentence', async () => {
    const { p } = page();
    for (const [start, end] of [
      [8, 11],
      [0, 20],
      [0, SENTENCE.length],
    ] as const) {
      const t = setup();
      const snapshot = snapshotOf(p, start, end);
      const extracted = extractText(snapshot.range as Range, window, snapshot.source);
      t.card.open({ source: snapshot.source, selection: snapshot });
      const sent = t.sent.at(-1)?.payload.items[0]?.text;
      expect(sent).toBe(SENTENCE.slice(start, end));
      expect(sent).toBe(extracted);
      expect(t.$('.st')?.textContent).toBe(extracted);
      t.card.dispose();
    }
  });

  it('uses what the user sees: hidden original text never reaches the request', async () => {
    document.body.innerHTML =
      '<p id="p" data-et-only="">The original sentence.<et-tr data-et-s="">原来的句子。</et-tr></p>';
    const t = setup();
    const snapshot = snapshotOf(document.getElementById('p') as HTMLElement);
    expect(snapshot.source).toContain('The original');
    await dot(t, snapshot);
    t.click('.zn');
    expect(t.sent[0]?.payload.items[0]?.text).toBe('原来的句子。');
    expect(t.$('.st')?.textContent).toBe('原来的句子。');
  });

  it('asks nothing while only the dot shows; the card requests when it opens', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    expect(t.view()).toBe('dot');
    expect(t.sent).toHaveLength(0);
    t.click('.zn');
    expect(t.view()).toBe('card');
    expect(t.sent).toHaveLength(1);
    // The dot path does not force: the background may skip the same language.
    expect(t.sent[0]?.payload.force).toBeUndefined();
  });

  it('cancels the old request and drops its late results', async () => {
    const { p, q } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.click('[data-act="pin"]');
    // Pinned: a new selection the user made translates in place.
    window.dispatchEvent(new PointerEvent('pointerup'));
    await dot(t, snapshotOf(q, 0, 8));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]?.cancel).toHaveBeenCalled();
    t.sent[0]?.chunk({ id: 's', delta: '地图' });
    t.sent[0]?.chunk(final('地图'));
    expect(t.$('.tw')).toBeNull();
    expect(t.$('.st')?.textContent).toBe('It shows');
    t.sent[1]?.chunk(final('它展示了'));
    expect(t.$('.tw')?.textContent).toBe('它展示了');
  });

  it('a reset clears what streamed: nothing is shown twice', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    const r = t.sent[0];
    r?.chunk({ id: 's', delta: '纸质地图' });
    expect(t.$('.tw')?.textContent).toBe('纸质地图');
    expect(t.$('.cr')).not.toBeNull();
    r?.chunk({ id: 's', reset: true });
    expect(t.$('.tw')).toBeNull();
    expect(t.$('.sk')).not.toBeNull();
    r?.chunk({ id: 's', delta: '纸质地图' });
    r?.chunk({ id: 's', delta: '从不' });
    expect(t.$('.tw')?.textContent).toBe('纸质地图从不');
    r?.chunk(final('纸质地图从不告诉你该往哪走。'));
    expect(t.$('.tw')?.textContent).toBe('纸质地图从不告诉你该往哪走。');
    expect(t.$('.cr')).toBeNull();
  });

  it('a failure clears the half-done translation', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    t.sent[0]?.chunk({ id: 's', delta: '纸质地图从' });
    // As the background sends it: with the copy attached (src/content/error-text.ts).
    t.sent[0]?.chunk({
      id: 's',
      error: withUserMessage(appError('provider', 'provider/server-error', 'x')),
    });
    expect(t.$('.tw')).toBeNull();
    expect(t.$('.er')?.textContent).toContain('翻译服务暂时出错');
    expect(t.$('[data-act="copy"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('same-language and unchanged are notices with the source, never a translation', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    t.sent[0]?.chunk(final(SENTENCE, 'same-language'));
    expect(t.$('.tw')).toBeNull();
    expect(t.$('.nc')?.textContent).toBe('这段文字已经是 简体中文，不需要翻译。');
    expect(t.$('.st')?.getAttribute('aria-expanded')).toBe('true');
    expect(t.$('[data-act="copy"]')?.getAttribute('aria-disabled')).toBe('true');
    t.click('[data-act="retry"]');
    t.card.open({ source: '12345', selection: snapshotOf(p, 0, 5) });
    t.sent.at(-1)?.chunk(final('A pap', 'unchanged'));
    expect(t.$('.nc')?.textContent).toBe('这段文字不需要翻译。');
    expect(t.$('.tw')).toBeNull();
  });

  it('never sends more than 2000 characters: the card says so, untruncated', () => {
    const t = setup();
    const long = 'word '.repeat(450).trim();
    t.card.open({ source: long });
    expect(t.sent).toHaveLength(0);
    expect(t.$('.nc')?.textContent).toBe(
      '选中的文字太长（超过 2000 字），请缩小选区，或用整页翻译。',
    );
    expect(t.$('.st')?.textContent).toBe(long);
  });

  it('one source for every path: the dot and the menu agree on a ruby reading alone', async () => {
    document.body.innerHTML = '<p id="p">東京<ruby>漢<rt id="rt">かん</rt></ruby>字です</p>';
    const rt = (document.getElementById('rt') as HTMLElement).firstChild as Text;
    const viaDot = setup();
    await dot(viaDot, snapshotOf(rt));
    viaDot.click('.zn');
    const fromDot = viaDot.sent[0]?.payload.items[0]?.text;
    viaDot.card.dispose();
    const viaMenu = setup();
    const snapshot = snapshotOf(rt);
    viaMenu.card.open({ source: snapshot.source, selection: snapshot });
    expect(fromDot).toBe('かん');
    expect(viaMenu.sent[0]?.payload.items[0]?.text).toBe(fromDot);
    expect(viaMenu.$('.st')?.textContent).toBe(fromDot);
  });

  it('a pinned card retranslates only after a real gesture, never for a script moving the selection', async () => {
    const { p, q } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.click('[data-act="pin"]');
    // A page script cycling the selection: selectionchange only, no gesture.
    for (let i = 0; i < 4; i += 1) {
      const text = i % 2 ? p : q;
      document.getSelection()?.selectAllChildren(text.parentNode as Node);
      await dot(t, snapshotOf(text, 0, 8));
    }
    expect(t.sent).toHaveLength(1);
    // A forged pointerup is no gesture either.
    t.setTrusted(false);
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    t.setTrusted(true);
    await dot(t, snapshotOf(q, 0, 8));
    expect(t.sent).toHaveLength(1);
    // A gesture too long ago does not count.
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await t.advance(1500);
    await dot(t, snapshotOf(q, 0, 8));
    expect(t.sent).toHaveLength(1);
    // The user's own release: the pinned card translates the new selection.
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await dot(t, snapshotOf(q, 0, 8));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.payload.items[0]?.text).toBe('It shows');
  });

  it('menu and shortcut force the translation; the dot path does not', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    expect(t.sent[0]?.payload.force).toBe(true);
  });
});

describe('dot', () => {
  it('opens on hover only after the pointer left it first', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    const zone = t.$('.zn') as HTMLElement;
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
    // Away (more than 14px from the dot), then back and rest 300ms.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 400 }));
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(250);
    expect(t.view()).toBe('dot');
    await t.advance(60);
    expect(t.view()).toBe('card');
  });

  /** The dot's center, from its 28px round hit zone. */
  const dotAt = (t: ReturnType<typeof setup>) => {
    const zone = t.$('.zn') as HTMLElement;
    return {
      x: Number.parseFloat(zone.style.left) + 14,
      y: Number.parseFloat(zone.style.top) + 14,
    };
  };
  /** The dot for `RECT`: on the last line's bottom edge, 7px right of the last character. */
  const DOT_AT = { x: RECT.right + 7, y: RECT.bottom };
  /** A drag over `RECT` let go on its last character: inside the dot's 14px zone. */
  const ON_END = { x: RECT.right - 1, y: RECT.bottom - 4 };
  /** A drag let go in the blank space right of the line's end: far outside the zone. */
  const IN_BLANK = { x: RECT.right + 160, y: (RECT.top + RECT.bottom) / 2 };

  it('sits at the bottom right of the last character and never moves for the release', async () => {
    const { p } = page();
    for (const pointer of [ON_END, IN_BLANK, undefined]) {
      const t = setup();
      await dot(t, { ...snapshotOf(p, 8, 11), pointer });
      expect(dotAt(t)).toEqual(DOT_AT);
      t.card.dispose();
    }
  });

  it('opens 300ms after the pointer comes in from outside, no other move needed', async () => {
    const { p } = page();
    const t = setup();
    // Released out in the blank space: already outside, so coming in is a visit.
    await dot(t, { ...snapshotOf(p, 8, 11), pointer: IN_BLANK });
    const zone = t.$('.zn') as HTMLElement;
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(250);
    expect(t.view()).toBe('dot');
    await t.advance(60);
    expect(t.view()).toBe('card');
  });

  it('a hand resting where the drag ended never opens it', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, { ...snapshotOf(p, 8, 11), pointer: ON_END });
    // The zone appears under the still pointer (Chrome sends pointerenter for that) and the
    // browser may repeat the resting position (a synthetic move): still nothing.
    t.$('.zn')?.dispatchEvent(new PointerEvent('pointerenter'));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: ON_END.x, clientY: ON_END.y }));
    await t.advance(1000);
    expect(t.view()).toBe('dot');
    expect(t.sent).toHaveLength(0);
  });

  it('released in the blank space and left there: nothing opens', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, { ...snapshotOf(p, 8, 11), pointer: IN_BLANK });
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: IN_BLANK.x, clientY: IN_BLANK.y }),
    );
    await t.advance(1000);
    expect(t.view()).toBe('dot');
    expect(t.sent).toHaveLength(0);
  });

  it('a pointer already on the dot when it appears must leave and come back', async () => {
    const { p, q } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    const at = dotAt(t);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: at.x + 3, clientY: at.y }));
    // The next selection's dot shows up right under it.
    await dot(t, snapshotOf(q, 0, 8));
    const zone = t.$('.zn') as HTMLElement;
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
    // Still inside the 14px circle (a diagonal the old square counted as outside): no.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: at.x + 9, clientY: at.y + 9 }));
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
    // Just outside the 14px circle, then back in.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: at.x + 15, clientY: at.y }));
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(310);
    expect(t.view()).toBe('card');
  });

  it('a click opens it at once, even before the pointer was seen outside', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, { ...snapshotOf(p, 8, 11), pointer: ON_END });
    t.click('.zn');
    expect(t.view()).toBe('card');
    expect(t.sent).toHaveLength(1);
  });

  it('scrolled under a resting pointer, the dot must see it leave and come back', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    const at = dotAt(t);
    // The pointer rests 50px above the dot: outside it, so the dot is armed.
    const rest = { clientX: at.x, clientY: at.y - 50 };
    window.dispatchEvent(new PointerEvent('pointermove', rest));
    // The page scrolls 50px: the dot follows its selection right under the pointer.
    const proto = Range.prototype as unknown as Record<string, unknown>;
    proto.getClientRects = () => [
      { left: 100, top: 150, right: 300, bottom: 174, width: 200, height: 24 },
    ];
    window.dispatchEvent(new Event('scroll'));
    t.run();
    expect(dotAt(t)).toEqual({ x: at.x, y: at.y - 50 });
    expect(dotAt(t)).toEqual({ x: DOT_AT.x, y: DOT_AT.y - 50 });
    // Chrome then sends pointerenter for the element now under the still pointer.
    const zone = t.$('.zn') as HTMLElement;
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
    // Out and back in: a real visit opens it.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: at.x + 40, clientY: at.y }));
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(310);
    expect(t.view()).toBe('card');
  });

  it('a pointer position from before the dot was mounted does not arm it', async () => {
    const { p, q } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, clientY: 700 }));
    t.card.hideDot();
    t.run();
    expect(t.host()).toBeNull();
    // The drag that makes the next selection ends on the new dot, unseen while unmounted.
    await dot(t, snapshotOf(q, 0, 8));
    t.$('.zn')?.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
  });

  it('a dot that jumps to a new selection drops the old hover timer', async () => {
    const { p, q } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 400 }));
    t.$('.zn')?.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(250);
    await dot(t, snapshotOf(q, 0, 8));
    await t.advance(100);
    expect(t.view()).toBe('dot');
    expect(t.sent).toHaveLength(0);
  });

  it('is a layer of its own: data-open while it shows, so one Escape closes only the dot', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    const host = t.host() as HTMLElement;
    expect(host.hasAttribute('data-open')).toBe(true);
    let seen: boolean | undefined;
    window.addEventListener(
      'keydown',
      () => {
        seen = host.hasAttribute('data-open');
      },
      { once: true },
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(seen).toBe(true);
    await t.advance(0);
    expect(host.hasAttribute('data-open')).toBe(false);
  });

  it('a short visit does not open it', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 400 }));
    const zone = t.$('.zn') as HTMLElement;
    zone.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(200);
    zone.dispatchEvent(new PointerEvent('pointerleave'));
    await t.advance(400);
    expect(t.view()).toBe('dot');
  });

  it('is not shown for text already in the target language', async () => {
    document.body.innerHTML = '<p id="p">这是一段已经是简体中文的文字。</p>';
    const t = setup({
      detection: { isReliable: true, languages: [{ language: 'zh-CN', percentage: 99 }] },
    });
    await dot(t, snapshotOf(document.getElementById('p') as HTMLElement));
    expect(t.host()).toBeNull();
  });

  it('ignores untrusted clicks and presses (page scripts)', async () => {
    const { p } = page();
    const t = setup({ trusted: false });
    await dot(t, snapshotOf(p, 8, 11));
    t.click('.zn');
    expect(t.view()).toBe('dot');
  });

  it('keeps the page selection and focus: pointerdown and mousedown are prevented', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    for (const type of ['pointerdown', 'mousedown']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      t.$('.zn')?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    t.click('.zn');
    for (const type of ['pointerdown', 'mousedown']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      t.$('[data-act="copy"]')?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    for (const button of t.host()?.shadowRoot?.querySelectorAll('button') ?? []) {
      expect(button.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('a closed selection does not pop up again until it is really gone', async () => {
    const { p } = page();
    const t = setup();
    const snapshot = snapshotOf(p, 8, 11);
    await dot(t, snapshot);
    t.click('.zn');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.advance(200);
    t.run();
    expect(t.host()).toBeNull();
    await dot(t, snapshotOf(p, 8, 11));
    expect(t.host()).toBeNull();
    // The selection went away and came back: a fresh selection.
    t.card.hideDot();
    await dot(t, snapshotOf(p, 8, 11));
    expect(t.view()).toBe('dot');
  });

  it('hideDot removes the dot but never an open card', async () => {
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    t.card.hideDot();
    t.run();
    expect(t.host()).toBeNull();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.card.hideDot();
    expect(t.view()).toBe('card');
  });
});

describe('card', () => {
  it('mounts a host under <html> with inline !important styles, raised on every open', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    const host = t.host() as HTMLElement;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(host.hasAttribute('data-open')).toBe(true);
    const other = document.createElement('et-isle');
    document.documentElement.append(other);
    t.card.open({ source: 'paper', selection: snapshotOf(p, 2, 7) });
    expect(document.documentElement.lastElementChild).toBe(host);
    other.remove();
  });

  it('writes the theme explicitly: light, or dark on a dark page', () => {
    const { p } = page();
    const light = setup();
    light.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    expect(light.host()?.getAttribute('data-et-theme')).toBe('light');
    light.card.dispose();
    const dark = setup({ background: 'rgb(15, 17, 21)' });
    dark.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    expect(dark.host()?.getAttribute('data-et-theme')).toBe('dark');
  });

  it('shows the direction and the engine, and switches the engine for this card only', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    expect(t.$('.dir')?.textContent).toBe('English→简体中文');
    expect(t.$('.eb')?.textContent).toBe('DS');
    t.click('[data-act="engine"]');
    expect(t.$('.r')?.hasAttribute('data-list')).toBe(true);
    // Escape closes the list first, the card stays.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(t.$('.r')?.hasAttribute('data-list')).toBe(false);
    expect(t.view()).toBe('card');
    t.click('[data-act="engine"]');
    t.click('[data-id="google"]');
    expect(t.sent.at(-1)?.payload.engine).toBe('google');
    expect(t.config.translation.engine).toBe('deepseek');
    expect(t.$('.eb')?.textContent).toBe('G');
  });

  it('shows the engine as its vendor icon, or its short label without one', async () => {
    const { p } = page();
    const t = setup();
    t.deps.listEngines.mockResolvedValue(WITH_ICONS);
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    const engine = () => t.$('.eb') as HTMLElement;
    expect(engine().querySelector('.pf')?.textContent).toBe('DS');
    expect(engine().querySelector('svg.pi')).toBeNull();
    expect(engine().getAttribute('aria-label')).toBe('引擎：DeepSeek（点击切换）');

    t.click('[data-act="engine"]');
    const row = (id: string) => t.$(`.o[data-id="${id}"]`) as HTMLElement;
    expect(row('google').firstElementChild?.matches('svg.pi')).toBe(true);
    expect(row('google').querySelectorAll('path')).toHaveLength(2);
    expect(row('deepseek').firstElementChild?.matches('.pf')).toBe(true);
    expect(row('deepseek').querySelector('.nm')?.textContent).toBe('DeepSeek');
    expect(row('openai').querySelector('.pf')?.textContent).toBe('AI');

    t.click('[data-id="google"]');
    const icon = engine().querySelector('svg.pi');
    expect(icon).not.toBeNull();
    expect(
      [...(icon?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('fill')),
    ).toEqual(['#4285F4', 'currentColor']);
    expect(engine().querySelector('.pf')).toBeNull();
    expect(engine().textContent).toBe('');
    expect(engine().getAttribute('aria-label')).toBe('引擎：Google 翻译（点击切换）');
  });

  it('says "auto-detect" when the detection is not reliable', async () => {
    const { p } = page();
    const t = setup({ detection: { isReliable: false, languages: [] } });
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    await t.advance(0);
    expect(t.$('.dir')?.textContent).toBe('自动检测→简体中文');
  });

  it('says "auto-detect" for a reliable language outside the panel’s list', async () => {
    const { p } = page();
    const t = setup({
      detection: { isReliable: true, languages: [{ language: 'fr', percentage: 97 }] },
    });
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    expect(t.$('.dir')?.textContent).toBe('自动检测→简体中文');
  });

  it('names Traditional Chinese and Japanese as the panel does', async () => {
    const { p } = page();
    const t = setup({
      detection: { isReliable: true, languages: [{ language: 'zh-Hant', percentage: 95 }] },
      config: (config) => {
        config.language.target = 'ja';
      },
    });
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    expect(t.$('.dir')?.textContent).toBe('繁體中文→日本語');
  });

  it("shows the background's userMessage as text, else the generic sentence", async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    t.sent[0]?.chunk({
      id: 's',
      error: {
        ...appError('provider', 'provider/unauthorized', 'x'),
        userMessage: '密钥<i>无效</i>',
      },
    });
    await t.advance(0);
    expect(t.$('.er')?.textContent).toContain('密钥<i>无效</i>');
    expect(t.$('.er i')).toBeNull();
    t.click('[data-act="retry"]');
    t.sent.at(-1)?.chunk({ id: 's', error: appError('provider', 'provider/unauthorized', 'x') });
    await t.advance(0);
    expect(t.$('.er')?.textContent).toContain('操作失败，请重试。');
  });

  it('offers retry and Google after an error; the page-unreachable message on a dead context', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    t.sent[0]?.finish({
      status: 'error',
      error: appError('internal', 'internal/context-invalidated', 'x'),
    });
    await t.advance(0);
    expect(t.$('.er')?.textContent).toContain('无法连接页面，请刷新网页后重试');
    t.click('[data-act="google"]');
    expect(t.sent.at(-1)?.payload.engine).toBe('google');
    t.sent.at(-1)?.chunk({ id: 's', error: appError('network', 'network/timeout', 'x') });
    // Already Google: only retry.
    expect(t.$('[data-act="google"]')).toBeNull();
    t.click('[data-act="retry"]');
    expect(t.sent.at(-1)?.payload.engine).toBe('google');
  });

  it('closes on an outside press unless pinned; Escape closes a pinned one too', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await t.advance(200);
    t.run();
    expect(t.host()).toBeNull();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.click('[data-act="pin"]');
    expect(t.$('[data-act="pin"]')?.getAttribute('aria-label')).toBe('取消固定');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await t.advance(200);
    expect(t.view()).toBe('card');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.advance(200);
    t.run();
    expect(t.host()).toBeNull();
  });

  it('keeps data-open through the Escape that closes it, so the isle leaves its layer', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    const host = t.host() as HTMLElement;
    let seen: boolean | undefined;
    window.addEventListener(
      'keydown',
      () => {
        seen = host.hasAttribute('data-open');
      },
      { once: true },
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(seen).toBe(true);
    await t.advance(0);
    expect(host.hasAttribute('data-open')).toBe(false);
  });

  it('closes when the selection scrolls out of the viewport, follows it otherwise', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.run();
    const before = t.$('.cw')?.style.transform;
    const proto = Range.prototype as unknown as Record<string, unknown>;
    proto.getClientRects = () => [
      { left: 100, top: 150, right: 300, bottom: 174, width: 200, height: 24 },
    ];
    window.dispatchEvent(new Event('scroll'));
    t.run();
    expect(t.view()).toBe('card');
    expect(t.$('.cw')?.style.transform).not.toBe(before);
    proto.getClientRects = () => [
      { left: 100, top: -60, right: 300, bottom: -36, width: 200, height: 24 },
    ];
    window.dispatchEvent(new Event('scroll'));
    t.run(1);
    await t.advance(200);
    t.run();
    expect(t.host()).toBeNull();
  });

  describe('scrolled out and back (parked)', () => {
    const proto = () => Range.prototype as unknown as Record<string, unknown>;
    const at = (top: number) => {
      proto().getClientRects = () => [
        { left: 100, top, right: 300, bottom: top + 24, width: 200, height: 24 },
      ];
    };
    const scroll = async (t: ReturnType<typeof setup>) => {
      window.dispatchEvent(new Event('scroll'));
      t.run(1);
      await t.advance(200);
      t.run();
    };

    it('the card folds away when its selection leaves; back in view, the dot returns', async () => {
      const { p } = page();
      const t = setup();
      await dot(t, snapshotOf(p, 8, 11));
      t.click('.zn');
      t.run();
      expect(t.view()).toBe('card');
      expect(t.sent).toHaveLength(1);
      at(-60);
      await scroll(t);
      expect(t.host()).toBeNull();
      at(150);
      await scroll(t);
      expect(t.view()).toBe('dot');
      // Only the dot: nothing is asked for again.
      expect(t.sent).toHaveLength(1);
      // Back and forth again still works.
      at(-60);
      await scroll(t);
      expect(t.host()).toBeNull();
      at(160);
      await scroll(t);
      expect(t.view()).toBe('dot');
    });

    it('back in view under a resting pointer, the dot still waits for it to come in', async () => {
      const { p } = page();
      const t = setup();
      // Released out in the blank space when it first showed (armed then); that position
      // is stale by the time it returns.
      await dot(t, { ...snapshotOf(p, 8, 11), pointer: { x: RECT.right + 160, y: 212 } });
      at(-60);
      await scroll(t);
      at(200);
      await scroll(t);
      expect(t.view()).toBe('dot');
      t.$('.zn')?.dispatchEvent(new PointerEvent('pointerenter'));
      await t.advance(400);
      expect(t.view()).toBe('dot');
      expect(t.sent).toHaveLength(0);
    });

    it('a dot scrolled out and back comes back too', async () => {
      const { p } = page();
      const t = setup();
      await dot(t, snapshotOf(p, 8, 11));
      at(900);
      await scroll(t);
      expect(t.host()).toBeNull();
      at(300);
      await scroll(t);
      expect(t.view()).toBe('dot');
      expect(t.sent).toHaveLength(0);
    });

    it('closed with Escape: scrolling never brings it back', async () => {
      const { p } = page();
      const t = setup();
      await dot(t, snapshotOf(p, 8, 11));
      t.click('.zn');
      t.run();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await t.advance(200);
      t.run();
      expect(t.host()).toBeNull();
      at(-60);
      await scroll(t);
      at(150);
      await scroll(t);
      expect(t.host()).toBeNull();
    });

    describe('a new selection turned away while parked ends the parking (no ghost dot)', () => {
      const parkedDot = async (t: ReturnType<typeof setup>, p: Text) => {
        await dot(t, snapshotOf(p, 8, 11));
        at(-60);
        await scroll(t);
        expect(t.host()).toBeNull();
      };
      const comesBack = async (t: ReturnType<typeof setup>) => {
        at(150);
        await scroll(t);
        return t.host() !== null;
      };

      it('too short', async () => {
        const { p } = page();
        const t = setup();
        await parkedDot(t, p);
        t.card.showDot(snapshotOf(p, 0, 1));
        await t.advance(0);
        expect(await comesBack(t)).toBe(false);
      });

      it('too long', async () => {
        document.body.innerHTML = `<p id="p">${SENTENCE}</p><p id="long">${'word '.repeat(500)}</p>`;
        const p = (document.getElementById('p') as HTMLElement).firstChild as Text;
        const t = setup();
        await parkedDot(t, p);
        t.card.showDot(snapshotOf(document.getElementById('long') as HTMLElement));
        await t.advance(0);
        expect(await comesBack(t)).toBe(false);
      });

      it('closed before (dismissed)', async () => {
        const { p, q } = page();
        const t = setup();
        await dot(t, snapshotOf(q, 0, 8));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await t.advance(200);
        t.run();
        expect(t.host()).toBeNull();
        await parkedDot(t, p);
        t.card.showDot(snapshotOf(q, 0, 8));
        await t.advance(0);
        expect(await comesBack(t)).toBe(false);
      });

      it('already in the target language', async () => {
        document.body.innerHTML = `<p id="p">${SENTENCE}</p><p id="zh">这是一段已经是简体中文的文字。</p>`;
        const p = (document.getElementById('p') as HTMLElement).firstChild as Text;
        const t = setup();
        await parkedDot(t, p);
        t.deps.detectLanguage.mockResolvedValueOnce({
          isReliable: true,
          languages: [{ language: 'zh-CN', percentage: 99 }],
        });
        t.card.showDot(snapshotOf(document.getElementById('zh') as HTMLElement));
        await t.advance(0);
        expect(await comesBack(t)).toBe(false);
      });

      it('control: with nothing turned away, the parked dot does come back', async () => {
        const { p } = page();
        const t = setup();
        await parkedDot(t, p);
        expect(await comesBack(t)).toBe(true);
      });
    });

    it('the selection gone, or the runtime disposed, ends the parking', async () => {
      const { p } = page();
      const t = setup();
      const listening = vi.spyOn(window, 'removeEventListener');
      await dot(t, snapshotOf(p, 8, 11));
      at(-60);
      await scroll(t);
      t.card.hideDot();
      at(150);
      await scroll(t);
      expect(t.host()).toBeNull();

      await dot(t, snapshotOf(p, 8, 11));
      // Parking adds its own scroll and resize listeners (unmounting removes others).
      const adding = vi.spyOn(window, 'addEventListener');
      at(-60);
      await scroll(t);
      const parkedOn = (type: string) =>
        adding.mock.calls.filter(([name]) => name === type).map(([, listener]) => listener);
      const parked = { scroll: parkedOn('scroll'), resize: parkedOn('resize') };
      adding.mockRestore();
      expect(parked.scroll).toHaveLength(1);
      expect(parked.resize).toHaveLength(1);
      listening.mockClear();
      t.card.dispose();
      expect(listening).toHaveBeenCalledWith('scroll', parked.scroll[0], true);
      expect(listening).toHaveBeenCalledWith('resize', parked.resize[0]);
      at(150);
      await scroll(t);
      expect(t.host()).toBeNull();
      listening.mockRestore();
    });
  });

  it('grows from the dot’s corner and keeps clear of the page isle', async () => {
    const { p } = page();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const snapshot = { ...snapshotOf(p, 8, 11), anchor: { x: width - 40, y: RECT.bottom } };
    const shape = (t: ReturnType<typeof setup>) => {
      const match = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t.$('.cw')?.style.transform ?? '');
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    };
    const t = setup();
    t.card.open({ source: 'map', selection: snapshot });
    t.run();
    // Right half: the card's top right corner on the dot (center = anchor + (7, 0)).
    expect(shape(t).x + 360).toBe(width - 40 + 7);
    expect(shape(t).y).toBe(RECT.bottom);
    t.card.dispose();

    const isle = document.createElement('et-isle');
    isle.setAttribute('data-et-rect', `${width - 56},300,40,186`);
    document.documentElement.append(isle);
    const u = setup();
    u.card.open({ source: 'map', selection: snapshot });
    u.run();
    expect(shape(u).x + 360).toBe(width - 56 - 8);
    isle.remove();
  });

  it('opened from the menu: a top corner of the card on the end of the selection', () => {
    const { p } = page();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const shape = (t: ReturnType<typeof setup>) => {
      const match = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t.$('.cw')?.style.transform ?? '');
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    };
    // Right half: the top right corner, on the spot the dot would take.
    const right = { x: width - 200, y: RECT.bottom };
    const t = setup();
    t.card.open({ source: 'map', selection: { ...snapshotOf(p, 8, 11), anchor: right } });
    t.run();
    expect(Math.abs(shape(t).x + 360 - (right.x + 7))).toBeLessThanOrEqual(1);
    expect(Math.abs(shape(t).y - right.y)).toBeLessThanOrEqual(1);
    t.card.dispose();
    // Left half: the top left corner.
    const left = { x: 150, y: RECT.bottom };
    const u = setup();
    u.card.open({ source: 'map', selection: { ...snapshotOf(p, 8, 11), anchor: left } });
    u.run();
    expect(Math.abs(shape(u).x - (left.x + 7))).toBeLessThanOrEqual(1);
    expect(Math.abs(shape(u).y - left.y)).toBeLessThanOrEqual(1);
  });

  it('grows out of the dot: mid-animation its top corner is still on the dot', async () => {
    const { p } = page();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const anchor = { x: width - 200, y: RECT.bottom };
    const t = setup();
    await dot(t, { ...snapshotOf(p, 8, 11), anchor });
    t.click('.zn');
    t.run(4);
    const layer = t.$('.sh') as HTMLElement;
    const box = {
      left: Number.parseFloat(layer.style.left),
      top: Number.parseFloat(layer.style.top),
      width: Number.parseFloat(layer.style.width),
    };
    // Still growing, its top right corner within the dot's 5px radius of the dot's center.
    expect(box.width).toBeGreaterThan(20);
    expect(box.width).toBeLessThan(340);
    expect(Math.abs(box.left + box.width - (anchor.x + 7))).toBeLessThanOrEqual(5);
    expect(Math.abs(box.top - anchor.y)).toBeLessThanOrEqual(5);
  });

  describe('the page isle moving while the card is open', () => {
    const shape = (t: ReturnType<typeof setup>) => {
      const match = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t.$('.cw')?.style.transform ?? '');
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    };
    const width = () => document.documentElement.clientWidth || window.innerWidth;
    const isleAt = (rect: string) => {
      const isle = document.createElement('et-isle');
      isle.setAttribute('data-et-rect', rect);
      document.documentElement.append(isle);
      cleanups.push(() => isle.remove());
      return isle;
    };
    const openRight = async (t: ReturnType<typeof setup>) => {
      const { p } = page();
      t.card.open({
        source: 'map',
        selection: { ...snapshotOf(p, 8, 11), anchor: { x: width() - 40, y: RECT.bottom } },
      });
      t.run();
    };

    it('re-places the card when data-et-rect changes, once per frame', async () => {
      // Docked right but below the card's reach ([224, 604]): nothing to avoid yet.
      expect(window.innerHeight).toBeGreaterThanOrEqual(768);
      const isle = isleAt(`${width() - 56},640,40,100`);
      const t = setup();
      await openRight(t);
      const free = shape(t).x;
      expect(free + 360).toBe(width() - 40 + 7);
      const replace = vi.spyOn(Element.prototype, 'getAttribute');
      isle.setAttribute('data-et-rect', `${width() - 56},250,40,186`);
      isle.setAttribute('data-et-rect', `${width() - 56},300,40,186`);
      await t.advance(0);
      // Not read in the observer callback: only in the next frame.
      expect(replace.mock.calls.filter(([name]) => name === 'data-et-rect')).toHaveLength(0);
      t.run();
      expect(replace.mock.calls.filter(([name]) => name === 'data-et-rect')).toHaveLength(1);
      replace.mockRestore();
      expect(shape(t).x + 360).toBe(width() - 56 - 8);
    });

    it('stops watching once the card closes, and on dispose', async () => {
      const isle = isleAt(`${width() - 56},640,40,100`);
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      const t = setup();
      await openRight(t);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(disconnect).toHaveBeenCalled();
      await t.advance(200);
      t.run();
      expect(t.host()).toBeNull();
      // Changes after closing schedule nothing.
      isle.setAttribute('data-et-rect', `${width() - 56},300,40,186`);
      await t.advance(0);
      t.run();
      disconnect.mockClear();
      const u = setup();
      await openRight(u);
      u.card.dispose();
      expect(disconnect).toHaveBeenCalled();
      disconnect.mockRestore();
    });

    it('only the isle under <html> counts, not one a page put in its body', async () => {
      const { p } = page();
      const fake = document.createElement('et-isle');
      fake.setAttribute('data-et-rect', `${width() - 56},300,40,186`);
      document.body.append(fake);
      const t = setup();
      t.card.open({
        source: 'map',
        selection: { ...snapshotOf(p, 8, 11), anchor: { x: width() - 40, y: RECT.bottom } },
      });
      t.run();
      expect(shape(t).x + 360).toBe(width() - 40 + 7);
    });
  });

  it('pinned: stays put on scroll and drags by its header', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.run();
    t.click('[data-act="pin"]');
    t.run();
    const proto = Range.prototype as unknown as Record<string, unknown>;
    proto.getClientRects = () => [
      { left: 100, top: -60, right: 300, bottom: -36, width: 200, height: 24 },
    ];
    window.dispatchEvent(new Event('scroll'));
    t.run();
    expect(t.view()).toBe('card');
    const at = t.$('.cw')?.style.transform;
    const header = t.$('.hd') as HTMLElement;
    header.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 0,
        clientX: 200,
        clientY: 240,
        pointerId: 1,
        cancelable: true,
      }),
    );
    expect(t.$('.r')?.hasAttribute('data-drag')).toBe(true);
    header.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 260, clientY: 300, pointerId: 1 }),
    );
    t.run();
    header.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(t.$('.r')?.hasAttribute('data-drag')).toBe(false);
    expect(t.$('.cw')?.style.transform).not.toBe(at);
    // Unpinned: back to following the selection (which is now out of view: it stays).
    t.click('[data-act="pin"]');
    expect(t.$('[data-act="pin"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(t.view()).toBe('card');
  });

  it('announces "正在翻译" and "已翻译" once per request', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    t.run(1);
    expect(t.$('.sr[role="status"]')?.textContent).toBe('正在翻译');
    t.sent[0]?.chunk({ id: 's', delta: '纸' });
    t.sent[0]?.chunk({ id: 's', reset: true });
    t.run(1);
    expect(t.$('.sr[role="status"]')?.textContent).toBe('正在翻译');
    t.sent[0]?.chunk(final('纸质地图'));
    t.run(1);
    expect(t.$('.sr[role="status"]')?.textContent).toBe('已翻译');
  });

  it('copies the translation; the fallback restores the selection and focus and is quiet', async () => {
    const { p, q } = page();
    const t = setup({ writeClipboard: vi.fn(async () => Promise.reject(new Error('denied'))) });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const snapshot = snapshotOf(p, 8, 11);
    t.card.open({ source: 'map', selection: snapshot });
    t.sent[0]?.chunk(final('地图'));
    t.click('[data-act="copy"]');
    await t.advance(0);
    expect(exec).toHaveBeenCalledWith('copy');
    const range = document.getSelection()?.getRangeAt(0);
    expect(range?.startOffset).toBe(8);
    expect(range?.endOffset).toBe(11);
    expect(document.activeElement).toBe(input);
    expect(t.$('[data-act="copy"]')?.getAttribute('aria-label')).toBe('已复制');
    // Selection changes caused by the copy are not new selections.
    t.card.hideDot();
    t.card.showDot(snapshotOf(q, 0, 8));
    await t.advance(0);
    t.run();
    expect(t.view()).toBe('card');
    expect(t.sent).toHaveLength(1);
    expect(t.$('.st')?.textContent).toBe('map');
    await t.advance(1600);
    expect(t.$('[data-act="copy"]')?.getAttribute('aria-label')).toBe('复制译文');
  });

  it('reads a source in another language in its own language', async () => {
    const { p } = page();
    const t = setup({
      detection: { isReliable: true, languages: [{ language: 'fr', percentage: 97 }] },
    });
    t.card.open({ source: 'Bonjour tout le monde', selection: snapshotOf(p) });
    await t.advance(0);
    t.click('[data-act="speak"]');
    expect(t.synth.speak.mock.calls[0]?.[0]).toMatchObject({ lang: 'fr' });
    t.card.dispose();
  });

  it('reads the source aloud and stops on close; greys out without voices', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    t.click('[data-act="speak"]');
    expect(t.synth.speak).toHaveBeenCalledOnce();
    const utterance = t.synth.speak.mock.calls[0]?.[0] as unknown as { text: string; lang: string };
    // English reads in an American voice by default.
    expect(utterance).toMatchObject({ text: SENTENCE, lang: 'en-US' });
    expect(t.$('[data-act="speak"]')?.getAttribute('aria-label')).toBe('停止朗读');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(t.synth.cancel).toHaveBeenCalledOnce();
    t.card.dispose();

    const mute = setup({ voices: [] });
    mute.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await mute.advance(1100);
    const speak = mute.$('[data-act="speak"]');
    expect(speak?.getAttribute('aria-disabled')).toBe('true');
    expect(speak?.getAttribute('aria-label')).toBe('这台设备没有可用的朗读语音');
    mute.click('[data-act="speak"]');
    expect(mute.synth.speak).not.toHaveBeenCalled();
  });

  it('dispose removes everything, stops speech and closes the port', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    t.click('[data-act="speak"]');
    t.card.dispose();
    expect(t.host()).toBeNull();
    expect(t.synth.cancel).toHaveBeenCalled();
    expect(t.port.dispose).toHaveBeenCalled();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    expect(t.host()).toBeNull();
  });

  it('a card with no selection (iframe text) still translates exactly that text', () => {
    const t = setup();
    t.card.open({ source: 'Text from a frame' });
    expect(t.sent[0]?.payload.items[0]?.text).toBe('Text from a frame');
    expect(t.$('.st')?.textContent).toBe('Text from a frame');
  });

  it('the menu or shortcut on text inside the card itself does nothing', () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.sent[0]?.chunk(final('地图'));
    const range = document.createRange();
    range.selectNode(t.host() as HTMLElement);
    t.card.open({
      source: '地图',
      selection: { source: '地图', rect: RECT, anchor: { x: 0, y: 0 }, range },
    });
    expect(t.sent).toHaveLength(1);
    expect(t.$('.st')?.textContent).toBe('map');
    expect(t.$('.tw')?.textContent).toBe('地图');
  });

  it('ignores a selection inside the card itself', async () => {
    const { p } = page();
    const t = setup();
    t.card.open({ source: 'map', selection: snapshotOf(p, 8, 11) });
    t.click('[data-act="pin"]');
    const host = t.host() as HTMLElement;
    const range = document.createRange();
    range.selectNode(host);
    t.card.showDot({ source: '地图', rect: RECT, anchor: { x: 0, y: 0 }, range });
    await t.advance(0);
    expect(t.sent).toHaveLength(1);
  });
});

describe('phonetic', () => {
  /** Opens the card for "map" through the dot, so the config and the detection are known. */
  async function openWord(t: ReturnType<typeof setup>, start = 8, end = 11) {
    const { p } = page();
    await dot(t, snapshotOf(p, start, end));
    t.click('.zn');
  }
  const shown = (t: ReturnType<typeof setup>) => t.$('.ph')?.textContent;

  afterEach(() => {
    document.documentElement.removeAttribute('lang');
  });

  /** The phonetic buttons' accessible names. */
  const labels = (t: ReturnType<typeof setup>) =>
    [...(t.$('.ph')?.querySelectorAll('.pb') ?? [])].map((b) => b.getAttribute('aria-label'));

  it('asks for it for a single English word, and shows both accents after the word', async () => {
    const t = setup();
    await openWord(t);
    expect(t.sent[0]?.payload.phonetic).toBe(true);
    expect(shown(t)).toBe('');
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp', us: 'mæp' } });
    expect(shown(t)).toBe('UK/mæp/US/mæp/');
    expect(labels(t)).toEqual(['英式发音 /mæp/，点击朗读', '美式发音 /mæp/，点击朗读']);
    // English phonetics, whatever the UI language the card host carries.
    expect(t.$('.ph')?.getAttribute('lang')).toBe('en');
    expect(t.$('.st')?.textContent).toBe('map');
    // The word and the phonetic share one wrapping box; the word is still the expand button.
    expect(t.$('.sw')?.firstElementChild).toBe(t.$('.st'));
    expect(t.$('.st')?.getAttribute('aria-expanded')).toBe('false');
    t.sent[0]?.chunk(final('地图'));
    expect(shown(t)).toBe('UK/mæp/US/mæp/');
    expect(t.$('.tx')?.textContent).toBe('地图');
  });

  it('shows only the accent it has', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { us: 'mæp' } });
    expect(shown(t)).toBe('US/mæp/');
    expect(labels(t)).toEqual(['美式发音 /mæp/，点击朗读']);
  });

  it('shows one that arrives after the translation, with its headword', async () => {
    document.body.innerHTML = '<p id="p">Two maps.</p>';
    const t = setup();
    const text = (document.getElementById('p') as HTMLElement).firstChild as Text;
    await dot(t, snapshotOf(text, 4, 8));
    t.click('.zn');
    expect(t.sent[0]?.payload).toMatchObject({ items: [{ text: 'maps' }], phonetic: true });
    t.sent[0]?.chunk(final('地图'));
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp', us: 'mæp' }, lemma: 'map' });
    expect(shown(t)).toBe('mapUK/mæp/US/mæp/');
    expect(t.$('.lm')?.textContent).toBe('map');
    expect(t.$('.tx')?.textContent).toBe('地图');
  });

  it('reads the word in a British or an American voice, stopping the last one first', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp', us: 'mæp' } });
    t.click('.pb[data-l="uk"]');
    expect(t.synth.speak).toHaveBeenCalledTimes(1);
    expect(t.synth.speak.mock.calls[0]?.[0]).toMatchObject({ text: 'map', lang: 'en-GB' });
    t.click('.pb[data-l="us"]');
    expect(t.synth.cancel).toHaveBeenCalledTimes(1);
    // Chrome stalls on a voice spoken right after cancel: it waits a moment.
    expect(t.synth.speak).toHaveBeenCalledTimes(1);
    await t.advance(SETTLE_MS);
    expect(t.synth.speak.mock.calls[1]?.[0]).toMatchObject({ text: 'map', lang: 'en-US' });
    // The footer's button still reads the source, and shows the word being read.
    expect(t.$('[data-act="speak"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a reading no voice answers says so on the button pressed, for three seconds', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp', us: 'mæp' } });
    // The voice never starts (Chrome's stall, or an online voice with no answer).
    t.synth.speak.mockImplementation(() => {});
    const tip = () => t.$('.tp') as HTMLElement;
    for (const selector of ['.pb[data-l="us"]', '[data-act="speak"]']) {
      t.click(selector);
      expect(t.$('[data-act="speak"]')?.getAttribute('aria-pressed')).toBe('true');
      await t.advance(START_TIMEOUT_MS);
      expect(t.$('[data-act="speak"]')?.getAttribute('aria-pressed')).toBe('false');
      expect(tip().textContent).toBe('朗读没有响应，请稍后再试');
      expect(tip().style.opacity).toBe('1');
      t.run();
      expect(t.$('[role="status"]')?.textContent).toBe('朗读没有响应，请稍后再试');
      await t.advance(2900);
      expect(tip().style.opacity).toBe('1');
      await t.advance(100);
      expect(tip().style.opacity).toBe('0');
      await t.advance(SETTLE_MS);
    }
    // The footer's tip is its own label again.
    t.$('[data-act="speak"]')?.dispatchEvent(new PointerEvent('pointerenter'));
    await t.advance(1000);
    expect(tip().textContent).toBe('朗读原文');
  });

  it('a reading that ends normally shows no tip', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp' } });
    t.click('.pb[data-l="uk"]');
    const utterance = t.synth.speak.mock.calls[0]?.[0];
    utterance?.onend?.({} as SpeechSynthesisEvent);
    expect(t.$('[data-act="speak"]')?.getAttribute('aria-pressed')).toBe('false');
    await t.advance(START_TIMEOUT_MS * 2);
    expect((t.$('.tp') as HTMLElement).textContent).toBe('');
    expect(t.synth.cancel).not.toHaveBeenCalled();
  });

  it('reads the headword when its readings are the ones shown', async () => {
    document.body.innerHTML = '<p id="p">Two maps.</p>';
    const t = setup();
    const text = (document.getElementById('p') as HTMLElement).firstChild as Text;
    await dot(t, snapshotOf(text, 4, 8));
    t.click('.zn');
    t.sent[0]?.chunk({ id: 's', phonetic: { us: 'mæp' }, lemma: 'map' });
    t.click('.pb[data-l="us"]');
    expect(t.synth.speak.mock.calls[0]?.[0]).toMatchObject({ text: 'map', lang: 'en-US' });
  });

  it('keeps the phonetic buttons out of the tab order like every card button (plan 4.3)', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp' } });
    const say = t.$('.pb') as HTMLButtonElement;
    expect(say.tagName).toBe('BUTTON');
    expect(say.getAttribute('tabindex')).toBe('-1');
    expect(say.getAttribute('aria-label')).toBe('英式发音 /mæp/，点击朗读');
  });

  it('clears it on a retranslation, and asks again', async () => {
    const t = setup();
    await openWord(t);
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp' } });
    t.sent[0]?.chunk(final('地图'));
    t.click('[data-act="engine"]');
    await t.advance(0);
    t.click('[data-id="google"]');
    expect(shown(t)).toBe('');
    expect(t.sent[1]?.payload).toMatchObject({ engine: 'google', phonetic: true });
    // The old request's late phonetic is not shown on the new one.
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'old' } });
    expect(shown(t)).toBe('');
  });

  it('clears it for a new selection on a pinned card', async () => {
    const { p, q } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    t.click('.zn');
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp' } });
    t.click('[data-act="pin"]');
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    t.card.showDot(snapshotOf(q, 0, 8));
    await t.advance(0);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.payload.phonetic).toBeUndefined();
    expect(shown(t)).toBe('');
  });

  it('does not ask for a sentence, an English target or a word detected as another language', async () => {
    const sentence = setup();
    const { p } = page();
    await dot(sentence, snapshotOf(p));
    sentence.click('.zn');
    expect(sentence.sent[0]?.payload.phonetic).toBeUndefined();
    sentence.card.dispose();

    // Opened from the menu once the config is read: only the target says no.
    document.documentElement.lang = 'en';
    const english = setup({
      config: (config) => {
        config.language.target = 'en';
      },
    });
    await english.advance(0);
    english.card.open({ source: 'map', selection: snapshotOf(page().p, 8, 11) });
    expect(english.sent[0]?.payload.phonetic).toBeUndefined();
    english.card.dispose();
    const chinese = setup();
    await chinese.advance(0);
    chinese.card.open({ source: 'map', selection: snapshotOf(page().p, 8, 11) });
    expect(chinese.sent[0]?.payload.phonetic).toBe(true);
    chinese.card.dispose();

    const french = setup({
      detection: { isReliable: true, languages: [{ language: 'fr', percentage: 99 }] },
    });
    await openWord(french);
    expect(french.sent[0]?.payload.phonetic).toBeUndefined();
  });

  it('falls back to the page language when the detection is not reliable', async () => {
    // A Chinese page (Google results with a Chinese interface): the word is English.
    document.documentElement.lang = 'zh-CN';
    const chinese = setup({ detection: { isReliable: false, languages: [] } });
    await openWord(chinese);
    expect(chinese.sent[0]?.payload.phonetic).toBe(true);
    chinese.card.dispose();

    // A French page: the word may be French.
    document.documentElement.lang = 'fr';
    const french = setup({ detection: { isReliable: false, languages: [] } });
    await openWord(french);
    expect(french.sent[0]?.payload.phonetic).toBeUndefined();
    french.card.dispose();
    document.documentElement.lang = '';
  });
});

/** Switches the getMessage stub to the en copy (vitest.setup puts zh_CN back each test). */
async function switchToEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

describe('English copy and lang', () => {
  it('says the 2000-character limit in both languages, written as 2000', async () => {
    const long = 'word '.repeat(450).trim();
    const zh = setup();
    zh.card.open({ source: long });
    expect(zh.$('.nc')?.textContent).toContain('2000');
    zh.card.dispose();
    await switchToEnglish();
    const t = setup();
    t.card.open({ source: long });
    expect(t.$('.nc')?.textContent).toBe(
      'The selected text is too long (over 2000 characters). Select less, or translate the whole page.',
    );
  });

  it('labels the phonetic buttons and the engine button in English', async () => {
    await switchToEnglish();
    const { p } = page();
    const t = setup();
    await dot(t, snapshotOf(p, 8, 11));
    t.click('.zn');
    t.sent[0]?.chunk({ id: 's', phonetic: { uk: 'mæp', us: 'mæp' } });
    const labels = [...(t.$('.ph')?.querySelectorAll('.pb') ?? [])].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'British pronunciation /mæp/, click to play',
      'American pronunciation /mæp/, click to play',
    ]);
    expect(t.$('[data-act="engine"]')?.getAttribute('aria-label')).toContain('click to switch');
  });

  it('keeps the host in the interface language, the translation in the target and the source in its own', async () => {
    document.documentElement.setAttribute('lang', 'fr');
    try {
      await switchToEnglish();
      const { p } = page();
      const t = setup();
      t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
      await t.advance(0);
      t.sent[0]?.chunk({ id: 's', delta: '纸质地图' });
      expect(t.host()?.getAttribute('lang')).toBe('en');
      expect(t.$('.tw')?.getAttribute('lang')).toBe('zh-CN');
      expect(t.$('.st')?.getAttribute('lang')).toBe('en');
    } finally {
      document.documentElement.removeAttribute('lang');
    }
  });

  it('leaves the source lang empty when the detection is unsure', async () => {
    const { p } = page();
    const t = setup({ detection: { isReliable: false, languages: [] } });
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    await t.advance(0);
    t.sent[0]?.chunk({ id: 's', delta: '纸质地图' });
    expect(t.host()?.getAttribute('lang')).toBe('zh-CN');
    expect(t.$('.st')?.getAttribute('lang')).toBe('');
  });

  it('words the error actions in English, naming Google by its English name', async () => {
    await switchToEnglish();
    const { p } = page();
    const t = setup();
    t.card.open({ source: SENTENCE, selection: snapshotOf(p) });
    t.sent[0]?.chunk({
      id: 's',
      error: withUserMessage(appError('provider', 'provider/server-error', 'x')),
    });
    expect(t.$('[data-act="retry"]')?.textContent).toBe('Retry');
    expect(t.$('[data-act="google"]')?.textContent).toBe('Use Google Translate this time');
  });
});
