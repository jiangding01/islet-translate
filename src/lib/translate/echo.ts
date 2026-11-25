import type { LanguageCode } from '@/lib/languages';

// Machine translation sometimes answers 200 yet leaves whole sentences of the
// source untouched. Such a result is still shown, but must not be cached (and
// Google gets one more try on its other endpoint).

/** A source sentence counts only with at least this many Latin words… */
export const ECHO_MIN_WORDS = 4;
/** …this many Latin letters… */
export const ECHO_MIN_LETTERS = 20;
/** …and this many all-lowercase words of two letters or more (prose, not a product name). */
export const ECHO_MIN_LOWERCASE_WORDS = 2;

/** Inline tags of page segments (<t0>, </t0>, <t1/>; prefixes are one or two letters). */
export const INLINE_TAG = /<\s*\/?\s*[a-z]{1,2}\d+\s*\/?\s*>/gi;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/gi;
/** Sentence ends: ASCII ones need whitespace after them, full-width ones do not. */
const SENTENCE_END = /(?<=[.?!;])\s+|(?<=[。？！；])/;
const TRAILING_PUNCTUATION = /[\s.?!;:,。？！；：，]+$/;
/** Characters that mark code or markup rather than prose. */
const CODE_LIKE = /[=<>{}`$\\|_]/;
const LATIN_WORD = /\p{Script=Latin}+/gu;
const LOWERCASE_WORD = /^\p{Ll}{2,}$/u;
/** Targets written in Latin script: a Latin sentence left as-is may be correct there. */
const LATIN_TARGETS: ReadonlySet<string> = new Set(['en']);

function baseCode(code: string): string {
  return code.split('-')[0]?.toLowerCase() ?? code;
}

function normalize(text: string): string {
  return text.replace(INLINE_TAG, '').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** A source sentence long and prose-like enough that finding it verbatim means an echo. */
function isProse(sentence: string): boolean {
  if (CODE_LIKE.test(sentence)) return false;
  const words = sentence.match(LATIN_WORD) ?? [];
  if (words.length < ECHO_MIN_WORDS) return false;
  let letters = 0;
  let lowercase = 0;
  for (const word of words) {
    letters += word.length;
    if (LOWERCASE_WORD.test(word)) lowercase += 1;
  }
  return letters >= ECHO_MIN_LETTERS && lowercase >= ECHO_MIN_LOWERCASE_WORDS;
}

/**
 * True when the translation contains, verbatim, a prose sentence of the source:
 * inline tags and zero-width characters are dropped and whitespace collapsed on
 * both sides; the source is split after `. ? ! ;` (and their full-width forms)
 * and around URLs and e-mail addresses; only sentences with enough Latin words and letters (see the constants above)
 * and no code characters are looked for. Never true when the known source
 * language matches the target, or when the target itself uses Latin script.
 */
export function isEchoedTranslation(
  source: string,
  translation: string,
  languages: { source: LanguageCode | 'auto'; target: LanguageCode },
): boolean {
  const target = baseCode(languages.target);
  if (LATIN_TARGETS.has(target)) return false;
  if (languages.source !== 'auto' && baseCode(languages.source) === target) return false;
  const output = normalize(translation);
  if (output === '') return false;
  // URLs and e-mail addresses stay as they are in any language: they end a fragment.
  const sentences = normalize(source)
    .split(SENTENCE_END)
    .flatMap((sentence) => sentence.split(URL_LIKE));
  return sentences.some((raw) => {
    const sentence = raw.replace(/\s+/g, ' ').trim().replace(TRAILING_PUNCTUATION, '');
    return isProse(sentence) && output.includes(sentence);
  });
}
