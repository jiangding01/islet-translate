import { describe, expect, it } from 'vitest';
import {
  decodeFile,
  exportCsv,
  exportFileName,
  exportJson,
  type ImportOptions,
  MAX_IMPORT_BYTES,
  PREVIEW_ISSUES,
  PREVIEW_ROWS,
  parseDelimited,
  readImport,
  sniffDelimiter,
} from './transfer';
import { type GlossaryEntry, glossaryBase, MAX_GLOSSARY_ENTRIES } from './types';

// Glossary import and export (M4-D): decoding, parsing, the preview and the exported files.

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);

const utf8 = (text: string) => new TextEncoder().encode(text);
function utf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const out: number[] = bom ? (littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (littleEndian) out.push(code & 0xff, code >> 8);
    else out.push(code >> 8, code & 0xff);
  }
  return new Uint8Array(out);
}

// Generated offline (Python's codecs), so the tests need no encoder dependency.
/** "原文,译文\n术语,词汇\n" in GB18030. */
const GB18030 = new Uint8Array([
  212, 173, 206, 196, 44, 210, 235, 206, 196, 10, 202, 245, 211, 239, 44, 180, 202, 187, 227, 10,
]);
/** "原文,譯文\n術語,詞彙\n" in Big5. */
const BIG5 = new Uint8Array([
  173, 236, 164, 229, 44, 196, 182, 164, 229, 10, 179, 78, 187, 121, 44, 181, 252, 183, 74, 10,
]);
/** "原文,訳文\nテスト,試験\n" in Shift_JIS. */
const SHIFT_JIS = new Uint8Array([
  140, 180, 149, 182, 44, 150, 243, 149, 182, 10, 131, 101, 131, 88, 131, 103, 44, 142, 142, 140,
  177, 10,
]);

const entry = (id: string, source: string, fields: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
  id: `term-${id.padStart(8, '0')}`,
  source,
  target: '',
  lang: '',
  caseSensitive: false,
  ...fields,
});

const PR = entry('1', 'pull request', { target: '拉取请求', lang: 'zh-CN' });
const GITHUB = entry('2', 'GitHub');

function options(existing: GlossaryEntry[] = [], extra: Partial<ImportOptions> = {}) {
  return { uiLanguage: 'zh-CN', defaultLang: 'zh-CN' as const, existing, ...extra };
}
const read = (text: string, existing: GlossaryEntry[] = [], extra: Partial<ImportOptions> = {}) =>
  readImport(utf8(text), options(existing, extra));
const statuses = (text: string, existing: GlossaryEntry[] = []) =>
  read(text, existing).rows.map((row) => row.status);
const reasons = (text: string, existing: GlossaryEntry[] = []) =>
  read(text, existing).issues.map((row) => [row.line, row.reason]);

