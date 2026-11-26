import { charAt, charBefore, isWordChar, type TermHit } from '@/lib/glossary/match';
import type { LanguageCode } from '@/lib/languages';
import { sha256Hex, stableStringify } from './cache-key';
import type { GlossaryPair } from './prompt';

// Background-only: glossary terms in the translation path (docs/plans/m4c-glossary.md,
// sections 3 to 7). Machine translation gets each term wrapped as `<gN>…</gN>` (N from 0, in
// segment order) and fills the term back in locally; AI engines get the terms in the prompt.

/** A segment that already reads like a term mark is never marked (it stays without terms). */
const TERM_LIKE = /<\/?g\d/;
/** Any g tag in a reply, in whatever form, so a mangled one is not taken for text. */
const ANY_TERM_TAG = /<\s*\/?\s*g\d+\s*\/?\s*>/gi;
const TERM_TAG = /^<(\/?)g(\d{1,3})>$/;
/** Segment tags (and anything shaped like one): a term's content must hold none. */
const INLINE_TAG = /<\s*\/?\s*[a-z]{1,2}\d+\s*\/?\s*>/i;
const SEGMENT_TAG = /<\/?(?:tt|uu|t|u|w|z)\d{1,3}\s*\/?>/g;
const LEADING_TAGS = /^(?:<\/?(?:tt|uu|t|u|w|z)\d{1,3}\s*\/?>)*/;
const ONE_TAG = /^<\/?(?:tt|uu|t|u|w|z)\d{1,3}\s*\/?>$/;
const ALNUM = /^[\p{L}\p{N}]$/u;
const ONLY_PUNCTUATION = /^[\s\p{P}]*$/u;
/** Targets written without spaces between words: a filled-in term gets no space added. */
const UNSPACED = new Set(['zh', 'ja', 'ko']);

export function hasTermLikeText(text: string): boolean {
  return TERM_LIKE.test(text);
}

/** The text with each hit wrapped as `<gN>…</gN>`. */
export function markTerms(text: string, hits: readonly TermHit[]): string {
  let out = '';
  let last = 0;
  hits.forEach((hit, index) => {
    out += `${text.slice(last, hit.start)}<g${index}>${text.slice(hit.start, hit.end)}</g${index}>`;
    last = hit.end;
  });
  return out + text.slice(last);
}

/** What a hit becomes in the translation: its target, or the source term as written. */
function termValue(text: string, hit: TermHit): string {
  return hit.entry.target !== '' ? hit.entry.target : text.slice(hit.start, hit.end);
}

/**
 * A filled-in term, and whether its source term starts / ends with a CJK character: only
 * there does Google leave out the space a spaced target needs.
 */
type Part = { text: string } | { term: string; head: boolean; tail: boolean };

const isAlnum = (char: string | undefined) => char !== undefined && ALNUM.test(char);
/** A letter that is not a word character: Han, kana or Hangul (match.ts). */
const isCjk = (char: string | undefined) => isAlnum(char) && !isWordChar(char);

function termPart(text: string, hit: TermHit): Part {
  return {
    term: termValue(text, hit),
    head: isCjk(charAt(text, hit.start)),
    tail: isCjk(charBefore(text, hit.end)),
  };
}

/** The text without the segment tags it ends with, and those tags. */
function splitTrailingTags(text: string): [string, string] {
  let end = text.length;
  while (end > 0 && text[end - 1] === '>') {
    const open = text.lastIndexOf('<', end - 1);
    if (open < 0 || !ONE_TAG.test(text.slice(open, end))) break;
    end = open;
  }
  return [text.slice(0, end), text.slice(end)];
}

/**
 * Joins text and filled-in terms. For a target that separates words with spaces, a side of a
 * term whose source starts / ends with a CJK character gets a space when a letter or digit is
 * right next to it (looking past segment tags), put outside the tags: Google writes
 * `used<span…>通义千问</span>and`. Next to a Latin source term Google keeps its own spacing
 * (`multiple <span…>API</span>s` stays as it is).
 */
