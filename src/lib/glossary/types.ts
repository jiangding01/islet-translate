import { isPlainObject } from '@/lib/config/merge';
import { isLanguageCode, type LanguageCode } from '@/lib/languages';

// Glossary (M4-C): shared by the background (the only writer) and the settings page (reads
// storage directly). Zod-free on purpose, like src/lib/config/client.ts; content scripts never
// import it.

export const GLOSSARY_STORAGE_KEY = 'glossary';
export const GLOSSARY_VERSION = 1;
export const MAX_GLOSSARY_ENTRIES = 500;
export const GLOSSARY_LIMITS = { source: 200, target: 200 } as const;
export const GLOSSARY_ID_PATTERN = /^term-[a-z0-9]{8}$/;

export interface GlossaryEntry {
  /** `term-` and 8 lowercase letters or digits. */
  id: string;
  /** 1–200 characters, trimmed. */
  source: string;
  /** 0–200 characters, trimmed; empty keeps the source term as it is. */
  target: string;
  /** The target language the entry applies to; `''` (only with an empty target) means every one. */
  lang: LanguageCode | '';
  caseSensitive: boolean;
}

/** The fields a change sets: everything but the id. */
export type GlossaryDraft = Omit<GlossaryEntry, 'id'>;

/**
 * One entry at a time, so two pages editing different entries never overwrite each other.
 * `update` fails for an entry that is gone instead of bringing it back; `remove` of a missing
 * entry is a no-op.
 */
export type GlossaryChange =
  | { type: 'add'; entry: GlossaryDraft }
  | { type: 'update'; id: string; entry: GlossaryDraft }
  | { type: 'remove'; id: string };

/** Stored as `storage.local.glossary`; the array order is the display order. */
export interface StoredGlossary {
  version: number;
  entries: GlossaryEntry[];
}

/** Whether a stored value is a well-formed entry (the settings page skips the others). */
export function isGlossaryEntry(value: unknown): value is GlossaryEntry {
  if (!isPlainObject(value)) return false;
  const { id, source, target, lang, caseSensitive } = value;
  return (
    typeof id === 'string' &&
    GLOSSARY_ID_PATTERN.test(id) &&
    typeof source === 'string' &&
    source.trim() !== '' &&
    source.length <= GLOSSARY_LIMITS.source &&
    typeof target === 'string' &&
    target.length <= GLOSSARY_LIMITS.target &&
    (target === '' ? lang === '' : isLanguageCode(lang)) &&
    typeof caseSensitive === 'boolean'
  );
}

/** Well-formed entries of a stored value, in stored order, without repeated ids. */
export function readGlossaryEntries(raw: unknown): GlossaryEntry[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.entries)) return [];
  const ids = new Set<string>();
  const entries: GlossaryEntry[] = [];
  for (const value of raw.entries) {
    if (!isGlossaryEntry(value) || ids.has(value.id)) continue;
    ids.add(value.id);
    entries.push(value);
  }
  return entries;
}

/** Whether two entries apply to at least one common target language. */
function sameScope(a: Pick<GlossaryEntry, 'lang'>, b: Pick<GlossaryEntry, 'lang'>): boolean {
  return a.lang === '' || b.lang === '' || a.lang === b.lang;
}

/**
 * Duplicate rule: the same source (case ignored when either entry ignores case) for an
 * overlapping target language. Exported for the settings page and the repository.
 */
export function isDuplicateEntry(a: GlossaryDraft, b: GlossaryDraft): boolean {
  if (!sameScope(a, b)) return false;
  return a.caseSensitive && b.caseSensitive
    ? a.source === b.source
    : a.source.toLowerCase() === b.source.toLowerCase();
}
