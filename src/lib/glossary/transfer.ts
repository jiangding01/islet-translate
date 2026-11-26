import { isPlainObject } from '@/lib/config/merge';
import { LANGUAGES, type LanguageCode, normalizeLanguage } from '@/lib/languages';
import {
  GLOSSARY_LIMITS,
  type GlossaryDraft,
  type GlossaryEntry,
  glossaryBase,
  type ImportEntry,
  isDuplicateEntry,
  MAX_GLOSSARY_ENTRIES,
} from './types';

// Glossary import and export (M4-D, docs/plans/m4d-glossary-transfer.md): pure functions for
// the settings page only. Reading a file goes decode → parse → preview; the preview carries
// the whole list the background writes in one `import` change.

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
/** The preview lists this many rows and this many invalid reasons; counts are always full. */
export const PREVIEW_ROWS = 200;
export const PREVIEW_ISSUES = 50;

export const EXPORT_FORMAT = 'islet-translate.glossary';
export const EXPORT_VERSION = 1;

/** Encodings a file without a BOM may be in when it is not UTF-8; the page can switch them. */
export const LEGACY_ENCODINGS = ['GB18030', 'Big5', 'Shift_JIS'] as const;
export type LegacyEncoding = (typeof LEGACY_ENCODINGS)[number];
export type EncodingName = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | LegacyEncoding;

/** Errors that stop the whole file. */
export type Blocker =
  | { code: 'tooLarge' }
  | { code: 'tooManyRows' }
  | { code: 'xlsx' }
  | { code: 'unreadable' }
  | { code: 'quote'; line: number }
  | { code: 'json' }
  | { code: 'newerVersion' }
  | { code: 'duplicateColumn'; name: string }
  | { code: 'empty' }
  | { code: 'limit'; total: number; max: number };

/** Why one row is not imported. */
export type InvalidReason =
  | { code: 'sourceEmpty' }
  | { code: 'sourceTooLong' }
  | { code: 'targetTooLong' }
  | { code: 'lang'; value: string }
  | { code: 'case' }
  | { code: 'extra' }
  | { code: 'duplicate'; line: number }
  | { code: 'sameEntry'; line: number }
  | { code: 'many' };

/** Columns read past: unknown header names, or headerless columns (1-based) not understood. */
export type ImportNote =
  | { code: 'unknownColumns'; names: string[] }
  | { code: 'ignoredColumn'; index: number };

export type RowStatus = 'new' | 'update' | 'same' | 'invalid';

export interface PreviewRow {
  /** The line of a CSV / TSV file, or the item number of a JSON array (1-based). */
  line: number;
  status: RowStatus;
  source: string;
  target: string;
  /** A language code, or for a row whose language is not supported the text as written. */
  lang: string;
  caseSensitive: boolean;
  /** The entry an `update` row overwrites. */
  previous?: GlossaryEntry;
  reason?: InvalidReason;
}

export interface ImportPreview {
  /** Undefined when the file could not be decoded at all. */
  encoding?: EncodingName;
  /** The encoding is a fallback guess (or the user's choice): the page offers the others. */
  guessed: boolean;
  /** How rows are numbered: lines of a CSV / TSV file, items of a JSON array. */
  unit: 'line' | 'item';
  /** Non-empty lines (the header included) or JSON items. */
  rowCount: number;
  /** The first line was read as the header. */
  header: boolean;
  notes: ImportNote[];
  blocker?: Blocker;
  counts: Record<RowStatus, number>;
  /** The first PREVIEW_ROWS rows, then how many are left out. */
  rows: PreviewRow[];
  hiddenRows: number;
  /** The first PREVIEW_ISSUES invalid rows, then how many are left out. */
  issues: PreviewRow[];
  hiddenIssues: number;
  /** Every valid row is already in the glossary: nothing to import, not an error. */
  allSame: boolean;
  /** The ids of the entries `update` rows overwrite (the page flashes them once written). */
  updatedIds: string[];
  /** The glossary the preview was made against (glossaryBase) and the list to write. */
  base: string;
  entries: ImportEntry[];
}

// ------------------------------------------------------------------------------ decoding

export type Decoded =
  | { ok: true; text: string; encoding: EncodingName; guessed: boolean }
  | { ok: false; blocker: Blocker; encoding?: EncodingName; guessed?: boolean };