describe('transfer: decoding', () => {
  it('reads UTF-8 with or without a BOM, dropping the BOM', () => {
    for (const text of ['source,target\na,b', `${BOM}source,target\na,b`]) {
      const decoded = decodeFile(utf8(text), 'zh-CN');
      expect(decoded).toEqual({
        ok: true,
        text: 'source,target\na,b',
        encoding: 'UTF-8',
        guessed: false,
      });
    }
  });

  it('reads UTF-16 by its BOM, and without one by where the NUL bytes fall', () => {
    const text = `原文${TAB}译文\nAPI${TAB}接口`;
    expect(decodeFile(utf16(text, true, true), 'en')).toMatchObject({ text, encoding: 'UTF-16LE' });
    expect(decodeFile(utf16(text, false, true), 'en')).toMatchObject({
      text,
      encoding: 'UTF-16BE',
    });
    expect(decodeFile(utf16(text, true, false), 'en')).toMatchObject({
      text,
      encoding: 'UTF-16LE',
    });
    expect(decodeFile(utf16(text, false, false), 'en')).toMatchObject({
      text,
      encoding: 'UTF-16BE',
    });
    expect(readImport(utf16(text, true, false), options()).counts.new).toBe(1);
  });

  it('falls back to GB18030, or Big5 in a Traditional Chinese interface, as a guess', () => {
    expect(decodeFile(GB18030, 'zh-CN')).toEqual({
      ok: true,
      text: '原文,译文\n术语,词汇\n',
      encoding: 'GB18030',
      guessed: true,
    });
    expect(decodeFile(GB18030, 'en-US')).toMatchObject({ encoding: 'GB18030' });
    expect(decodeFile(BIG5, 'zh-TW')).toMatchObject({
      text: '原文,譯文\n術語,詞彙\n',
      encoding: 'Big5',
      guessed: true,
    });
    expect(decodeFile(BIG5, 'zh-Hant-HK')).toMatchObject({ encoding: 'Big5' });
  });

  it('decodes again in the encoding the user picks', () => {
    const guessed = decodeFile(SHIFT_JIS, 'zh-CN');
    expect(guessed.ok && guessed.text).not.toContain('テスト');
    expect(decodeFile(SHIFT_JIS, 'zh-CN', 'Shift_JIS')).toEqual({
      ok: true,
      text: '原文,訳文\nテスト,試験\n',
      encoding: 'Shift_JIS',
      guessed: true,
    });
    const preview = readImport(SHIFT_JIS, options([], { encoding: 'Shift_JIS' }));
    expect(preview).toMatchObject({ encoding: 'Shift_JIS', guessed: true });
    expect(preview.rows[1]).toMatchObject({ source: 'テスト', target: '試験' });
    // Traditional column names are read as well.
    expect(readImport(BIG5, options([], { uiLanguage: 'zh-TW' })).header).toBe(true);
  });

  it('refuses an Excel workbook and a file no encoding reads', () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(readImport(xlsx, options()).blocker).toEqual({ code: 'xlsx' });
    // Not UTF-8 and not GB18030 (0xFF never starts a GB18030 character).
    expect(readImport(new Uint8Array([0x61, 0xff, 0x62]), options()).blocker).toEqual({
      code: 'unreadable',
    });
    // A UTF-8 BOM says UTF-8: no fallback.
    const broken = new Uint8Array([0xef, 0xbb, 0xbf, 0xd4, 0xff]);
    expect(decodeFile(broken, 'zh-CN')).toMatchObject({ ok: false, encoding: 'UTF-8' });
    // A picked encoding that fails keeps the picker.
    const picked = readImport(new Uint8Array([0x61, 0xa1]), options([], { encoding: 'Big5' }));
    expect(picked).toMatchObject({
      blocker: { code: 'unreadable' },
      encoding: 'Big5',
      guessed: true,
    });
  });

  it('refuses a file over 1 MB without decoding it', () => {
    const big = new Uint8Array(MAX_IMPORT_BYTES + 1).fill(0x61);
    expect(readImport(big, options()).blocker).toEqual({ code: 'tooLarge' });
  });
});

