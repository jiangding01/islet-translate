import { describe, expect, it } from 'vitest';
import { appError } from '@/lib/errors';
import {
  chunkByLimits,
  cleanTextOutput,
  createThinkFilter,
  decodeLlmOutput,
  encodeBatch,
  renderUserMessage,
  settleWithSplit,
  splitInHalf,
  USER_INPUT_TOKEN,
} from './codec';

describe('chunkByLimits', () => {
  it('splits by item count', () => {
    expect(chunkByLimits(['a', 'b', 'c', 'd', 'e'], { maxItems: 2, maxChars: 100 })).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  it('splits by character count', () => {
    expect(chunkByLimits(['aaa', 'bbb', 'cc'], { maxItems: 10, maxChars: 6 })).toEqual([
      [0, 1],
      [2],
    ]);
  });

  it('puts an oversized item alone without splitting it', () => {
    const groups = chunkByLimits(['a', 'x'.repeat(50), 'b'], { maxItems: 10, maxChars: 10 });
    expect(groups).toEqual([[0], [1], [2]]);
  });
});

describe('encode / decode', () => {
  it('encodes items with positional ids', () => {
    expect(JSON.parse(encodeBatch(['x', 'y']))).toEqual([
      { i: 0, t: 'x' },
      { i: 1, t: 'y' },
    ]);
  });

  it('renders the template without interpreting $ patterns', () => {
    const out = renderUserMessage(`A ${USER_INPUT_TOKEN} B`, ['$&']);
    expect(out).toBe(`A ${encodeBatch(['$&'])} B`);
  });

  it('decodes plain, fenced and noisy outputs', () => {
    const json = '[{"i":0,"t":"一"},{"i":1,"t":"二"}]';
    expect(decodeLlmOutput(json, 2)).toEqual(['一', '二']);
    expect(decodeLlmOutput(`\`\`\`json\n${json}\n\`\`\``, 2)).toEqual(['一', '二']);
    expect(decodeLlmOutput(`Sure! Here you go:\n${json}\nHope it helps.`, 2)).toEqual(['一', '二']);
  });

  it('reorders out-of-order output by i', () => {
    expect(decodeLlmOutput('[{"i":1,"t":"二"},{"i":0,"t":"一"}]', 2)).toEqual(['一', '二']);
  });

  it.each([
    ['not json', 'no array here', 1],
    ['missing id', '[{"i":0,"t":"a"}]', 2],
    ['duplicate id', '[{"i":0,"t":"a"},{"i":0,"t":"b"}]', 2],
    ['out of range', '[{"i":0,"t":"a"},{"i":5,"t":"b"}]', 2],
    ['negative id', '[{"i":-1,"t":"a"}]', 1],
    ['fractional id', '[{"i":0.5,"t":"a"}]', 1],
    ['empty translation', '[{"i":0,"t":"  "}]', 1],
    ['non-string text', '[{"i":0,"t":1}]', 1],
    ['non-object item', '["a"]', 1],
    ['extra item', '[{"i":0,"t":"a"},{"i":1,"t":"b"}]', 1],
  ])('rejects %s', (_name, raw, count) => {
    expect(() => decodeLlmOutput(raw, count)).toThrow(
      expect.objectContaining({ code: 'validation/bad-response' }),
    );
  });
});

describe('splitInHalf / settleWithSplit', () => {
  it('splits down to single items and refuses to split further', () => {
    expect(splitInHalf([1, 2, 3])).toEqual([[1, 2], [3]]);
    expect(splitInHalf([1])).toBeUndefined();
  });

  it('halves a malformed batch until only the bad item fails', async () => {
    const calls: number[][] = [];
    const outcomes = await settleWithSplit([1, 2, 3, 4], async (items) => {
      calls.push([...items]);
      if (items.includes(3)) throw appError('validation', 'validation/bad-response', 'bad');
      return items.map((n) => `t${n}`);
    });
    expect(outcomes.map((o) => (o.ok ? o.text : o.error.code))).toEqual([
      't1',
      't2',
      'validation/bad-response',
      't4',
    ]);
    expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [3, 4], [3], [4]]);
  });

  it('treats a wrong result length as malformed', async () => {
    const outcomes = await settleWithSplit(['a', 'b'], async (items) =>
      items.length === 2 ? ['only one'] : items.map((s) => s.toUpperCase()),
    );
    expect(outcomes).toEqual([
      { ok: true, text: 'A' },
      { ok: true, text: 'B' },
    ]);
  });

  it('does not split on other errors', async () => {
    let calls = 0;
    const outcomes = await settleWithSplit([1, 2], async () => {
      calls += 1;
      throw appError('provider', 'provider/unauthorized', 'no');
    });
    expect(calls).toBe(1);
    expect(outcomes.every((o) => !o.ok && o.error.code === 'provider/unauthorized')).toBe(true);
  });
});

