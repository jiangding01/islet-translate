import { describe, expect, it } from 'vitest';
import { appError } from '@/lib/errors';
import {
  chunkByLimits,
  cleanTextOutput,
  createBatchScanner,
  createThinkFilter,
  decodeLlmOutput,
  encodeBatch,
  finishBatch,
  renderUserMessage,
  settleWithSplit,
  splitInHalf,
  USER_INPUT_TOKEN,
  weightedLength,
} from './codec';
import type { ProviderEvent } from './types';

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

// ------------------------------------------------------------ incremental batch scanner

const item = (index: number, text: string) => ({ index, text });

function scan(sources: readonly string[], chunks: readonly string[]) {
  const scanner = createBatchScanner(sources);
  const items = chunks.flatMap((chunk) => scanner.push(chunk));
  return { scanner, items };
}

/** Scans `raw` in one go, then split at every position and one code unit at a time. */
function scanEverySplit(sources: readonly string[], raw: string) {
  const whole = scan(sources, [raw]);
  const same = (other: ReturnType<typeof scan>) => {
    expect(other.items).toEqual(whole.items);
    expect(other.scanner.state).toBe(whole.scanner.state);
    expect(other.scanner.array).toBe(whole.scanner.array);
    expect(other.scanner.committed).toEqual(whole.scanner.committed);
    expect(other.scanner.draft).toBe(whole.scanner.draft);
  };
  for (let at = 0; at <= raw.length; at += 1)
    same(scan(sources, [raw.slice(0, at), raw.slice(at)]));
  same(scan(sources, raw.split('')));
  return whole;
}

describe('createBatchScanner: split points', () => {
  const SOURCES = ['Hello', 'Say "hi" [x] {y}', 'Line\nbreak 😀', 'd'];
  const ANSWER = [
    { i: 0, t: '你好' },
    { i: 1, t: '说 "嗨" [x] {y} \\ }] {' },
    { i: 2, t: '换\n行 😀' },
    { i: 3, t: '丁' },
  ];
  const json = JSON.stringify(ANSWER);

  it.each([
    ['plain', json],
    ['indented, with whitespace around', `  \n${JSON.stringify(ANSWER, null, 2)}\n`],
    ['a think block first', `<think>Input is [{"i":0}] … "quoted" }</think>\n\n${json}`],
    ['a json fence', `\`\`\`json\n${json}\n\`\`\``],
    ['a think block and a bare fence', `<think>plan</think>\n\`\`\`\n${json}\n\`\`\`\n`],
  ])('gives the same items at every split point (%s)', (_name, raw) => {
    const { scanner, items } = scanEverySplit(SOURCES, raw);
    expect(items).toEqual(ANSWER.map(({ i, t }) => item(i, t)));
    expect(scanner.state).toBe('closed');
    expect(scanner.array).toBe('closed');
  });

  it.each([
    ['whitespace', '\n  '],
    ['a closed think block', '<think>Keep [i] as is.</think>\n'],
    ['a json fence', '```json\n'],
    ['a think block and a bare fence', '<THINK>x</THINK>```\n'],
  ])('commits the first item before the array ends, after %s', (_name, lead) => {
    const scanner = createBatchScanner(['Hello', 'World']);
    expect(scanner.push(`${lead}[{"i":0,"t":"你好"}`)).toEqual([item(0, '你好')]);
    expect(scanner.state).toBe('open');
    expect(scanner.array).toBe('open');
    expect(scanner.push(',{"i":1,"t":"世界"}]')).toEqual([item(1, '世界')]);
    expect(scanner.committed).toEqual(['你好', '世界']);
  });

  it.each([
    ['an uppercase JSON fence', '```JSON\n', true],
    ['whitespace before the think block', ' \n<think>x</think>', true],
    ['a fence with the array on the same line', '```json', true],
    ['a byte order mark', '\uFEFF', true],
    ['an ideographic space', '\u3000', true],
    ['a <thinking> block (only <think> is skipped)', '<thinking>x</thinking>\n', false],
    ['a partial json tag', '```js\n', false],
  ])('reads a lead-in of %s', (_name, lead, starts) => {
    const scanner = createBatchScanner(['Hello', 'World']);
    expect(scanner.push(`${lead}[{"i":0,"t":"你好"}`)).toEqual(starts ? [item(0, '你好')] : []);
    expect(scanner.array).toBe(starts ? 'open' : 'none');
  });

  it('reads brackets in strings and nested values as content', () => {
    const raw = '[{"i":0,"t":"a ] b","x":[1,{"y":"]"}]},{"i":1,"t":"乙"}]';
    expect(scanEverySplit(['a', 'b'], raw).items).toEqual([item(0, 'a ] b'), item(1, '乙')]);
  });
});

