import { describe, expect, it } from 'vitest';
import {
  type DetectedLanguages,
  defaultTargetLanguage,
  isObviouslyTargetScript,
  isTargetLanguage,
  isTargetScript,
  normalizeLanguage,
} from './languages';

describe('normalizeLanguage', () => {
  it.each([
    ['zh_cn', 'zh-CN'],
    ['ZH-cn', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh_HK', 'zh-TW'],
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-Hant', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['en-US', 'en'],
    ['ja-JP', 'ja'],
    ['ko', 'ko'],
  ])('maps %s to %s', (tag, code) => {
    expect(normalizeLanguage(tag)).toBe(code);
  });

  it.each(['xx', 'fr-FR', ''])('returns undefined for unsupported tag %j', (tag) => {
    expect(normalizeLanguage(tag)).toBeUndefined();
  });
});

describe('defaultTargetLanguage', () => {
  it('uses the UI language when supported', () => {
    expect(defaultTargetLanguage('ja-JP')).toBe('ja');
  });

  it('falls back to en', () => {
    expect(defaultTargetLanguage('fr-FR')).toBe('en');
    expect(defaultTargetLanguage('')).toBe('en');
  });
});

describe('isTargetLanguage', () => {
  const long = 'This is long enough text';
  const result = (language: string, percentage: number, isReliable = true): DetectedLanguages => ({
    isReliable,
    languages: [{ language, percentage }],
  });

  it('is true for a reliable top language at 80% or more that equals the target', () => {
    expect(isTargetLanguage(long, result('en', 80), 'en')).toBe(true);
    expect(isTargetLanguage(long, result('en-US', 100), 'en')).toBe(true);
  });

  it('is false below 80%, when unreliable, missing or for another language', () => {
    expect(isTargetLanguage(long, result('en', 79), 'en')).toBe(false);
    expect(isTargetLanguage(long, result('en', 100, false), 'en')).toBe(false);
    expect(isTargetLanguage(long, undefined, 'en')).toBe(false);
    expect(isTargetLanguage(long, result('fr', 100), 'en')).toBe(false);
  });

  it('is false for text shorter than 10 characters', () => {
    expect(isTargetLanguage('too short', result('en', 100), 'en')).toBe(false);
    expect(isTargetLanguage('exactly 10', result('en', 100), 'en')).toBe(true);
  });

  it('keeps Simplified and Traditional Chinese apart and picks the top language', () => {
    expect(isTargetLanguage(long, result('zh-TW', 100), 'zh-CN')).toBe(false);
    expect(isTargetLanguage(long, result('zh', 100), 'zh-CN')).toBe(true);
    const mixed: DetectedLanguages = {
      isReliable: true,
      languages: [
        { language: 'fr', percentage: 10 },
        { language: 'en', percentage: 90 },
      ],
    };
    expect(isTargetLanguage(long, mixed, 'en')).toBe(true);
  });
});

describe('isObviouslyTargetScript', () => {
  it('never skips for a Chinese target (Han text goes on to detection)', () => {
    expect(isObviouslyTargetScript('你好，世界', 'zh-CN')).toBe(false);
    expect(isObviouslyTargetScript('漢字だけでなく', 'zh-TW')).toBe(false);
    expect(isObviouslyTargetScript('한국어 텍스트', 'zh-CN')).toBe(false);
  });

  it('skips kana text for a Japanese target unless it has hangul', () => {
    expect(isObviouslyTargetScript('これはテストです', 'ja')).toBe(true);
    expect(isObviouslyTargetScript('これは 한국어', 'ja')).toBe(false);
    expect(isObviouslyTargetScript('漢字漢字', 'ja')).toBe(false);
    expect(isObviouslyTargetScript('plain English', 'ja')).toBe(false);
  });

  it('skips mostly-hangul text for a Korean target', () => {
    expect(isObviouslyTargetScript('이것은 테스트입니다', 'ko')).toBe(true);
    expect(isObviouslyTargetScript('이것은 테스트 ok', 'ko')).toBe(true);
    expect(isObviouslyTargetScript('이 is a long English sentence', 'ko')).toBe(false);
    expect(isObviouslyTargetScript('plain English', 'ko')).toBe(false);
  });

  it('does not pre-check other targets', () => {
    expect(isObviouslyTargetScript('Plain English text', 'en')).toBe(false);
    expect(isObviouslyTargetScript('これはテスト', 'en')).toBe(false);
  });
});

describe('isTargetScript (the palette’s fallback when detection is unsure)', () => {
  it.each([
    ['你好', 'zh-CN', true],
    ['你好', 'zh-TW', true],
    ['漢字', 'ja', true],
    ['你好', 'en', false],
    ['ありがとう', 'ja', true],
    ['ありがとう', 'zh-CN', false],
    ['これは 한국어', 'ja', false],
    ['안녕하세요 ok', 'ko', true],
    ['안녕하세요', 'zh-CN', false],
    ['hi there', 'en', true],
    ['hi there', 'zh-CN', false],
    ['hi 你', 'en', false],
    ['123 !?', 'en', false],
  ] as const)('%s in %s: %s', (text, target, expected) => {
    expect(isTargetScript(text, target)).toBe(expected);
  });
});