const DECODER_LABELS: Record<EncodingName, string> = {
  'UTF-8': 'utf-8',
  'UTF-16LE': 'utf-16le',
  'UTF-16BE': 'utf-16be',
  GB18030: 'gb18030',
  Big5: 'big5',
  Shift_JIS: 'shift_jis',
};

/** Fatal decoding; a matching BOM is dropped by the decoder itself. */
function decode(bytes: Uint8Array, encoding: EncodingName): string | undefined {
  try {
    return new TextDecoder(DECODER_LABELS[encoding], { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Traditional Chinese interfaces fall back to Big5 (Excel's CSV in Taiwan and Hong Kong). */
export function fallbackEncoding(uiLanguage: string): LegacyEncoding {
  return normalizeLanguage(uiLanguage) === 'zh-TW' ? 'Big5' : 'GB18030';
}

/** UTF-16 without a BOM: NUL bytes in the first 1 KB, on odd offsets for little endian. */
function sniffUtf16(bytes: Uint8Array): EncodingName | undefined {
  let even = 0;
  let odd = 0;
  const end = Math.min(bytes.length, 1024);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) {
      if (index % 2) odd += 1;
      else even += 1;
    }
  }
  if (!even && !odd) return undefined;
  return odd >= even ? 'UTF-16LE' : 'UTF-16BE';
}

/**
 * The text of a file (plan section 1, "读取"): a UTF-16 BOM, UTF-16 told by its NUL bytes,
 * UTF-8, then the interface's fallback encoding. `chosen` is the user's pick of a legacy one.
 */
export function decodeFile(
  bytes: Uint8Array,
  uiLanguage: string,
  chosen?: LegacyEncoding,
): Decoded {
  if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, blocker: { code: 'tooLarge' } };
  // "PK\x03\x04": a zip, which is what an .xlsx is.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { ok: false, blocker: { code: 'xlsx' } };
  }
  const attempt = (encoding: EncodingName, guessed: boolean): Decoded => {
    const text = decode(bytes, encoding);
    return text === undefined
      ? { ok: false, blocker: { code: 'unreadable' }, encoding, guessed }
      : { ok: true, text, encoding, guessed };
  };
  if (chosen) return attempt(chosen, true);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return attempt('UTF-16LE', false);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return attempt('UTF-16BE', false);
  const utf16 = sniffUtf16(bytes);
  if (utf16) return attempt(utf16, false);
  const utf8 = attempt('UTF-8', false);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (utf8.ok || bom) return utf8;
  // Unreadable in the fallback too: the page still offers the other legacy encodings.
  return attempt(fallbackEncoding(uiLanguage), true);
}

// ------------------------------------------------------------------------------ parsing

interface DelimitedRow {
  /** The line the row starts on (1-based). */
  line: number;
  cells: string[];
}

type Delimited = { ok: true; rows: DelimitedRow[] } | { ok: false; blocker: Blocker };

/**
 * A Tab outside quotes on the first non-empty line makes the text tab-separated. Quotes follow
 * the reader's rule: only a `"` that starts a cell opens a quoted cell.
 */
export function sniffDelimiter(text: string): ',' | '\t' {
  let quoted = false;
  let seen = false;
  let start = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') index += 1;
        else quoted = false;
      }
    } else if (char === '"' && start) quoted = true;
    else if (char === '\t') return '\t';
    else if (char === '\n' || char === '\r') {
      if (seen) break;
      start = true;
    } else if (char === ',') start = true;
    else {
      start = false;
      if (char.trim() !== '') seen = true;
    }
  }
  return ',';
}

/**
 * An RFC 4180 reader: `""` is a quote inside a quoted cell, a line break inside one becomes a
 * space (lines are still counted). Rows whose cells are all blank are skipped. Stops once
 * `limit` rows are read: the caller only needs to know there are too many.
 */
export function parseDelimited(text: string, delimiter: string, limit: number): Delimited {
  const rows: DelimitedRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    cell = '';
  };
  for (let index = 0; index < text.length && rows.length < limit; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        cell += ' ';
        line += 1;
      } else cell += char;
    } else if (char === '"' && cell === '') {
      quoted = true;
      quoteLine = line;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else cell += char;
  }
  if (quoted) return { ok: false, blocker: { code: 'quote', line: quoteLine } };
  if (rows.length < limit && (cell !== '' || cells.length > 0)) endRow();
  return { ok: true, rows };
}