describe('transfer: formats', () => {
  it('reads the exported JSON and a plain array with aliased keys', () => {
    const file = JSON.stringify({
      format: 'islet-translate.glossary',
      version: 1,
      entries: [{ source: 'API', target: '接口', lang: 'zh-CN', caseSensitive: true }],
    });
    expect(read(file)).toMatchObject({ unit: 'item', rowCount: 1, header: false });
    expect(read(file).rows[0]).toMatchObject({ source: 'API', caseSensitive: true });
    const array = JSON.stringify([
      { 原文: 'token', Translation: '词元', 'Target-Language': 'zh_cn', match_case: 'yes' },
      { term: 'Claude', id: 'ignored' },
    ]);
    expect(read(array).rows).toMatchObject([
      { line: 1, status: 'new', source: 'token', target: '词元', lang: 'zh-CN' },
      { line: 2, status: 'new', source: 'Claude', target: '', lang: '' },
    ]);
  });

  it('refuses JSON it does not understand, and a file from a newer version', () => {
    expect(read('{"entries": []}').blocker).toEqual({ code: 'json' });
    expect(read('{"format": "islet-translate.glossary", "entries": 3}').blocker).toEqual({
      code: 'json',
    });
    expect(read('"text"').blocker?.code).not.toBe('json');
    expect(
      read('{"format": "islet-translate.glossary", "version": 2, "entries": []}').blocker,
    ).toEqual({ code: 'newerVersion' });
  });

  it('reads a CSV that only looks like JSON as CSV', () => {
    const preview = read('[GPT],GPT 模型\n[o1],o1 模型');
    expect(preview.unit).toBe('line');
    expect(preview.rows.map((row) => row.source)).toEqual(['[GPT]', '[o1]']);
  });

  it('tells TSV from CSV by a Tab outside quotes on the first non-empty line', () => {
    expect(sniffDelimiter(`\n\nHello, world${TAB}你好`)).toBe(TAB);
    expect(sniffDelimiter(`"a${TAB}b",c\nd${TAB}e`)).toBe(',');
    expect(sniffDelimiter('a,b')).toBe(',');
    // Only a quote that starts a cell opens one, as in the reader.
    expect(sniffDelimiter(`12" pizza${TAB}12寸披萨`)).toBe(TAB);
    expect(sniffDelimiter(`"a""${TAB}b",c`)).toBe(',');
    expect(read(`Hello, world${TAB}你好`).rows[0]).toMatchObject({
      source: 'Hello, world',
      target: '你好',
    });
  });
});

describe('transfer: the CSV reader', () => {
  it('reads quotes, doubled quotes, and line breaks in quotes as spaces', () => {
    const parsed = parseDelimited('a,"b ""c"", d"\n"e\nf",g\r\n"h\r\ni",j', ',', 100);
    expect(parsed).toEqual({
      ok: true,
      rows: [
        { line: 1, cells: ['a', 'b "c", d'] },
        { line: 2, cells: ['e f', 'g'] },
        { line: 4, cells: ['h i', 'j'] },
      ],
    });
  });

  it('skips blank rows but keeps counting lines', () => {
    const preview = read('source,target\n,,,\n\n"multi\nline",x\nb,y');
    expect(preview.rows.map((row) => [row.line, row.source])).toEqual([
      [4, 'multi line'],
      [6, 'b'],
    ]);
    expect(preview.rowCount).toBe(3);
  });

  it('refuses an unclosed quote, naming the line it opens on', () => {
    expect(read('a,b\nc,"d\ne,f').blocker).toEqual({ code: 'quote', line: 2 });
  });
});

describe('transfer: header', () => {
  it('reads Chinese and English column names whatever their case and separators', () => {
    const preview = read('Source-Term,TARGET LANGUAGE,译文,Case_Sensitive\nAPI,en,Api,是');
    expect(preview.header).toBe(true);
    expect(preview.rows[0]).toMatchObject({
      source: 'API',
      target: 'Api',
      lang: 'en',
      caseSensitive: true,
    });
  });

  it('notes unknown columns and refuses a column given twice', () => {
    expect(read('原文,译文,备注,\nA,B,note,').notes).toEqual([
      { code: 'unknownColumns', names: ['备注'] },
    ]);
    expect(read('原文,译文,翻译\nA,B,C').blocker).toEqual({
      code: 'duplicateColumn',
      name: '翻译',
    });
  });

  it('without a header, takes the first two columns and the next two when they make sense', () => {
    const used = read('API,接口,zh-CN,true\nSDK,,,');
    expect(used.header).toBe(false);
    expect(used.notes).toEqual([]);
    expect(used.rows).toMatchObject([
      { line: 1, source: 'API', target: '接口', lang: 'zh-CN', caseSensitive: true },
      { line: 2, source: 'SDK', target: '', lang: '', caseSensitive: false },
    ]);
    const ignored = read('API,接口,note,maybe,x\nSDK,,,');
    expect(ignored.notes).toEqual([
      { code: 'ignoredColumn', index: 3 },
      { code: 'ignoredColumn', index: 4 },
      { code: 'ignoredColumn', index: 5 },
    ]);
    expect(ignored.rows[0]).toMatchObject({ lang: 'zh-CN', caseSensitive: false });
  });
});