function joinParts(parts: readonly Part[], target: LanguageCode): string {
  const spaced = !UNSPACED.has(target.split('-')[0] ?? target);
  let out = '';
  let spaceAfter = false;
  for (const part of parts) {
    if ('term' in part) {
      if (spaced && part.head && part.term !== '') {
        const [before, tags] = splitTrailingTags(out);
        if (isAlnum(charBefore(before, before.length))) out = `${before} ${tags}`;
      }
      out += part.term;
      spaceAfter = spaced && part.tail && part.term !== '';
      continue;
    }
    let { text } = part;
    if (spaceAfter) {
      const tags = LEADING_TAGS.exec(text)?.[0] ?? '';
      const rest = text.slice(tags.length);
      if (isAlnum(charAt(rest, 0))) text = `${tags} ${rest}`;
    }
    out += text;
    spaceAfter = false;
  }
  return out;
}

/**
 * The machine translation of a marked segment with its terms filled in, or undefined unless
 * every `gN` of the segment comes back exactly once, as an open and a close tag with no tag in
 * between. A term keeps the target of its entry, or the source term as written: never what
 * the engine put between the marks.
 */
export function restoreTerms(
  reply: string,
  text: string,
  hits: readonly TermHit[],
  target: LanguageCode,
): string | undefined {
  const parts: Part[] = [];
  const seen = new Set<number>();
  let last = 0;
  let open: { id: number; end: number } | undefined;
  for (const match of reply.matchAll(ANY_TERM_TAG)) {
    const index = match.index ?? 0;
    const tag = TERM_TAG.exec(match[0]);
    if (!tag) return undefined;
    const id = Number(tag[2]);
    const hit = hits[id];
    if (tag[1]) {
      if (!open || open.id !== id || INLINE_TAG.test(reply.slice(open.end, index))) {
        return undefined;
      }
      open = undefined;
      last = index + match[0].length;
      continue;
    }
    if (open || !hit || seen.has(id)) return undefined;
    seen.add(id);
    parts.push({ text: reply.slice(last, index) }, termPart(text, hit));
    open = { id, end: index + match[0].length };
  }
  if (open || seen.size !== hits.length) return undefined;
  parts.push({ text: reply.slice(last) });
  return joinParts(parts, target);
}

/** Whether a stored machine reply can be filled in (its marks are intact). */
export function termsIntact(reply: string, text: string, hits: readonly TermHit[]): boolean {
  return restoreTerms(reply, text, hits, 'en') !== undefined;
}

/** Whether the segment is nothing but terms, whitespace, punctuation and segment tags. */
export function isOnlyTerms(text: string, hits: readonly TermHit[]): boolean {
  if (hits.length === 0) return false;
  let rest = '';
  let last = 0;
  for (const hit of hits) {
    rest += text.slice(last, hit.start);
    last = hit.end;
  }
  rest += text.slice(last);
  return ONLY_PUNCTUATION.test(rest.replace(SEGMENT_TAG, ''));
}

/**
 * The segment with every term filled in locally (a segment that is only terms); undefined in
 * the odd case where the segment itself reads like a mark.
 */
export function localTerms(
  text: string,
  hits: readonly TermHit[],
  target: LanguageCode,
): string | undefined {
  return restoreTerms(markTerms(text, hits), text, hits, target);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The distinct entries of the hits, as the cache key and the prompt see them, sorted. */
function termsOf(hits: readonly TermHit[]) {
  const terms = new Map<string, { source: string; target: string; caseSensitive: boolean }>();
  for (const { entry } of hits) {
    const term = {
      source: entry.source,
      target: entry.target,
      caseSensitive: entry.caseSensitive,
    };
    terms.set(stableStringify(term), term);
  }
  return [...terms.values()].sort(
    (a, b) =>
      compareText(a.source, b.source) ||
      compareText(a.target, b.target) ||
      Number(a.caseSensitive) - Number(b.caseSensitive),
  );
}

/** The `glossary` part of a segment's cache key: a digest of the terms found in it. */
export function glossaryDigest(hits: readonly TermHit[]): Promise<string> {
  return sha256Hex(stableStringify(termsOf(hits)));
}

/** The terms an AI request is told about: every term found in its segments, sorted. */
export function glossaryPairs(hitLists: readonly (readonly TermHit[])[]): GlossaryPair[] {
  const pairs = new Map<string, GlossaryPair>();
  for (const { source, target } of termsOf(hitLists.flat())) {
    pairs.set(stableStringify({ source, target }), { source, target });
  }
  return [...pairs.values()];
}