type Field = 'source' | 'target' | 'lang' | 'caseSensitive';

/**
 * Column names and JSON keys a file may use (plan section 1, "表头"), in Simplified and
 * Traditional Chinese: the Traditional format notes name the columns in Traditional script.
 */
const ALIASES: Record<Field, string[]> = {
  // i18n-ignore: column names read from files, not UI copy
  source: ['source', 'sourceterm', 'term', '原文', '原词', '术语', '原詞', '術語'],
  // i18n-ignore: column names read from files, not UI copy
  target: ['target', 'targetterm', 'translation', '译文', '译词', '翻译', '譯文', '譯詞', '翻譯'],
  // i18n-ignore: column names read from files, not UI copy
  lang: ['lang', 'language', 'targetlanguage', 'tgtlng', '目标语言', '语言', '目標語言', '語言'],
  caseSensitive: [
    'casesensitive',
    'matchcase',
    // i18n-ignore: column names read from files, not UI copy
    ...['区分大小写', '大小写敏感', '區分大小寫', '大小寫敏感'],
  ],
};

const FIELDS = new Map<string, Field>(
  Object.entries(ALIASES).flatMap(([field, names]) =>
    names.map((name): [string, Field] => [name, field as Field]),
  ),
);

/** A column name or JSON key as a field: lowercase, without spaces, `_` and `-`. */
export function fieldOf(name: string): Field | undefined {
  return FIELDS.get(name.toLowerCase().replace(/[\s_-]/g, ''));
}

// i18n-ignore: values read from files, not UI copy
const TRUE_WORDS = new Set(['true', '1', 'yes', '是']);
// i18n-ignore: values read from files, not UI copy
const FALSE_WORDS = new Set(['false', '0', 'no', '否', '']);

/** `true` / `false`, or undefined when the value says neither. Blank is false. */
export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

/** A language code from a tag (`zh_cn`, `en-US`) or a language's own name (`日本語`). */
export function readLanguage(value: string): LanguageCode | undefined {
  const text = value.trim();
  if (text === '') return undefined;
  const lower = text.toLowerCase();
  return (
    normalizeLanguage(text) ??
    LANGUAGES.find((language) => language.name.toLowerCase() === lower)?.code
  );
}

/** Drops control characters (a NUL, a stray Tab); line breaks in quotes are spaces already. */
function stripControls(text: string): string {
  let clean = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code > 31 && code !== 127) clean += char;
  }
  return clean;
}

const FORMULA_STARTS = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/** The export's guard against spreadsheet formulas (`'=x`), undone: `=x`. */
function unescapeFormula(cell: string): string {
  return cell.startsWith("'") && FORMULA_STARTS.has(cell[1] ?? '') ? cell.slice(1) : cell;
}

function cleanCell(value: unknown, fromSheet: boolean): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let cell = String(value).trim();
  if (fromSheet) cell = unescapeFormula(cell);
  return stripControls(cell).trim();
}

/** One row as read from the file, before it is compared with anything. */
interface Candidate {
  line: number;
  source: string;
  target: string;
  /** The language as written. */
  lang: string;
  caseSensitive: unknown;
  extra: boolean;
}

export interface ParsedImport {
  unit: 'line' | 'item';
  rowCount: number;
  header: boolean;
  notes: ImportNote[];
  candidates: Candidate[];
}

type Parsed = { ok: true; parsed: ParsedImport } | { ok: false; blocker: Blocker };

