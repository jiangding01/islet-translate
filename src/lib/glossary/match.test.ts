import { describe, expect, it } from 'vitest';
import { findTerms } from './match';
import type { GlossaryEntry } from './types';

let seq = 0;
function entry(source: string, fields: Partial<GlossaryEntry> = {}): GlossaryEntry {
  seq += 1;
  return {
    id: `term-${String(seq).padStart(8, '0')}`,
    source,
    target: '',
    lang: '',
    caseSensitive: false,
    ...fields,
  };
}

/** The matched source text of each hit, in order. */
function found(entries: GlossaryEntry[], text: string, target: GlossaryEntry['lang'] = 'zh-CN') {
  return findTerms(entries, target || 'zh-CN', text).map((hit) => text.slice(hit.start, hit.end));
}

describe('findTerms: word boundaries', () => {
  it('matches whole English words only', () => {
    const terms = [entry('Sonnet')];
    expect(found(terms, 'Sonnets are poems')).toEqual([]);
    expect(found(terms, 'an unsonnet thing')).toEqual([]);
    expect(found(terms, 'Sonnet_2 and Sonnet2')).toEqual([]);
    expect(found(terms, 'Use Sonnet, then Sonnet.')).toEqual(['Sonnet', 'Sonnet']);
  });

  it('matches CJK terms without spaces around them', () => {
    expect(found([entry('机器学习')], '我喜欢机器学习和数据。')).toEqual(['机器学习']);
    expect(found([entry('クロード')], 'クロードは便利です')).toEqual(['クロード']);
    expect(found([entry('클로드')], '클로드를 사용')).toEqual(['클로드']);
    // Known limit: a CJK term also matches inside a longer word.
    expect(found([entry('数据')], '数据库')).toEqual(['数据']);
  });

  it('matches terms that start or end with punctuation', () => {
    const terms = [entry('Node.js'), entry('C++'), entry('Ctrl+T')];
    expect(found(terms, 'Use Node.js and C++, then press Ctrl+T.')).toEqual([
      'Node.js',
      'C++',
      'Ctrl+T',
    ]);
    // The word character at the start still needs a boundary before it.
    expect(found(terms, 'AC++ and xNode.js')).toEqual([]);
  });

  it('treats special characters of the term literally', () => {
    expect(found([entry('a.b')], 'axb a.b')).toEqual(['a.b']);
    expect(found([entry('(x)')], 'f(x) (x)')).toEqual(['(x)', '(x)']);
  });
});

describe('findTerms: priority and overlap', () => {
  it('prefers the longer term and never overlaps', () => {
    const terms = [entry('pull'), entry('pull request')];
    const text = 'Open a pull request, then pull.';
    const hits = findTerms(terms, 'zh-CN', text);
    expect(hits.map((hit) => [text.slice(hit.start, hit.end), hit.entry.source])).toEqual([
      ['pull request', 'pull request'],
      ['pull', 'pull'],
    ]);
  });

  it('keeps the stored order for terms of the same length', () => {
    const a = entry('foo bar');
    const b = entry('bar baz');
    expect(findTerms([a, b], 'zh-CN', 'foo bar baz').map((hit) => hit.entry)).toEqual([a]);
    expect(findTerms([b, a], 'zh-CN', 'foo bar baz').map((hit) => hit.entry)).toEqual([b]);
  });
});

describe('findTerms: case', () => {
  it('ignores case unless the entry asks for it', () => {
    expect(found([entry('Sonnet')], 'a sonnet by SONNET')).toEqual(['sonnet', 'SONNET']);
    expect(found([entry('Sonnet', { caseSensitive: true })], 'a sonnet by Sonnet')).toEqual([
      'Sonnet',
    ]);
  });

  it('takes offsets from the text itself, so case expansions never shift them', () => {
    // 'İ'.toLowerCase() is two code units long: lower-casing first would move every offset.
    const text = 'İİ İzmir Sonnet';
    const [hit] = findTerms([entry('sonnet')], 'en', text);
    expect(hit?.start).toBe(text.indexOf('Sonnet'));
    expect(hit?.end).toBe(text.length);
  });
});

describe('findTerms: segment tags', () => {
  it('matches inside tags and maps the offsets to the tagged text', () => {
    const text = 'Try <t0>Sonnet</t0> today';
    const [hit] = findTerms([entry('Sonnet')], 'zh-CN', text);
    expect(hit && text.slice(hit.start, hit.end)).toBe('Sonnet');
    expect(hit?.start).toBe(8);
  });

  it('checks boundaries on the visible text and never crosses a tag', () => {
    expect(found([entry('Sonnet')], '<t0>Sonnet</t0>s')).toEqual([]);
    expect(found([entry('Sonnet')], 'Son<t0>net</t0>')).toEqual([]);
    expect(found([entry('pull request')], 'a <t0>pull</t0> request')).toEqual([]);
    expect(found([entry('pull request')], 'a <t1/>pull request<t2/>')).toEqual(['pull request']);
  });
});

describe('findTerms: target language', () => {
  it('uses entries for the target language or for every language', () => {
    const cn = entry('pull request', { target: '拉取请求', lang: 'zh-CN' });
    const tw = entry('pull request', { target: '拉取請求', lang: 'zh-TW' });
    const keep = entry('Sonnet');
    const text = 'Sonnet opened a pull request';
    expect(findTerms([cn, tw, keep], 'zh-CN', text).map((hit) => hit.entry)).toEqual([keep, cn]);
    expect(findTerms([cn, tw, keep], 'zh-TW', text).map((hit) => hit.entry)).toEqual([keep, tw]);
    expect(findTerms([cn, tw, keep], 'ja', text).map((hit) => hit.entry)).toEqual([keep]);
  });

  it('finds nothing without entries or text', () => {
    expect(findTerms([], 'zh-CN', 'Sonnet')).toEqual([]);
    expect(findTerms([entry('Sonnet')], 'zh-CN', '')).toEqual([]);
  });
});