describe('decodeLlmOutput: raw JSON first', () => {
  it('parses a valid array whose translation contains a code fence', () => {
    const raw = JSON.stringify([{ i: 0, t: 'Use ```[1, 2]``` here' }]);
    expect(decodeLlmOutput(raw, 1)).toEqual(['Use ```[1, 2]``` here']);
  });

  it('still reads fenced and noisy outputs', () => {
    expect(decodeLlmOutput('```json\n[{"i":0,"t":"a"}]\n```', 1)).toEqual(['a']);
    expect(decodeLlmOutput('Sure: [{"i":0,"t":"a"}] done', 1)).toEqual(['a']);
  });
});

describe('settleWithSplit: truncated and blocked batches', () => {
  it.each(['provider/output-truncated', 'provider/content-blocked'] as const)(
    'halves on %s and ends single items with the real code',
    async (code) => {
      const calls: number[][] = [];
      const outcomes = await settleWithSplit([1, 2, 3, 4], async (items) => {
        calls.push([...items]);
        if (items.includes(3)) throw appError('provider', code, 'x');
        return items.map(String);
      });
      expect(outcomes).toEqual([
        { ok: true, text: '1' },
        { ok: true, text: '2' },
        { ok: false, error: expect.objectContaining({ code }) },
        { ok: true, text: '4' },
      ]);
      expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [3, 4], [3], [4]]);
    },
  );
});

describe('createThinkFilter', () => {
  const run = (chunks: string[]) => {
    const filter = createThinkFilter();
    return chunks.map(filter);
  };

  it('passes plain text through, including a leading "<" that is not a think tag', () => {
    expect(run(['你', '好'])).toEqual(['你', '好']);
    expect(run(['<', 'b>粗体'])).toEqual(['', '<b>粗体']);
  });

  it('holds back a leading think block split across chunks', () => {
    expect(run(['  <thi', 'nk>let me', ' think</th', 'ink>\n\n', '你好', '，世界'])).toEqual([
      '',
      '',
      '',
      '',
      '你好',
      '，世界',
    ]);
  });

  it('keeps a think tag that appears after the translation started', () => {
    expect(run(['A ', '<think>x</think>'])).toEqual(['A ', '<think>x</think>']);
  });
});

describe('cleanTextOutput: labels and quotes the source already has', () => {
  it('strips a stray label or quotes the model added', () => {
    expect(cleanTextOutput('Translation: Hallo', 'Hello')).toBe('Hallo');
    expect(cleanTextOutput('"Hallo"', 'Hello')).toBe('Hallo');
  });

  it.each([
    ['Translation: Haus', 'Übersetzung: House', 'Translation: Haus'],
    ['译文：房子', 'Traduction : maison', '译文：房子'],
    ['Translation: 房子', 'Название: дом', 'Translation: 房子'],
    ['翻译：你好', 'Translation: hello', '翻译：你好'],
    ['Translation: 你好', 'Translation: hello', 'Translation: 你好'],
  ])('keeps the label when the source starts with one (%s)', (output, source, expected) => {
    expect(cleanTextOutput(output, source)).toBe(expected);
  });

  it.each([
    ['《你好》', '《Hello》'],
    ['「你好」', '「Hello」'],
    ['『你好』', '『Hello』'],
    ['“你好”', '“Hello”'],
    ['‘你好’', '‘Hello’'],
    ['"你好"', '"Hello"'],
    ["'你好'", "'Hello'"],
    ['(你好)', '(Hello)'],
    ['"你好"', '《Hello》'],
    ['“你好”', '（Hello）'],
    ['「你好」', '【Hello】'],
    ['"你好"', '(Hello)'],
    ['（你好）', '（Hello）'],
    ['【你好】', '【Hello】'],
  ])('keeps the quotes when the source is wrapped too (%s)', (output, source) => {
    expect(cleanTextOutput(output, source)).toBe(output);
  });
});