function parseJson(value: unknown): Parsed {
  let items: unknown = value;
  if (isPlainObject(value)) {
    if (value.format !== EXPORT_FORMAT) return { ok: false, blocker: { code: 'json' } };
    if (typeof value.version === 'number' && value.version > EXPORT_VERSION) {
      return { ok: false, blocker: { code: 'newerVersion' } };
    }
    items = value.entries;
  }
  if (!Array.isArray(items)) return { ok: false, blocker: { code: 'json' } };
  if (items.length > MAX_IMPORT_ROWS) return { ok: false, blocker: { code: 'tooManyRows' } };
  const candidates = items.map((item, index): Candidate => {
    const fields: Partial<Record<Field, unknown>> = {};
    if (isPlainObject(item)) {
      for (const [key, field] of Object.entries(item)) {
        const name = fieldOf(key);
        if (name && !(name in fields)) fields[name] = field;
      }
    }
    return {
      line: index + 1,
      source: cleanCell(fields.source, false),
      target: cleanCell(fields.target, false),
      lang: typeof fields.lang === 'string' ? fields.lang.trim() : '',
      caseSensitive: fields.caseSensitive,
      extra: false,
    };
  });
  return {
    ok: true,
    parsed: { unit: 'item', rowCount: items.length, header: false, notes: [], candidates },
  };
}

function parseSheet(textValue: string): Parsed {
  const delimiter = sniffDelimiter(textValue);
  // One row more than allowed (plus a header) is enough to know the file is too long.
  const read = parseDelimited(textValue, delimiter, MAX_IMPORT_ROWS + 2);
  if (!read.ok) return read;
  const { rows } = read;
  const first = rows[0]?.cells.map(fieldOf) ?? [];
  const header = first.includes('source') && first.includes('target');
  const data = header ? rows.slice(1) : rows;
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, blocker: { code: 'tooManyRows' } };

  const notes: ImportNote[] = [];
  /** The column of each field. */
  const columns: Partial<Record<Field, number>> = {};
  let width = Number.POSITIVE_INFINITY;
  if (header) {
    const names = rows[0]?.cells ?? [];
    width = names.length;
    const unknown: string[] = [];
    for (const [index, name] of names.entries()) {
      const field = first[index];
      if (field === undefined) {
        if (name.trim() !== '') unknown.push(name.trim());
      } else if (field in columns) {
        return { ok: false, blocker: { code: 'duplicateColumn', name: name.trim() } };
      } else columns[field] = index;
    }
    if (unknown.length) notes.push({ code: 'unknownColumns', names: unknown });
  } else {
    columns.source = 0;
    columns.target = 1;
    // The third and fourth columns are read when every value in them makes sense.
    const values = (index: number) =>
      data.map((row) => row.cells[index]?.trim() ?? '').filter((value) => value !== '');
    const langs = values(2);
    if (langs.length && langs.every((value) => readLanguage(value))) columns.lang = 2;
    else if (langs.length) notes.push({ code: 'ignoredColumn', index: 3 });
    const cases = values(3);
    if (cases.length && cases.every((value) => readBoolean(value) !== undefined)) {
      columns.caseSensitive = 3;
    } else if (cases.length) notes.push({ code: 'ignoredColumn', index: 4 });
    const widest = Math.max(0, ...data.map((row) => row.cells.length));
    for (let index = 4; index < widest; index += 1) {
      if (values(index).length) notes.push({ code: 'ignoredColumn', index: index + 1 });
    }
  }

  const cell = (row: DelimitedRow, field: Field) => {
    const index = columns[field];
    return index === undefined ? '' : (row.cells[index] ?? '');
  };
  const candidates = data.map(
    (row): Candidate => ({
      line: row.line,
      source: cleanCell(cell(row, 'source'), true),
      target: cleanCell(cell(row, 'target'), true),
      lang: cell(row, 'lang').trim(),
      caseSensitive: cell(row, 'caseSensitive'),
      // Cells past the header: only a non-empty one is an error.
      extra: row.cells.slice(width).some((value) => value.trim() !== ''),
    }),
  );
  return { ok: true, parsed: { unit: 'line', rowCount: rows.length, header, notes, candidates } };
}

/** CSV, TSV or JSON, told by the content (plan section 1, "识别格式"). */
export function parseImport(textValue: string): Parsed {
  const start = textValue.trimStart()[0];
  if (start === '{' || start === '[') {
    let value: unknown;
    let parsed = false;
    try {
      value = JSON.parse(textValue);
      parsed = true;
    } catch {
      // Not JSON after all: a CSV may well start with "[GPT]".
    }
    if (parsed) return parseJson(value);
  }
  return parseSheet(textValue);
}

// ------------------------------------------------------------------------------ preview

