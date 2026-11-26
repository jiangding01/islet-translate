import type { LanguageCode } from '@/lib/languages';
import type { GlossaryEntry } from './types';

// Background-only: finds glossary terms in a segment (docs/plans/m4c-glossary.md, section 2).

/** A term found in a segment; `start` / `end` are offsets into the segment as given. */
export interface TermHit {
  start: number;
  end: number;
  entry: GlossaryEntry;
}

interface Compiled {
  entry: GlossaryEntry;
  pattern: RegExp;
  /** Whether the term starts / ends with a word character (only then is a boundary needed). */
  head: boolean;
  tail: boolean;
}

/** Segment tags as content/segment.ts writes them; matching never crosses one. */
const SEGMENT_TAG = /<\/?(?:tt|uu|t|u|w|z)\d{1,3}\/?>/g;
const WORD = /^[\p{L}\p{N}\p{M}_]$/u;
/** Han, kana and Hangul are not word characters: CJK text has no spaces between words. */
const CJK = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]$/u;
const SPECIAL = /[\\^$.*+?()[\]{}|]/g;

export function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char) && !CJK.test(char);
}

export function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const code = text.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2
    ? text.slice(index - 2, index)
    : text[index - 1];
}

export function charAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** Compiled per glossary snapshot (the array object) and target language. */
const compiledCache = new WeakMap<readonly GlossaryEntry[], Map<string, Compiled[]>>();

function compile(entries: readonly GlossaryEntry[], target: LanguageCode): Compiled[] {
  let byTarget = compiledCache.get(entries);
  if (!byTarget) {
    byTarget = new Map();
    compiledCache.set(entries, byTarget);
  }
  const cached = byTarget.get(target);
  if (cached) return cached;
  const compiled = entries
    .filter((entry) => entry.lang === '' || entry.lang === target)
    .map((entry, index) => ({ entry, index }))
    // Longest first; equal lengths keep the stored order (sort is stable).
    .sort((a, b) => b.entry.source.length - a.entry.source.length || a.index - b.index)
    .map(({ entry }) => ({
      entry,
      pattern: new RegExp(
        entry.source.replace(SPECIAL, '\\$&'),
        entry.caseSensitive ? 'gu' : 'giu',
      ),
      head: isWordChar(charAt(entry.source, 0)),
      tail: isWordChar(charBefore(entry.source, entry.source.length)),
    }));
  byTarget.set(target, compiled);
  return compiled;
}

/** The text without segment tags, each visible offset's original offset, and where tags were. */
function visibleText(text: string) {
  let visible = '';
  const offsets: number[] = [];
  const cuts = new Set<number>();
  let last = 0;
  const take = (end: number) => {
    for (let index = last; index < end; index += 1) offsets.push(index);
    visible += text.slice(last, end);
  };
  for (const match of text.matchAll(SEGMENT_TAG)) {
    const index = match.index ?? 0;
    take(index);
    cuts.add(visible.length);
    last = index + match[0].length;
  }
  take(text.length);
  return { visible, offsets, cuts };
}

/**
 * The terms of `entries` that apply to `target`, found in `text`: longest first, never
 * overlapping, never across a segment tag, with word boundaries checked on the visible text
 * (tags removed). Sorted by position.
 */
export function findTerms(
  entries: readonly GlossaryEntry[],
  target: LanguageCode,
  text: string,
): TermHit[] {
  if (entries.length === 0 || text === '') return [];
  const compiled = compile(entries, target);
  if (compiled.length === 0) return [];
  const { visible, offsets, cuts } = visibleText(text);
  const taken = new Uint8Array(visible.length);
  const hits: TermHit[] = [];
  for (const { entry, pattern, head, tail } of compiled) {
    pattern.lastIndex = 0;
    for (;;) {
      const match = pattern.exec(visible);
      if (!match) break;
      const start = match.index;
      const end = start + match[0].length;
      if (end === start) break;
      let ok =
        !(head && isWordChar(charBefore(visible, start))) &&
        !(tail && isWordChar(charAt(visible, end)));
      for (let index = start; ok && index < end; index += 1) {
        if (taken[index] || (index > start && cuts.has(index))) ok = false;
      }
      if (!ok) {
        // Try again one character later: a shorter overlap may still fit.
        pattern.lastIndex = start + (charAt(visible, start)?.length ?? 1);
        continue;
      }
      taken.fill(1, start, end);
      hits.push({
        start: offsets[start] ?? start,
        end: (offsets[end - 1] ?? end - 1) + 1,
        entry,
      });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