describe('decodeLlmOutput: reasoning inlined before the array', () => {
  it('parses an output without reasoning, and reasoning without brackets', () => {
    expect(decodeLlmOutput('[{"i":0,"t":"你好"}]', 1)).toEqual(['你好']);
    const raw = '<think>Translate it plainly.</think>\n[{"i":0,"t":"你好"}]';
    expect(decodeLlmOutput(raw, 1)).toEqual(['你好']);
  });

  it('ignores an array quoted in the reasoning', () => {
    const raw = '<think>The input is [{"i":0,"t":"Hello"}], keep i.</think>\n[{"i":0,"t":"你好"}]';
    expect(decodeLlmOutput(raw, 1)).toEqual(['你好']);
  });

  it('ignores a fenced source array in the reasoning instead of returning the source', () => {
    const raw =
      '<think>Input:\n```json\n[{"i":0,"t":"Hello world"}]\n```\nNow translate.</think>\n[{"i":0,"t":"你好世界"}]';
    expect(decodeLlmOutput(raw, 1)).toEqual(['你好世界']);
  });

  it('cuts at the right place when lowercasing would change the length (İ)', () => {
    const raw = 'İstanbul is [x].</think>[{"i":0,"t":"你好"}]';
    expect(decodeLlmOutput(raw, 1)).toEqual(['你好']);
  });

  it('handles reasoning whose opening tag is missing', () => {
    const quoted = 'The input is [{"i":0,"t":"Hello"}], keep i.</think>\n[{"i":0,"t":"你好"}]';
    expect(decodeLlmOutput(quoted, 1)).toEqual(['你好']);
    const fenced =
      'Input:\n```json\n[{"i":0,"t":"Hello"}]\n```\n</think>\n\n```json\n[{"i":0,"t":"你好"}]\n```';
    expect(decodeLlmOutput(fenced, 1)).toEqual(['你好']);
  });

  it('keeps think tags that are part of a translation', () => {
    expect(decodeLlmOutput('[{"i":0,"t":"用 <think> 包住推理"}]', 1)).toEqual([
      '用 <think> 包住推理',
    ]);
    // Cut at the first closing tag, so the one inside the translation stays.
    const afterReasoning = '<think>Keep [tags].</think>[{"i":0,"t":"用 </think> 结束"}]';
    expect(decodeLlmOutput(afterReasoning, 1)).toEqual(['用 </think> 结束']);
    // Nothing usable after the tag: the whole output is read as before.
    const fencedOnly = '```json\n[{"i":0,"t":"用 </think> 结束"}]\n```';
    expect(decodeLlmOutput(fencedOnly, 1)).toEqual(['用 </think> 结束']);
  });
});

describe('cleanTextOutput: reasoning before the translation', () => {
  it('drops a think block (control)', () => {
    expect(cleanTextOutput('<think>hmm</think>\n你好', 'Hello')).toBe('你好');
  });

  it('drops reasoning whose opening tag is missing', () => {
    expect(cleanTextOutput('Hello means 你好.</think>\n\n你好', 'Hello')).toBe('你好');
  });

  it('cuts at the right place when lowercasing would change the length (İ)', () => {
    expect(cleanTextOutput('İ means I.</think>Merhaba', 'Hello')).toBe('Merhaba');
  });

  it('drops reasoning that mentions a closing tag itself', () => {
    const output = '<think>End with </think> here? No.</think>\n你好';
    expect(cleanTextOutput(output, 'Hello')).toBe('你好');
  });

  it('drops reasoning before a translation that keeps the source think tag', () => {
    const output = '<think>Keep the tag.</think>\n用 <think> 开始';
    expect(cleanTextOutput(output, 'Start with <think>')).toBe('用 <think> 开始');
  });

  it('keeps a closing tag the source has', () => {
    expect(cleanTextOutput('用 </think> 结束推理', 'Close with </think>')).toBe(
      '用 </think> 结束推理',
    );
  });
});
