import { describe, expect, it } from 'vitest';
import { findTerms, type TermHit } from '@/lib/glossary/match';
import type { GlossaryEntry } from '@/lib/glossary/types';
import {
  glossaryDigest,
  glossaryPairs,
  hasTermLikeText,
  isOnlyTerms,
  localTerms,
  markTerms,
  restoreTerms,
  termsIntact,
} from './terms';

const QWEN: GlossaryEntry = {
  id: 'term-aaaaaaaa',
  source: '通义千问',
  target: 'Qwen',
  lang: 'en',
  caseSensitive: false,
};
const SONNET: GlossaryEntry = {
  id: 'term-bbbbbbbb',
  source: 'Sonnet',
  target: '',
  lang: '',
  caseSensitive: true,
};
const PR: GlossaryEntry = {
  id: 'term-cccccccc',
  source: 'pull request',
  target: '拉取请求',
  lang: 'zh-CN',
  caseSensitive: false,
};

const hitsOf = (
  text: string,
  target: GlossaryEntry['lang'] & string,
  entries = [QWEN, SONNET, PR],
) => findTerms(entries, target as never, text);

describe('markTerms', () => {
  it('wraps each hit in order as gN', () => {
    const text = 'Sonnet opened a <t0>pull request</t0>.';
    expect(markTerms(text, hitsOf(text, 'zh-CN'))).toBe(
      '<g0>Sonnet</g0> opened a <t0><g1>pull request</g1></t0>.',
    );
  });

  it('tells text that already reads like a mark', () => {
    expect(hasTermLikeText('use <g0> here')).toBe(true);
    expect(hasTermLikeText('close </g12')).toBe(true);
    expect(hasTermLikeText('<go> <g>')).toBe(false);
  });
});

describe('restoreTerms', () => {
  const text = 'Sonnet opened a pull request.';
  const hits = hitsOf(text, 'zh-CN');

  it('fills in the target, or the source term as written, never the engine text', () => {
    expect(restoreTerms('<g0>十四行诗</g0> 打开了 <g1>拉请求</g1>。', text, hits, 'zh-CN')).toBe(
      'Sonnet 打开了 拉取请求。',
    );
  });

  it.each([
    ['a mark dropped', '<g0>x</g0> 打开了拉请求。'],
    ['a mark repeated', '<g0>x</g0><g0>y</g0><g1>z</g1>'],
    ['an unknown mark', '<g0>x</g0><g1>y</g1><g2>z</g2>'],
    ['marks nested', '<g0>x<g1>y</g1></g0>'],
    ['marks crossed', '<g0>x<g1>y</g0></g1>'],
    ['a close first', '</g0>x<g0><g1>y</g1>'],
    ['an unclosed mark', '<g0>x <g1>y</g1>'],
    ['a void mark', '<g0/><g1>y</g1>'],
    ['a mangled mark', '<g0 >x</g0><g1>y</g1>'],
    ['a tag inside a mark', '<g0>x<t0>y</t0></g0><g1>z</g1>'],
  ])('refuses a reply with %s', (_name, reply) => {
    expect(restoreTerms(reply, text, hits, 'zh-CN')).toBeUndefined();
    expect(termsIntact(reply, text, hits)).toBe(false);
  });

  it('adds the spaces Google leaves out for a spaced target, outside segment tags', () => {
    const source = '我们用通义千问和<t0>通义千问</t0>做了测试';
    const sourceHits = hitsOf(source, 'en');
    expect(sourceHits).toHaveLength(2);
    expect(
      restoreTerms(
        'We used<g0>通义千问</g0>and<t0><g1>通义千问</g1></t0>for tests',
        source,
        sourceHits,
        'en',
      ),
    ).toBe('We used Qwen and <t0>Qwen</t0> for tests');
    // Already spaced, or next to punctuation: nothing added.
    expect(restoreTerms('We used <g0>x</g0>, <g1>y</g1>.', source, sourceHits, 'en')).toBe(
      'We used Qwen, Qwen.',
    );
  });

  it('adds a space only on a side where the source term has a CJK character', () => {
    const api: GlossaryEntry = { ...QWEN, id: 'term-dddddddd', source: 'API', target: '' };
    const doubao: GlossaryEntry = {
      ...QWEN,
      id: 'term-eeeeeeee',
      source: '豆包',
      target: 'Doubao',
    };
    const pluralHits = findTerms([api], 'en', 'multiple API calls');
    // Latin source term: Google keeps its own spacing, nothing is added.
    expect(restoreTerms('multiple <g0>API</g0>s', 'multiple API calls', pluralHits, 'en')).toBe(
      'multiple APIs',
    );
    const qwenSource = '我们用了通义千问';
    expect(
      restoreTerms(
        'used<g0>通义千问</g0>and',
        qwenSource,
        findTerms([QWEN], 'en', qwenSource),
        'en',
      ),
    ).toBe('used Qwen and');
    const doubaoSource = '我们用了豆包';
    expect(
      restoreTerms(
        'used<g0>豆包</g0>and',
        doubaoSource,
        findTerms([doubao], 'en', doubaoSource),
        'en',
      ),
    ).toBe('used Doubao and');
  });

  it('adds no space for a target written without spaces', () => {
    const source = 'Sonnet和Sonnet';
    const sourceHits = hitsOf(source, 'ja');
    expect(restoreTerms('<g0>x</g0>と<g1>y</g1>', source, sourceHits, 'ja')).toBe('SonnetとSonnet');
  });

  it('keeps line breaks of the reply', () => {
    const source = 'Sonnet\nhas lines';
    const sourceHits = hitsOf(source, 'zh-CN');
    expect(restoreTerms('<g0>x</g0>\n有多行', source, sourceHits, 'zh-CN')).toBe('Sonnet\n有多行');
  });
});

describe('isOnlyTerms and localTerms', () => {
  it('tells a segment made of terms, punctuation and tags', () => {
    const text = '<t0>Sonnet</t0> · pull request!';
    const hits = hitsOf(text, 'zh-CN');
    expect(isOnlyTerms(text, hits)).toBe(true);
    expect(localTerms(text, hits, 'zh-CN')).toBe('<t0>Sonnet</t0> · 拉取请求!');
    expect(isOnlyTerms('Sonnet rocks', hitsOf('Sonnet rocks', 'zh-CN'))).toBe(false);
    expect(isOnlyTerms('Hello', [])).toBe(false);
  });
});

describe('glossaryDigest and glossaryPairs', () => {
  const hit = (entry: GlossaryEntry): TermHit => ({ start: 0, end: 1, entry });

  it('depends on the distinct terms only, not on their order or ids', async () => {
    const a = await glossaryDigest([hit(SONNET), hit(PR), hit(SONNET)]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await glossaryDigest([hit(PR), hit({ ...SONNET, id: 'term-zzzzzzzz' })])).toBe(a);
    expect(await glossaryDigest([hit(PR), hit({ ...SONNET, caseSensitive: false })])).not.toBe(a);
    expect(await glossaryDigest([hit({ ...PR, target: '合并请求' }), hit(SONNET)])).not.toBe(a);
  });

  it('lists the union of the terms, sorted by source', () => {
    expect(glossaryPairs([[hit(SONNET), hit(PR)], [hit(PR)], []])).toEqual([
      { source: 'Sonnet', target: '' },
      { source: 'pull request', target: '拉取请求' },
    ]);
  });
});