/** The candidate as an entry draft, or why it is invalid. */
function toDraft(candidate: Candidate, defaultLang: LanguageCode): GlossaryDraft | InvalidReason {
  const { source, target } = candidate;
  if (source === '') return { code: 'sourceEmpty' };
  if (source.length > GLOSSARY_LIMITS.source) return { code: 'sourceTooLong' };
  if (target.length > GLOSSARY_LIMITS.target) return { code: 'targetTooLong' };
  let lang: LanguageCode | '' = '';
  if (target !== '') {
    if (candidate.lang === '') lang = defaultLang;
    else {
      const code = readLanguage(candidate.lang);
      if (!code) return { code: 'lang', value: candidate.lang };
      lang = code;
    }
  }
  const caseSensitive = readBoolean(candidate.caseSensitive);
  if (caseSensitive === undefined) return { code: 'case' };
  if (candidate.extra) return { code: 'extra' };
  return { source, target, lang, caseSensitive };
}

const sameFields = (a: GlossaryDraft, b: GlossaryDraft) =>
  a.source === b.source &&
  a.target === b.target &&
  a.lang === b.lang &&
  a.caseSensitive === b.caseSensitive;

function bucketOf<T>(map: Map<string, T[]>, key: string): T[] {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Compares the parsed rows with the file's earlier rows and the glossary (plan section 1,
 * "重复与比较"). Duplicates share a lowercase source, so rows are only compared within the
 * bucket of their lowercase source: linear overall.
 */
export function previewImport(
  parsed: ParsedImport,
  existing: readonly GlossaryEntry[],
  defaultLang: LanguageCode,
): Omit<ImportPreview, 'encoding' | 'guessed'> {
  const stored = new Map<string, GlossaryEntry[]>();
  for (const entry of existing) bucketOf(stored, entry.source.toLowerCase()).push(entry);
  const accepted = new Map<string, { line: number; draft: GlossaryDraft }[]>();
  /** Which row claimed an existing entry, by id. */
  const claimed = new Map<string, number>();
  const updates = new Map<string, GlossaryDraft>();
  const added: GlossaryDraft[] = [];
  const counts: Record<RowStatus, number> = { new: 0, update: 0, same: 0, invalid: 0 };
  const all: PreviewRow[] = [];

  for (const candidate of parsed.candidates) {
    const { line } = candidate;
    const draft = toDraft(candidate, defaultLang);
    const row = (status: RowStatus, fields: GlossaryDraft, extra: Partial<PreviewRow> = {}) => {
      counts[status] += 1;
      all.push({ line, status, ...fields, ...extra });
    };
    if ('code' in draft) {
      const raw = {
        source: candidate.source,
        target: candidate.target,
        lang: candidate.target === '' ? '' : candidate.lang,
        caseSensitive: readBoolean(candidate.caseSensitive) ?? false,
      };
      row('invalid', raw as GlossaryDraft, { reason: draft });
      continue;
    }
    const key = draft.source.toLowerCase();
    const earlier = accepted.get(key)?.find((other) => isDuplicateEntry(other.draft, draft));
    if (earlier) {
      row('invalid', draft, { reason: { code: 'duplicate', line: earlier.line } });
      continue;
    }
    const matches = stored.get(key)?.filter((entry) => isDuplicateEntry(entry, draft)) ?? [];
    const [match] = matches;
    if (matches.length > 1) {
      row('invalid', draft, { reason: { code: 'many' } });
      continue;
    }
    if (match) {
      const claimer = claimed.get(match.id);
      if (claimer !== undefined) {
        row('invalid', draft, { reason: { code: 'sameEntry', line: claimer } });
        continue;
      }
      claimed.set(match.id, line);
      if (sameFields(match, draft)) row('same', draft);
      else {
        updates.set(match.id, draft);
        row('update', draft, { previous: match });
      }
    } else {
      added.push(draft);
      row('new', draft);
    }
    bucketOf(accepted, key).push({ line, draft });
  }

  const valid = counts.new + counts.update + counts.same;
  const total = existing.length + counts.new;
  let blocker: Blocker | undefined;
  if (valid === 0) blocker = { code: 'empty' };
  else if (total > MAX_GLOSSARY_ENTRIES) {
    blocker = { code: 'limit', total, max: MAX_GLOSSARY_ENTRIES };
  }

  // The four fields only: the background merges them into the stored entry by id.
  const entries: ImportEntry[] = existing.map((entry) => {
    const { source, target, lang, caseSensitive } = updates.get(entry.id) ?? entry;
    return { id: entry.id, source, target, lang, caseSensitive };
  });
  entries.push(...added);
  const issues = all.filter((row) => row.status === 'invalid');
  return {
    unit: parsed.unit,
    rowCount: parsed.rowCount,
    header: parsed.header,
    notes: parsed.notes,
    blocker,
    counts,
    rows: all.slice(0, PREVIEW_ROWS),
    hiddenRows: Math.max(0, all.length - PREVIEW_ROWS),
    issues: issues.slice(0, PREVIEW_ISSUES),
    hiddenIssues: Math.max(0, issues.length - PREVIEW_ISSUES),
    allSame: !blocker && counts.new + counts.update + counts.invalid === 0,
    updatedIds: [...updates.keys()],
    base: glossaryBase(existing),
    entries,
  };
}

