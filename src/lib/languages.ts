import { browser } from 'wxt/browser';

// Endonyms, never localized: they also name the languages in LLM prompts, and this file is
// in the resident content script (docs/plans/i18n.md 4.4).
export const LANGUAGES = [
  { code: 'zh-CN', name: '简体中文' }, // i18n-ignore: endonym
  { code: 'zh-TW', name: '繁體中文' }, // i18n-ignore: endonym
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' }, // i18n-ignore: endonym
  { code: 'ko', name: '한국어' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code) as [
  LanguageCode,
  ...LanguageCode[],
];

const FALLBACK_LANGUAGE: LanguageCode = 'en';

/** Chinese tags that should read Traditional script. */
const TRADITIONAL_CHINESE = new Set(['hant', 'tw', 'hk', 'mo']);

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value);
}

export function languageName(code: LanguageCode): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

/**
 * Maps a BCP 47-ish tag (`zh_cn`, `ZH-tw`, `en-US`) to a supported code,
 * or undefined when the language is not supported.
 */
export function normalizeLanguage(tag: string): LanguageCode | undefined {
  const parts = tag.trim().replaceAll('_', '-').toLowerCase().split('-').filter(Boolean);
  const [primary, ...rest] = parts;
  if (!primary) return undefined;
  if (primary === 'zh') {
    // An explicit Hans script wins over a Traditional-leaning region (zh-Hans-HK).
    if (rest.includes('hans')) return 'zh-CN';
    return rest.some((part) => TRADITIONAL_CHINESE.has(part)) ? 'zh-TW' : 'zh-CN';
  }
  return LANGUAGE_CODES.find((code) => code.toLowerCase() === primary);
}

export function defaultTargetLanguage(uiLanguage: string): LanguageCode {
  return normalizeLanguage(uiLanguage) ?? FALLBACK_LANGUAGE;
}

export function browserUiLanguage(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return FALLBACK_LANGUAGE;
  }
}

export interface DetectedLanguages {
  isReliable: boolean;
  languages: readonly { language: string; percentage: number }[];
}

/** Shorter texts are too ambiguous to skip on. */
export const DETECT_MIN_LENGTH = 10;
/** The top language must cover at least this share of the text to skip it. */
export const DETECT_MIN_PERCENTAGE = 80;

/**
 * True only when detection is reliable, its top language covers at least 80% of the
 * text and equals the target after normalization (Simplified and Traditional Chinese
 * stay distinct). `plain` is the text that was detected; shorter than the minimum
 * length, an unreliable or missing result all mean "not the target language".
 * Shared by the background (same-language skip) and the selection dot.
 */
export function isTargetLanguage(
  plain: string,
  result: DetectedLanguages | undefined,
  target: LanguageCode,
): boolean {
  if (plain.length < DETECT_MIN_LENGTH || !result?.isReliable) return false;
  let top: { language: string; percentage: number } | undefined;
  for (const candidate of result.languages ?? []) {
    if (!top || candidate.percentage > top.percentage) top = candidate;
  }
  return (
    top !== undefined &&
    top.percentage >= DETECT_MIN_PERCENTAGE &&
    normalizeLanguage(top.language) === target
  );
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LETTER = /\p{L}/gu;
const HANGUL_LETTER = /\p{Script=Hangul}/gu;
const HAN_LETTER = /\p{Script=Han}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/**
 * The cheap, synchronous script precheck for the selection dot: true only for text that
 * obviously needs no translation. It never tells Simplified from Traditional.
 * - Chinese target: never skips. Han-only text goes on to detection (it may be Japanese
 *   kanji or Traditional), and text with kana or hangul is foreign anyway.
 * - Japanese target: skips text with kana and no hangul; kana-free text goes to detection.
 * - Korean target: skips text that is mostly hangul.
 * - Any other target: no precheck.
 */
export function isObviouslyTargetScript(text: string, target: LanguageCode): boolean {
  if (target === 'ja') return KANA.test(text) && !HANGUL.test(text);
  if (target === 'ko') {
    const letters = text.match(LETTER)?.length ?? 0;
    const hangul = text.match(HANGUL_LETTER)?.length ?? 0;
    return hangul > 0 && hangul * 2 > letters;
  }
  return false;
}

/**
 * The palette's quick translation, when detection fails or is unsure (docs/plans/m3c.md, PR3):
 * whether `text` is written in `target`'s script, judged by its letters alone.
 * - Kana and no hangul: Japanese.
 * - Hangul for more than half the letters: Korean.
 * - Han for more than half the letters: the script of Chinese (either) and Japanese targets.
 * - Latin letters only: the script of an English target only.
 */
export function isTargetScript(text: string, target: LanguageCode): boolean {
  const count = (letters: RegExp) => text.match(letters)?.length ?? 0;
  const letters = count(LETTER);
  if (!letters) return false;
  if (KANA.test(text) && !HANGUL.test(text)) return target === 'ja';
  if (count(HANGUL_LETTER) * 2 > letters) return target === 'ko';
  if (count(HAN_LETTER) * 2 > letters) {
    return target === 'zh-CN' || target === 'zh-TW' || target === 'ja';
  }
  return target === 'en' && count(LATIN_LETTER) === letters;
}