describe('createBatchScanner: what it never commits', () => {
  it.each([
    ['prose', 'Sure! Here it is: [{"i":0,"t":"你好"},{"i":1,"t":"世界"}]'],
    [
      'reasoning without its opening tag',
      '推理 [{"i":0,"t":"Hello"}]</think>[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]',
    ],
    ['an unclosed think block', '<think>[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]'],
    ['a second think block', '<think>a</think><think>b</think>[{"i":0,"t":"你好"}]'],
    ['a fence of another language', '```js\n[{"i":0,"t":"你好"}]'],
  ])('commits nothing when the output starts with %s', (_name, raw) => {
    const { scanner, items } = scanEverySplit(['Hello', 'World'], raw);
    expect(items).toEqual([]);
    expect(scanner.array).toBe('none');
    expect(scanner.state).not.toBe('tainted');
  });

  it.each([
    ['strings', '["你好","世界"]'],
    ['objects without i', '[{"t":"你好"},{"t":"世界"}]'],
    ['a string i', '[{"i":"0","t":"你好"},{"i":1,"t":"世界"}]'],
  ])('commits nothing when the items are %s', (_name, raw) => {
    expect(scanEverySplit(['Hello', 'World'], raw).items).toEqual([]);
  });

  it.each([
    [
      'ids out of order',
      4,
      '[{"i":0,"t":"甲"},{"i":2,"t":"丙"},{"i":1,"t":"乙"},{"i":3,"t":"丁"}]',
      1,
    ],
    ['a first id past 0', 2, '[{"i":1,"t":"乙"},{"i":0,"t":"甲"}]', 0],
    ['a skipped id', 4, '[{"i":0,"t":"甲"},{"i":1,"t":"乙"},{"i":3,"t":"丁"},{"i":2,"t":"丙"}]', 2],
    ['an id out of range', 1, '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]', 1],
    [
      'a duplicate id',
      3,
      '[{"i":0,"t":"甲"},{"i":0,"t":"甲"},{"i":1,"t":"乙"},{"i":2,"t":"丙"}]',
      1,
    ],
    [
      'a fractional id',
      3,
      '[{"i":0,"t":"甲"},{"i":1.5,"t":"x"},{"i":1,"t":"乙"},{"i":2,"t":"丙"}]',
      1,
    ],
    ['an empty translation', 3, '[{"i":0,"t":"甲"},{"i":1,"t":" \\n"},{"i":2,"t":"丙"}]', 1],
    ['a non-string translation', 3, '[{"i":0,"t":"甲"},{"i":1,"t":2},{"i":2,"t":"丙"}]', 1],
    ['malformed JSON', 3, '[{"i":0,"t":"甲"},{"i":1,t:"乙"},{"i":2,"t":"丙"}]', 1],
    ['a bare value', 3, '[{"i":0,"t":"甲"},"乙",{"i":1,"t":"乙"},{"i":2,"t":"丙"}]', 1],
  ])('stops committing at %s', (_name, count, raw, committed) => {
    const sources = Array.from({ length: count }, (_, index) => `s${index}`);
    const { scanner, items } = scanEverySplit(sources, raw);
    expect(items).toHaveLength(committed);
    expect(items.map((entry) => entry.index)).toEqual([...Array(committed).keys()]);
    expect(scanner.state).toBe('closed');
  });

  it('holds back echoed items until an item that differs from its source', () => {
    const scanner = createBatchScanner(['GitHub', '  Hello   World ', 'Bye', 'x']);
    expect(scanner.push('[{"i":0,"t":"github"},')).toEqual([]);
    expect(scanner.push('{"i":1,"t":"hello world"},')).toEqual([]);
    expect(scanner.push('{"i":2,"t":"再见"}')).toEqual([
      item(0, 'github'),
      item(1, 'hello world'),
      item(2, '再见'),
    ]);
    // A trailing echo stays held: the end of the batch decides it.
    expect(scanner.push(',{"i":3,"t":"X"}]')).toEqual([]);
    expect(scanner.committed).toEqual(['github', 'hello world', '再见']);
  });

  it('commits nothing when every item echoes its source', () => {
    const raw = '[{"i":0,"t":"Hello"},{"i":1,"t":"World"}]';
    expect(scanEverySplit(['Hello', 'World'], raw).items).toEqual([]);
  });

  it('drops held echoes on a deviation', () => {
    const raw = '[{"i":0,"t":"Hello"},{"i":2,"t":"丙"},{"i":1,"t":"世界"}]';
    expect(scanEverySplit(['Hello', 'World', 'c'], raw).items).toEqual([]);
  });

  it.each([
    ['a second array', '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]\n[{"i":2,"t":"丙"},{"i":3,"t":"丁"}]'],
    ['bare objects', '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}],{"i":2,"t":"丙"},{"i":3,"t":"丁"}'],
  ])('stops at the end of the top-level array, even when ids go on in %s', (_name, raw) => {
    const { scanner, items } = scanEverySplit(['a', 'b', 'c', 'd'], raw);
    expect(items).toEqual([item(0, '甲'), item(1, '乙')]);
    expect(scanner.array).toBe('closed');
  });
});