export interface ImportOptions {
  /** The interface language: picks the fallback encoding. */
  uiLanguage: string;
  /** The language a translation without one applies to: the current target language. */
  defaultLang: LanguageCode;
  existing: readonly GlossaryEntry[];
  /** The user's pick of a legacy encoding. */
  encoding?: LegacyEncoding;
}

/** A preview that stops at a blocker (also for a file too large to read at all). */
export function blockedImport(
  blocker: Blocker,
  existing: readonly GlossaryEntry[],
  decoded?: { encoding?: EncodingName; guessed?: boolean },
): ImportPreview {
  return {
    encoding: decoded?.encoding,
    guessed: decoded?.guessed ?? false,
    unit: 'line',
    rowCount: 0,
    header: false,
    notes: [],
    blocker,
    counts: { new: 0, update: 0, same: 0, invalid: 0 },
    rows: [],
    hiddenRows: 0,
    issues: [],
    hiddenIssues: 0,
    allSame: false,
    updatedIds: [],
    base: glossaryBase(existing),
    entries: [],
  };
}

/** A file's bytes to its preview: decode, parse, compare. */
export function readImport(bytes: Uint8Array, options: ImportOptions): ImportPreview {
  const decoded = decodeFile(bytes, options.uiLanguage, options.encoding);
  if (!decoded.ok) return blockedImport(decoded.blocker, options.existing, decoded);
  const parsed = parseImport(decoded.text);
  if (!parsed.ok) return blockedImport(parsed.blocker, options.existing, decoded);
  return {
    encoding: decoded.encoding,
    guessed: decoded.guessed,
    ...previewImport(parsed.parsed, options.existing, options.defaultLang),
  };
}

// ------------------------------------------------------------------------------ export

/** The exported fields, taken one by one: never ids, unknown fields or anything else. */
function exported(entries: readonly GlossaryEntry[]) {
  return entries.map(({ source, target, lang, caseSensitive }) => ({
    source,
    target,
    lang,
    caseSensitive,
  }));
}

/** A cell a spreadsheet would run as a formula gets a leading `'` (undone on import). */
function csvCell(value: string): string {
  const cell = FORMULA_STARTS.has(value[0] ?? '') ? `'${value}` : value;
  return `"${cell.replaceAll('"', '""')}"`;
}

/** UTF-8 with a BOM (so Excel reads it as UTF-8), CRLF line ends, every cell quoted. */
export function exportCsv(entries: readonly GlossaryEntry[]): string {
  const lines = [['source', 'target', 'lang', 'caseSensitive'].map(csvCell).join(',')];
  for (const entry of exported(entries)) {
    lines.push(
      [entry.source, entry.target, entry.lang, String(entry.caseSensitive)].map(csvCell).join(','),
    );
  }
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

export function exportJson(entries: readonly GlossaryEntry[]): string {
  const file = { format: EXPORT_FORMAT, version: EXPORT_VERSION, entries: exported(entries) };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** `islet-glossary-YYYY-MM-DD.csv`, in local time. */
export function exportFileName(format: 'csv' | 'json', now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `islet-glossary-${date}.${format}`;
}