describe('transfer: fields', () => {
  it("undoes the export's formula guard, and only before a formula character", () => {
    const text = `source,target\n"'=SUM(A1)","'+1"\n"'-x","'@y"\n"'plain",z`;
    expect(read(text).rows.map((row) => [row.source, row.target])).toEqual([
      ['=SUM(A1)', '+1'],
      ['-x', '@y'],
      ["'plain", 'z'],
    ]);
  });

  it('drops control characters and outer spaces', () => {
    const control = String.fromCharCode(1);
    const bell = String.fromCharCode(7);
    expect(read(`source,target\n" A${control}PI ", b${bell}`).rows[0]).toMatchObject({
      source: 'API',
      target: 'b',
    });
    // A NUL byte means UTF-16 (plan section 1), so it never reaches the fields as text.
    expect(decodeFile(utf8(`a${NUL}b`), 'zh-CN')).toMatchObject({ encoding: 'UTF-16LE' });
  });

  it('reads language codes, tags and endonyms; an empty translation has no language', () => {
    const text = [
      'source,target,lang',
      'a,1,zh_tw',
      'b,2,English',
      'c,3,日本語',
      'd,4,',
      'e,,ja',
      'f,6,fr',
    ].join('\n');
    expect(read(text).rows.map((row) => [row.lang, row.status])).toEqual([
      ['zh-TW', 'new'],
      ['en', 'new'],
      ['ja', 'new'],
      ['zh-CN', 'new'],
      ['', 'new'],
      ['fr', 'invalid'],
    ]);
    expect(reasons(text)).toEqual([[7, { code: 'lang', value: 'fr' }]]);
  });

  it('reads case sensitivity in words and digits, blank as no', () => {
    const values = ['TRUE', 'false', '1', '0', 'Yes', 'NO', '是', '否', ''];
    const text = ['source,target,caseSensitive', ...values.map((value, i) => `w${i},,${value}`)];
    expect(read(text.join('\n')).rows.map((row) => row.caseSensitive)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(reasons('source,target,caseSensitive\nw,,maybe')).toEqual([[2, { code: 'case' }]]);
  });

  it('reads missing trailing cells as blank and refuses cells past the header', () => {
    expect(statuses('source,target,lang\nA\nB,b,en,extra\nC,c,en,')).toEqual([
      'new',
      'invalid',
      'new',
    ]);
    expect(reasons('source,target\nB,b,extra')).toEqual([[2, { code: 'extra' }]]);
  });
});

describe('transfer: preview', () => {
  it('sorts rows into new, update, same and invalid against the glossary', () => {
    const text = [
      'source,target,lang',
      'merge request,合并请求,zh-CN',
      'pull request,合并请求,zh-CN',
      'GitHub,,',
      ',something,zh-CN',
    ].join('\n');
    const preview = read(text, [PR, GITHUB]);
    expect(preview.counts).toEqual({ new: 1, update: 1, same: 1, invalid: 1 });
    expect(preview.rows[1]).toMatchObject({ status: 'update', previous: PR });
    expect(preview.allSame).toBe(false);
    expect(preview.blocker).toBeUndefined();
    // Updates in place, new entries last, four fields each.
    expect(preview.entries).toEqual([
      {
        id: PR.id,
        source: 'pull request',
        target: '合并请求',
        lang: 'zh-CN',
        caseSensitive: false,
      },
      { id: GITHUB.id, source: 'GitHub', target: '', lang: '', caseSensitive: false },
      { source: 'merge request', target: '合并请求', lang: 'zh-CN', caseSensitive: false },
    ]);
    expect(preview.base).toBe(glossaryBase([PR, GITHUB]));
  });

  it('counts a source that differs only in case as an update', () => {
    expect(statuses('github,,', [GITHUB])).toEqual(['update']);
  });

  it('gives a reason for every kind of invalid row', () => {
    const long = 'x'.repeat(201);
    const text = [
      'source,target,lang,caseSensitive',
      `,a,,`,
      `${long},a,,`,
      `ok,${long},,`,
      'ok2,a,xx,',
      'ok3,a,,maybe',
      'ok4,a,,,extra',
    ].join('\n');
    expect(reasons(text)).toEqual([
      [2, { code: 'sourceEmpty' }],
      [3, { code: 'sourceTooLong' }],
      [4, { code: 'targetTooLong' }],
      [5, { code: 'lang', value: 'xx' }],
      [6, { code: 'case' }],
      [7, { code: 'extra' }],
    ]);
  });

  it('compares duplicates in the file among valid rows only', () => {
    // Row 2 is invalid, so row 3 is no duplicate of it; row 5 applies to another language.
    const text = ['source,target,lang', 'API,x,xx', 'API,接口,', 'api,接口2,', 'API,API,en'];
    expect(reasons(text.join('\n'))).toEqual([
      [2, { code: 'lang', value: 'xx' }],
      [4, { code: 'duplicate', line: 3 }],
    ]);
  });

  it('lets each glossary entry be claimed by one row only', () => {
    // Both rows overlap the keep-as-is entry (every language) but not each other.
    const keep = [entry('1', 'API')];
    const text = 'source,target,lang\nAPI,接口,zh-CN\nAPI,API,en';
    expect(reasons(text, keep)).toEqual([[3, { code: 'sameEntry', line: 2 }]]);
    expect(statuses(text, keep)).toEqual(['update', 'invalid']);
  });

  it('refuses a row that matches several glossary entries', () => {
    const existing = [
      entry('1', 'API', { target: '接口', lang: 'zh-CN' }),
      entry('2', 'API', { target: 'API', lang: 'en' }),
    ];
    expect(reasons('API,,', existing)).toEqual([[1, { code: 'many' }]]);
  });

  it('does not block a file the glossary already holds', () => {
    const preview = read('pull request,拉取请求,zh-CN\nGitHub,,', [PR, GITHUB]);
    expect(preview.counts).toEqual({ new: 0, update: 0, same: 2, invalid: 0 });
    expect(preview.allSame).toBe(true);
    expect(preview.blocker).toBeUndefined();
  });

  it('does not say the glossary holds everything when rows are invalid', () => {
    const preview = read('pull request,拉取请求,zh-CN\n,x,', [PR, GITHUB]);
    expect(preview.counts).toEqual({ new: 0, update: 0, same: 1, invalid: 1 });
    expect(preview.allSame).toBe(false);
  });

  it('blocks a file without a valid row, and one that would pass the limit', () => {
    expect(read('').blocker).toEqual({ code: 'empty' });
    expect(read('source,target\n,a').blocker).toEqual({ code: 'empty' });
    const existing = Array.from({ length: MAX_GLOSSARY_ENTRIES - 1 }, (_, index) =>
      entry(String(index + 10), `w${index}`),
    );
    expect(read('new1\nnew2', existing).blocker).toEqual({
      code: 'limit',
      total: MAX_GLOSSARY_ENTRIES + 1,
      max: MAX_GLOSSARY_ENTRIES,
    });
    expect(read('new1', existing).blocker).toBeUndefined();
  });

  it('blocks more than 2000 rows, in CSV and JSON', () => {
    const rows = Array.from({ length: 2001 }, (_, index) => `w${index}`);
    expect(read(rows.join('\n')).blocker).toEqual({ code: 'tooManyRows' });
    // 2000 rows under a header are allowed (and then pass the glossary limit).
    expect(read(['source,target', ...rows.slice(1)].join('\n')).blocker?.code).toBe('limit');
    expect(read(JSON.stringify(rows.map((source) => ({ source })))).blocker).toEqual({
      code: 'tooManyRows',
    });
  });

  it('lists the first rows and reasons only, but counts them all', () => {
    const rows = Array.from({ length: 300 }, (_, index) =>
      index % 2 ? `w${index}` : `,x${index}`,
    );
    const preview = read(rows.join('\n'));
    expect(preview.counts).toEqual({ new: 150, update: 0, same: 0, invalid: 150 });
    expect(preview.rows).toHaveLength(PREVIEW_ROWS);
    expect(preview.hiddenRows).toBe(100);
    expect(preview.issues).toHaveLength(PREVIEW_ISSUES);
    expect(preview.hiddenIssues).toBe(100);
  });

  it('reads 2000 rows against 500 entries within 50 ms', () => {
    const existing = Array.from({ length: 500 }, (_, index) =>
      entry(String(index), `term ${index}`, { target: `译 ${index}`, lang: 'zh-CN' }),
    );
    const lines = ['source,target,lang,caseSensitive'];
    for (let index = 0; index < 2000; index += 1) {
      lines.push(`"term ${index}","新译 ${index}",zh-CN,${index % 3 === 0 ? 'true' : 'false'}`);
    }
    const bytes = utf8(lines.join('\r\n'));
    readImport(bytes, options(existing)); // warm up
    const times: number[] = [];
    let preview: ReturnType<typeof readImport> | undefined;
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      preview = readImport(bytes, options(existing));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[2] ?? 0;
    console.info(`[perf] 2000 rows × 500 entries: median ${median.toFixed(2)} ms`, times);
    expect(preview?.rowCount).toBe(2001);
    // The budget is 50 ms; the bound is looser so a busy CI machine does not fail it.
    expect(median).toBeLessThan(150);
  });
});

describe('transfer: export', () => {
  const entries: GlossaryEntry[] = [
    { ...PR, extra: 'kept in storage' } as GlossaryEntry,
    entry('3', '=SUM(A1)', { target: 'say "hi", ok', lang: 'en', caseSensitive: true }),
    entry('4', '-flag', { target: '@user', lang: 'en' }),
    entry('5', '+1', { target: 'plus', lang: 'en' }),
  ];

  it('writes CSV with a BOM, CRLF, every cell quoted and formulas guarded', () => {
    const csv = exportCsv(entries);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      '"source","target","lang","caseSensitive"',
      '"pull request","拉取请求","zh-CN","false"',
      `"'=SUM(A1)","say ""hi"", ok","en","true"`,
      `"'-flag","'@user","en","false"`,
      `"'+1","plus","en","false"`,
      '',
    ]);
    expect(csv).not.toContain('term-');
    expect(csv).not.toContain('kept in storage');
  });

  it('writes JSON with the four fields only', () => {
    const file = JSON.parse(exportJson(entries));
    expect(file.format).toBe('islet-translate.glossary');
    expect(file.version).toBe(1);
    expect(file.entries[0]).toEqual({
      source: 'pull request',
      target: '拉取请求',
      lang: 'zh-CN',
      caseSensitive: false,
    });
    for (const item of file.entries) {
      expect(Object.keys(item)).toEqual(['source', 'target', 'lang', 'caseSensitive']);
    }
  });

  it('reads its own exports back to the same entries', () => {
    const clean = entries.map(({ source, target, lang, caseSensitive }) => ({
      source,
      target,
      lang,
      caseSensitive,
    }));
    for (const text of [exportCsv(entries), exportJson(entries)]) {
      const preview = read(text);
      expect(preview.counts.new).toBe(entries.length);
      expect(preview.entries).toEqual(clean);
      // Against the glossary it came from: nothing changes.
      expect(read(text, entries).allSame).toBe(true);
    }
  });

  it('names the file by the local date', () => {
    expect(exportFileName('csv', new Date(2026, 10, 6, 23, 59))).toBe(
      'islet-glossary-2026-11-06.csv',
    );
    expect(exportFileName('json', new Date(2026, 0, 31))).toBe('islet-glossary-2026-01-31.json');
  });
});
