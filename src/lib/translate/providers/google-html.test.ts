import { describe, expect, it } from 'vitest';
import { fromHtml, hasTags, tagsIntact, toHtml } from './google-html';

// Real translate_a/t replies, 2026-11-17 (m2 plan, appendix B).
const LEAD =
  'On the Claude Code team, the vast majority of our code (~90%) is written and <t0>reviewed by Claude</t0>. At this scale, how we equip our agents to verify their work with evidence becomes extremely important.';
const LEAD_PLAIN_REPLY =
  '在 Claude 代码团队中，我们的绝大多数代码 (~90%) 都是由 Claude 编写和审查的。在这种规模下，我们如何让我们的特工用证据来验证他们的工作变得极其重要。';
const LEAD_HTML_REPLY =
  '在 Claude 代码团队中，我们的绝大多数代码（~90%）都是<a id="t0">由 Claude 编写和审查的</a>。在这种规模下，我们如何让我们的特工用证据来验证他们的工作变得极其重要。';
const NESTED = 'Read <t0>the <t1>full</t1> guide</t0> before you run <t2/> & restart.';
const NESTED_HTML_REPLY =
  '跑步前请阅读<a id="t0"><b id="t1">完整</b>指南</a><code id="t2"></code>并重新启动。';

describe('hasTags', () => {
  it('finds segment tags of every prefix and nothing else', () => {
    expect(hasTags(LEAD)).toBe(true);
    expect(hasTags('a <uu3/> b')).toBe(true);
    expect(hasTags('Use <h1> for titles')).toBe(false);
    expect(hasTags(LEAD_PLAIN_REPLY)).toBe(false);
  });
});

describe('tagsIntact', () => {
  it('accepts every tag back once, moved and properly nested', () => {
    expect(tagsIntact(NESTED, '阅读<t0><t1>完整</t1>指南</t0>后运行<t2/>。')).toBe(true);
    expect(tagsIntact(NESTED, '运行<t2/>前阅读<t0>指南<t1>完整</t1></t0>')).toBe(true);
    // segment.ts tokenize tolerates whitespace before the closing bracket and
    // compares ids as numbers (`<t00>` is `<t0>`).
    expect(tagsIntact(LEAD, '由 <t0 >Claude 审查</t0 >')).toBe(true);
    expect(tagsIntact(LEAD, '由 <t00>Claude 审查</t00>')).toBe(true);
  });

  it.each([
    ['dropped', LEAD, LEAD_PLAIN_REPLY],
    ['one missing', NESTED, '阅读<t0>指南</t0><t2/>'],
    ['duplicated', NESTED, '<t0>a</t0><t0>b</t0><t1>c</t1><t2/>'],
    ['crossed', NESTED, '<t0><t1>a</t0></t1><t2/>'],
    ['unknown id', NESTED, '<t0><t1>a</t1></t0><t2/><t3/>'],
    ['void as pair', NESTED, '<t0><t1>a</t1></t0><t2>x</t2>'],
    ['unclosed', NESTED, '<t0><t1>a</t1><t2/>'],
  ])('rejects tags that are %s', (_name, source, output) => {
    expect(tagsIntact(source, output)).toBe(false);
  });
});

describe('toHtml', () => {
  it('uses <a> outermost, <b> inside, an empty <code> for voids, and escapes text', () => {
    expect(toHtml(NESTED)).toBe(
      'Read <a id="t0">the <b id="t1">full</b> guide</a> before you run <code id="t2"></code> &amp; restart.',
    );
    expect(toHtml('<t0>a <t1>b <t2>c</t2></t1></t0> 1 < 2')).toBe(
      '<a id="t0">a <b id="t1">b <b id="t2">c</b></b></a> 1 &lt; 2',
    );
  });

  it('refuses a source whose tags are malformed', () => {
    expect(toHtml('<t0>a</t1>')).toBeUndefined();
    expect(toHtml('<t0>a')).toBeUndefined();
    expect(toHtml('<t0>a</t0><t0>b</t0>')).toBeUndefined();
  });
});