describe('createBatchScanner: tainted output', () => {
  it.each([
    [
      'a closing think tag after the array',
      '[{"i":0,"t":"草稿"}]</think>[{"i":0,"t":"终稿"}]',
      true,
    ],
    ['a closing think tag inside the array', '[{"i":0,"t":"草稿"}</THINK>', true],
    ['prose after the array', '[{"i":0,"t":"甲"}]\nHope this helps.', false],
    ['a second array', '[{"i":0,"t":"甲"}] [{"i":0,"t":"乙"}]', true],
    ['an object after the array', '[{"i":0,"t":"甲"}]\nAlso {"i":0}', true],
    ['an uppercase closing tag after prose', '[{"i":0,"t":"甲"}]\nOK </THINK>', true],
    ['prose after the closing fence', '```json\n[{"i":0,"t":"甲"}]\n```\nDone.', false],
    ['an array after the closing fence', '```json\n[{"i":0,"t":"甲"}]\n```\nFixed: [', true],
    ['a closing fence that was never opened', '[{"i":0,"t":"甲"}]\n```', false],
    ['a fourth backtick', '```json\n[{"i":0,"t":"甲"}]\n````', false],
    [
      'a bracketed note after the fence',
      '```json\n[{"i":0,"t":"甲"}]\n```\nNote: item [1] stays.',
      false,
    ],
    [
      'a Markdown link after the fence',
      '```json\n[{"i":0,"t":"甲"}]\n```\nSee [docs](https://x.test).',
      false,
    ],
    ['a placeholder named in a note', '[{"i":0,"t":"甲"}]\nI kept {name} as is.', false],
    ['a second array with spaces inside', '[{"i":0,"t":"甲"}]\nFixed: [ \n {"i":0', true],
    ['an object with spaces inside', '[{"i":0,"t":"甲"}]\nAlso { "i":0}', true],
    ['a second array of loose objects', '[{"i":0,"t":"甲"}]\nFixed: [{\'i\':0}]', true],
    ['an object left open at the end', '[{"i":0,"t":"甲"}]\nAlso {', true],
    ['text after the closing fence on its line', '```\n[{"i":0,"t":"甲"}]\n``` x', false],
  ])('marks %s as tainted', (_name, raw, draft) => {
    const { scanner } = scanEverySplit(['a'], raw);
    expect(scanner.state).toBe('tainted');
    expect(scanner.draft).toBe(draft);
  });

  it.each([
    ['trailing whitespace', '[{"i":0,"t":"甲"}]\n\n'],
    ['a closing fence', '```json\n[{"i":0,"t":"甲"}]\n```\n'],
    ['a closing fence right after the array', '```[{"i":0,"t":"甲"}]```'],
    ['a closing think tag inside a string', '[{"i":0,"t":"用 </think> 结束"}]'],
    ['a closing think tag before the array starts', 'Plan.</think>[{"i":0,"t":"甲"}]'],
  ])('does not taint %s', (_name, raw) => {
    const { scanner } = scanEverySplit(['a'], raw);
    expect(scanner.state).toBe('closed');
    expect(scanner.draft).toBe(false);
  });

  // 131072 characters each way: well under a second when linear, seconds when rescanned.
  const LONG = 131_072;

  it('reads long whitespace before and after the array in linear time', () => {
    for (const fence of ['', '```json\n']) {
      const scanner = createBatchScanner(['a']);
      const started = performance.now();
      for (let k = 0; k < LONG; k += 1) scanner.push(' ');
      expect(scanner.push(`${fence}[{"i":0,"t":"甲"}]`)).toEqual([item(0, '甲')]);
      for (let k = 0; k < LONG; k += 1) scanner.push(' ');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(scanner.state).toBe('closed');
    }
  });

  // Guards against a future rescan of the block: the think filter used before was
  // already linear here, so this case does not tell the two apart.
  it('stays linear over a long think block', () => {
    const scanner = createBatchScanner(['a']);
    const started = performance.now();
    scanner.push('<think>');
    for (let k = 0; k < LONG; k += 1) scanner.push('x');
    expect(scanner.push('</think>\n[{"i":0,"t":"甲"}')).toEqual([item(0, '甲')]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('finishBatch', () => {
  function finish(sources: string[], raw: string) {
    const scanner = createBatchScanner(sources);
    const early = scanner.push(raw);
    const late: ProviderEvent[] = [];
    let error: unknown;
    try {
      for (const event of finishBatch(scanner, raw, sources.length)) late.push(event);
    } catch (caught) {
      error = caught;
    }
    return { early, late, error };
  }
  const late = (index: number, text: string): ProviderEvent => ({ type: 'item', index, text });
  const code = (value: string) => expect.objectContaining({ code: value });

  it('yields the items not committed yet when the whole output agrees', () => {
    const result = finish(['Hello', 'x'], '[{"i":0,"t":"你好"},{"i":1,"t":"X"}]');
    expect(result).toEqual({ early: [item(0, '你好')], late: [late(1, 'X')], error: undefined });
  });

  it('fails with bad-response, yielding nothing more, when the whole output disagrees', () => {
    const raw =
      '[{"i":0,"t":"草稿"},{"i":1,"t":"World"}]</think>[{"i":0,"t":"终稿"},{"i":1,"t":"世界"}]';
    const result = finish(['a', 'World'], raw);
    expect(result.early).toEqual([item(0, '草稿')]);
    // The rest is halved and sent again: what was committed is revoked (scheduler).
    expect(result.late).toEqual([]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  it('keeps a tainted output that still parses and agrees (a note after the array)', () => {
    const result = finish(['a', 'b'], '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]\nHope this helps.');
    expect(result).toEqual({
      early: [item(0, '甲'), item(1, '乙')],
      late: [],
      error: undefined,
    });
  });

  it.each([
    [
      'a fenced draft, then a corrected array',
      '```json\n[{"i":0,"t":"草稿0"},{"i":1,"t":"草稿1"}]\n```\nActually corrected:\n[{"i":0,"t":"终稿0"},{"i":1,"t":"终稿1"}]',
      2,
    ],
    [
      'the same array again after a closing think tag',
      '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]</think>[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]',
      2,
    ],
    [
      'a draft followed by prose that opens an array without closing it',
      '[{"i":0,"t":"草稿0"},{"i":1,"t":"草稿1"}]\nBetter: [{"i":0,"t":"终稿0"',
      2,
    ],
    [
      'a closing think tag inside the array, then the answer',
      '[{"i":0,"t":"甲"}</think>[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]',
      1,
    ],
  ])(
    'fails with bad-response, yielding nothing more, after %s even when it agrees',
    (_name, raw, committed) => {
      const result = finish(['a', 'b'], raw);
      expect(result.early).toHaveLength(committed);
      expect(result.late).toEqual([]);
      expect(result.error).toEqual(code('validation/bad-response'));
    },
  );

  it.each([
    ['a bracketed note after the fence', '```json\n{A}\n```\nNote: item [1] stays short.'],
    ['a Markdown link after the fence', '```json\n{A}\n```\nSee [the docs](https://x.test).'],
    ['a placeholder named in a note', '{A}\nI kept {name} as is.'],
  ])('ends normally with %s', (_name, template) => {
    const raw = template.replace('{A}', '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]');
    expect(finish(['a', 'b'], raw)).toEqual({
      early: [item(0, '甲'), item(1, '乙')],
      late: [],
      error: undefined,
    });
  });

  it('tells a draft apart from a mismatch in the error message', () => {
    const draft = finish(['a', 'b'], '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]\n[{"i":0,"t":"甲"}');
    expect(draft.error).toEqual(expect.objectContaining({ message: 'Draft output' }));
    const differ = finish(
      ['a', 'b'],
      '[{"i":0,"t":"草稿"},{"i":1,"t":"b"}]</think>[{"i":0,"t":"终稿"},{"i":1,"t":"乙"}]',
    );
    expect(differ.error).toEqual(
      expect.objectContaining({ message: 'Streamed items differ from the output' }),
    );
  });

  it('keeps a draft followed only by prose, even if the prose says it is a draft', () => {
    const raw =
      '[{"i":0,"t":"草稿0"},{"i":1,"t":"草稿1"}]\nActually the second line reads better shorter.';
    expect(finish(['a', 'b'], raw)).toEqual({
      early: [item(0, '草稿0'), item(1, '草稿1')],
      late: [],
      error: undefined,
    });
  });

  it('fails a tainted output that does not parse with bad-response, never as truncated', () => {
    const result = finish(['a', 'b'], '[{"i":0,"t":"草稿"}</think>');
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  it('reports an array cut short as output-truncated', () => {
    const result = finish(['a', 'b'], '[{"i":0,"t":"甲"},{"i":1,"t":"乙');
    expect(result.early).toEqual([item(0, '甲')]);
    expect(result.error).toEqual(code('provider/output-truncated'));
  });

  it('reports a closed array with missing items as bad-response', () => {
    const result = finish(['a', 'b'], '[{"i":0,"t":"甲"}]');
    expect(result.early).toEqual([item(0, '甲')]);
    expect(result.error).toEqual(code('validation/bad-response'));
  });

  it('decodes an output the scanner never started on as before', () => {
    expect(finish(['a', 'b'], 'Sure: [{"i":0,"t":"甲"},{"i":1,"t":"乙"}] done')).toEqual({
      early: [],
      late: [late(0, '甲'), late(1, '乙')],
      error: undefined,
    });
    expect(finish(['a', 'b'], 'Sure: [{"i":0,"t":"甲"}').error).toEqual(
      code('validation/bad-response'),
    );
  });
});

// ------------------------------------------------------------ length check

describe('weightedLength', () => {
  it.each([
    ['Latin letters', 'Hello', 5],
    ['digits', '2026', 4],
    ['Han characters', '你好', 6],
    ['kana', 'こんにちは', 7.5],
    ['katakana', 'カタカナ', 6],
    ['Hangul', '안녕하세요', 10],
    ['mixed scripts', 'Hi 你好', 8],
    ['Japanese with kanji', '日本語です', 12],
    ['inline tags', '<t0>Hi</t0> <t1/>x <ab12>y</ab12>', 4],
    ['zero-width characters', 'a​b‌‍⁠﻿c', 3],
    ['whitespace', ' a  b \n\tc ', 3],
    ['Cyrillic', 'Привет', 6],
    ['punctuation and symbols', '!?。—€', 5],
    ['nothing left', ' <t0></t0> ', 0],
  ])('counts %s', (_name, text, weight) => {
    expect(weightedLength(text)).toBe(weight);
  });

  it.each([
    ['English and Chinese', 'Hello world, how are you today?', '你好世界，你今天怎么样？'],
    ['English and Japanese', 'Thank you very much', 'どうもありがとうございます'],
    ['English and Korean', 'Thank you very much', '정말 감사합니다'],
    ['Chinese and Japanese', '今天天气很好', '今日はいい天気です'],
  ])('keeps common language pairs near 1 (%s)', (_name, a, b) => {
    const ratio = weightedLength(b) / weightedLength(a);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});

describe('createBatchScanner: length check', () => {
  const one = (source: string, translation: string) =>
    scanEverySplit([source, 'next'], `[${JSON.stringify({ i: 0, t: translation })}`);
  /** 36 when weighted. */
  const LONG = 'This sentence is long enough to count here.';

  it.each([
    ['a translation under a third of a long source', LONG, '短句'],
    ['a translation over three times the source, both long', 'Hello world again', '甲'.repeat(20)],
    [
      'a short title merged into the next paragraph',
      'Intro',
      '你好，这是一个被模型并进来的很长的下一段',
    ],
  ])('closes on %s and marks the scanner suspect', (_name, source, translation) => {
    const { scanner, items } = one(source, translation);
    expect(items).toEqual([]);
    expect(scanner.state).toBe('suspect');
    expect(scanner.committed).toEqual([]);
  });

  it.each([
    ['both sides short, whatever the ratio', 'Hi', '你好你好'],
    ['a ratio of exactly 3', 'abcdefghij', '甲'.repeat(10)],
    ['a ratio of exactly 1/3', 'abcdefghijabcdefghijabcdefghijabc', 'abcdefghijk'],
    ['a long pair near 1', LONG, '这个句子足够长，可以算在这里。'],
  ])('commits %s', (_name, source, translation) => {
    const { scanner, items } = one(source, translation);
    expect(items).toEqual([item(0, translation)]);
    expect(scanner.state).toBe('open');
  });

  /** A paragraph-sized source (20 when weighted) and translations of any weight. */
  const PARAGRAPH = 'abcdefghij'.repeat(2);
  const SOURCES = Array.from({ length: 6 }, () => PARAGRAPH);
  const t = (weight: number) => 'x'.repeat(weight);
  const run = (...translations: string[]) =>
    scanEverySplit(
      SOURCES,
      `[${translations.map((text, i) => JSON.stringify({ i, t: text })).join(',')}`,
    );

  it.each([
    ['more than twice', t(50)],
    ['under half', t(8)],
  ])('closes on a long item %s the median ratio of the long items before it', (_name, odd) => {
    const { scanner, items } = run(t(20), t(20), t(20), odd, t(20));
    expect(items.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(scanner.state).toBe('suspect');
  });

  it('takes the median, not the mean or the last ratio', () => {
    // Ratios 1, 1.2, 2: median 1.2, so 2.6 is past twice it (the mean, 1.4, would allow it).
    const { scanner, items } = run(t(20), t(24), t(40), t(52));
    expect(items).toHaveLength(3);
    expect(scanner.state).toBe('suspect');
  });

  it('keeps items within twice the median, and applies the rule only from the fourth long item', () => {
    expect(run(t(20), t(20), t(20), t(38)).items).toHaveLength(4);
    // Third item: only two ratios before it, so the relative rule does not apply yet.
    const early = run(t(20), t(20), t(50));
    expect(early.items).toHaveLength(3);
    expect(early.scanner.state).toBe('open');
  });

  it('leaves short items (both sides under 15) out of the median and the check', () => {
    const sources = [PARAGRAPH, PARAGRAPH, PARAGRAPH, 'OK', 'FAQ', 'Home', PARAGRAPH, 'See also'];
    const answer = [t(20), t(20), t(20), '确定', '常见问题', '首页', t(22), '另请参阅'];
    const raw = `[${answer.map((text, i) => JSON.stringify({ i, t: text })).join(',')}]`;
    const { scanner, items } = scanEverySplit(sources, raw);
    expect(items).toHaveLength(8);
    expect(scanner.state).toBe('closed');
    // Short ones before do not count: the third long item is still only the third.
    const shortFirst = scanEverySplit(
      ['OK', 'FAQ', 'Home', PARAGRAPH, PARAGRAPH, PARAGRAPH],
      `[${['确定', '常见问题', '首页', t(20), t(20), t(50)].map((text, i) => JSON.stringify({ i, t: text })).join(',')}`,
    );
    expect(shortFirst.items).toHaveLength(6);
  });

  it('counts held echoes among the long items before', () => {
    const scanner = createBatchScanner([
      'GitHub Enterprise Server',
      'Visual Studio Code Insiders',
      'Kubernetes Dashboard Pro',
      PARAGRAPH,
    ]);
    const raw =
      '[{"i":0,"t":"GitHub Enterprise Server"},{"i":1,"t":"Visual Studio Code Insiders"},' +
      '{"i":2,"t":"Kubernetes Dashboard Pro"},';
    expect(scanner.push(raw)).toEqual([]);
    expect(scanner.push(`{"i":3,"t":"${t(50)}"}`)).toEqual([]);
    expect(scanner.state).toBe('suspect');
  });

  it('still catches a merge in a batch of real paragraphs', () => {
    const sources = [
      'Install the package with npm and import it in your project.',
      'The configuration file lives at the root of the repository and is read once at startup.',
      'Call the function with your options object to get a client back.',
      'Every request the client makes is retried once on a network error.',
      'Errors carry a code and a message you can show to the user.',
    ];
    const answer = [
      '使用 npm 安装该软件包，并在项目中导入它。',
      '配置文件位于仓库根目录，启动时读取一次。',
      '使用选项对象调用该函数，得到一个客户端。',
      // Items 3 and 4 merged: the text of two paragraphs under one id.
      '客户端发出的每个请求在网络出错时都会重试一次。错误带有代码和一条可以展示给用户的消息。',
      '错误带有代码和一条可以展示给用户的消息。',
    ];
    const raw = `[${answer.map((text, i) => JSON.stringify({ i, t: text })).join(',')}]`;
    const { scanner, items } = scanEverySplit(sources, raw);
    expect(items).toHaveLength(3);
    expect(scanner.state).toBe('suspect');
  });

  it.each<[string, [string, string][]]>([
    [
      'a navigation bar, English to Chinese',
      [
        ['Home', '首页'],
        ['Products', '产品'],
        ['Pricing', '价格'],
        ['Docs', '文档'],
        ['Blog', '博客'],
        ['FAQ', '常见问题'],
        ['Contact us', '联系我们'],
        ['Log in', '登录'],
        ['Sign up', '注册'],
      ],
    ],
    [
      'another navigation bar',
      [
        ['Home', '首页'],
        ['About', '关于'],
        ['Settings', '设置'],
        ['Introduction', '简介'],
        ['Next', '下一页'],
      ],
    ],
    [
      'an article with headings',
      [
        ['Getting started', '入门'],
        [
          'Install the package with npm and import it in your project.',
          '使用 npm 安装该软件包，并在项目中导入它。',
        ],
        ['Configuration', '配置'],
        [
          'The configuration file lives at the root of the repository and is read once at startup.',
          '配置文件位于仓库根目录，启动时读取一次。',
        ],
        ['Usage', '用法'],
        ['Call the function with your options object.', '使用选项对象调用该函数。'],
        ['See also', '另请参阅'],
        ['API reference', 'API 参考'],
      ],
    ],
    [
      'a navigation bar, Chinese to English',
      [
        ['首页', 'Home'],
        ['产品', 'Products'],
        ['文档', 'Docs'],
        ['博客', 'Blog'],
        ['常见问题', 'FAQ'],
        ['联系我们', 'Contact us'],
      ],
    ],
    [
      'a menu, English to Korean',
      [
        ['Home', '홈'],
        ['Search', '검색'],
        ['Settings', '설정'],
        ['Profile', '프로필'],
        ['Notifications', '알림'],
        ['Help', '도움말'],
      ],
    ],
    [
      'a menu, English to Japanese',
      [
        ['Home', 'ホーム'],
        ['Search', '検索'],
        ['Settings', '設定'],
        ['Profile', 'プロフィール'],
        ['Notifications', '通知'],
        ['Help', 'ヘルプ'],
      ],
    ],
    [
      'a link row like Hacker News',
      [
        ['new', '最新'],
        ['past', '往期'],
        ['comments', '评论'],
        ['ask', '提问'],
        ['show', '展示'],
        ['jobs', '招聘'],
        ['submit', '提交'],
      ],
    ],
    [
      'comment actions like Reddit',
      [
        ['Share', '分享'],
        ['Reply', '回复'],
        ['Award', '奖励'],
        ['Report', '举报'],
        ['Save', '保存'],
        ['Follow', '关注'],
        ['OK', '确定'],
      ],
    ],
  ])('commits every item of %s (right translations, short ones of any ratio)', (_name, pairs) => {
    const raw = `[${pairs.map(([, text], i) => JSON.stringify({ i, t: text })).join(',')}]`;
    const { scanner, items } = scanEverySplit(
      pairs.map(([source]) => source),
      raw,
    );
    expect(items).toHaveLength(pairs.length);
    expect(scanner.state).toBe('closed');
  });

  it('commits nothing more after it, and a draft still taints it', () => {
    const scanner = createBatchScanner([LONG, 'b', 'c']);
    expect(scanner.push('[{"i":0,"t":"短"},{"i":1,"t":"乙"}')).toEqual([]);
    expect(scanner.state).toBe('suspect');
    scanner.push(',{"i":2,"t":"丙"}]</think>');
    expect(scanner.state).toBe('tainted');
  });

  it('is not suspect when it closed for another reason first', () => {
    const { scanner } = scanEverySplit([LONG, 'b'], '[{"i":1,"t":"乙"},{"i":0,"t":"短"}]');
    expect(scanner.state).toBe('closed');
  });
});

describe('finishBatch: after the length check', () => {
  it('checks a suspect output that ends normally as a whole, as before', () => {
    const sources = Array.from({ length: 4 }, () => 'abcdefghij'.repeat(2));
    const answer = ['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(20), 'x'.repeat(50)];
    const raw = JSON.stringify(answer.map((t, i) => ({ i, t })));
    const scanner = createBatchScanner(sources);
    expect(scanner.push(raw)).toHaveLength(3);
    expect(scanner.state).toBe('suspect');
    expect([...finishBatch(scanner, raw, 4)]).toEqual([
      { type: 'item', index: 3, text: 'x'.repeat(50) },
    ]);
  });
});

describe('finishBatch: a suspect output cut short', () => {
  it('fails with bad-response, never as truncated, so what was committed is revoked', () => {
    const scanner = createBatchScanner(['a', 'b', 'c']);
    const raw = `[{"i":0,"t":"甲"},{"i":1,"t":"${'乙'.repeat(11)}"},{"i":2,"t":"丙`;
    expect(scanner.push(raw)).toEqual([item(0, '甲')]);
    expect(scanner.state).toBe('suspect');
    expect(() => [...finishBatch(scanner, raw, 3)]).toThrow(
      expect.objectContaining({ code: 'validation/bad-response' }),
    );
  });
});