describe('fromHtml', () => {
  it('turns the real replies back into segment tags', () => {
    expect(fromHtml(LEAD_HTML_REPLY, LEAD)).toBe(
      '在 Claude 代码团队中，我们的绝大多数代码（~90%）都是<t0>由 Claude 编写和审查的</t0>。在这种规模下，我们如何让我们的特工用证据来验证他们的工作变得极其重要。',
    );
    expect(fromHtml(NESTED_HTML_REPLY, NESTED)).toBe(
      '跑步前请阅读<t0><t1>完整</t1>指南</t0><t2/>并重新启动。',
    );
  });

  it('decodes entities and keeps text Google put inside a void', () => {
    expect(
      fromHtml(
        '<a id="t0">A &amp; B</a> &lt;x&gt; &quot;q&quot; &#39;s &#x4E2D; <code id="t2">npm</code><b id="t1">c</b>',
        '<t0>a</t0> <t1>c</t1> <t2/>',
      ),
    ).toBe('<t0>A & B</t0> <x> "q" \'s 中 <t2/>npm<t1>c</t1>');
  });

  it.each([
    ['a foreign element', '<a id="t0">x</a><span>y</span>'],
    ['an unknown id', '<a id="t9">x</a>'],
    ['a missing id', '<a>x</a>'],
    ['a mismatched close', '<a id="t0">x</b>'],
    ['an unclosed element', '<a id="t0">x'],
    ['a void written as a pair', '<a id="t0">x</a><a id="t2">y</a>'],
    ['a tag left out', '<a id="t0">x</a>'],
  ])('rejects a reply with %s', (_name, html) => {
    expect(fromHtml(html, '<t0>a</t0> <t2/>')).toBeUndefined();
  });

  it('rejects a reply that still lost every tag', () => {
    expect(fromHtml(LEAD_PLAIN_REPLY, LEAD)).toBeUndefined();
  });
});

describe('glossary term marks and line breaks (M4-C)', () => {
  const TERMS = 'We used <g0>通义千问</g0> & <t0>read <g1>Sonnet</g1></t0>.\nNext line';

  it('sends marks as untranslated spans inside the other tags, and line breaks as <br>', () => {
    expect(hasTags('only <g0>x</g0>')).toBe(true);
    expect(toHtml(TERMS)).toBe(
      'We used <span translate="no" id="g0">通义千问</span> &amp; <a id="t0">read <span translate="no" id="g1">Sonnet</span></a>.<br>Next line',
    );
    // The stack pairs the closing tags with the span, not with an outer tag.
    expect(toHtml('<t0><g0>a</g0> b</t0> <g1>c</g1>')).toBe(
      '<a id="t0"><span translate="no" id="g0">a</span> b</a> <span translate="no" id="g1">c</span>',
    );
  });

  it('turns the spans back into marks and <br> (with the spaces Google adds) into line breaks', () => {
    expect(
      fromHtml(
        '我们使用了<span translate="no" id="g0">通义千问</span>&amp;<a id="t0">读<span id="g1" translate="no">Sonnet</span></a>。<br> 下一行',
        TERMS,
      ),
    ).toBe('我们使用了<g0>通义千问</g0>&<t0>读<g1>Sonnet</g1></t0>。\n下一行');
    expect(fromHtml('a <br/> b<br />c', 'a\nb\nc')).toBe('a\nb\nc');
  });

  it.each([
    [
      'a mark sent back as a link',
      '<a id="g0">x</a><a id="t0">y<span translate="no" id="g1">z</span></a>',
    ],
    [
      'a link sent back as a span',
      '<span id="g0">x</span><span id="t0">y<span id="g1">z</span></span>',
    ],
    ['a mark dropped', '<span id="g0">x</span><a id="t0">y</a>'],
    ['a closing br', '<span id="g0">x</span></br><a id="t0">y<span id="g1">z</span></a>'],
  ])('rejects a reply with %s', (_name, html) => {
    expect(fromHtml(html, TERMS)).toBeUndefined();
  });

  it('round-trips multi-line text without tags', () => {
    const source = 'line one\nline two\n\nline four';
    const html = toHtml(source) ?? '';
    expect(html).toBe('line one<br>line two<br><br>line four');
    expect(fromHtml(html.replace(/<br>/g, '<br> '), source)).toBe(source);
  });
});
