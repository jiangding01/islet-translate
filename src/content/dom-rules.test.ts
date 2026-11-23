// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOST_TAGS,
  isProtected,
  isSingleLineLocked,
  protectedAncestor,
  SKIP_TAGS,
  type StyleReader,
} from './dom-rules';

/** happy-dom's own handle on the window; the page's hostname follows its URL. */
const setURL = (url: string) =>
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

/** Builds the markup in the body and returns the element matching `selector`. */
function find(markup: string, selector: string): Element {
  document.body.innerHTML = markup;
  return document.querySelector(selector) as Element;
}

describe('protectedAncestor', () => {
  it('finds the editor around a node inside it', () => {
    const el = find('<div id="ed" contenteditable="true"><p id="x">Draft</p></div>', '#x');
    expect(protectedAncestor(el, document.body)).toBe(document.getElementById('ed'));
  });

  it('checks the element itself', () => {
    const el = find('<div id="ed" contenteditable="true">Draft</div>', '#ed');
    expect(protectedAncestor(el, document.body)).toBe(el);
  });

  it('treats an empty contenteditable and plaintext-only as editable', () => {
    const empty = find('<div id="ed" contenteditable=""><p id="x">Draft</p></div>', '#x');
    expect(protectedAncestor(empty, document.body)?.id).toBe('ed');
    const plain = find(
      '<div id="ed" contenteditable="plaintext-only"><p id="x">Draft</p></div>',
      '#x',
    );
    expect(protectedAncestor(plain, document.body)?.id).toBe('ed');
  });

  it('still finds the editor through a contenteditable="false" island inside it', () => {
    const el = find(
      '<div id="ed" contenteditable="true"><div contenteditable="false"><p id="x">Chip</p></div></div>',
      '#x',
    );
    expect(protectedAncestor(el, document.body)?.id).toBe('ed');
  });

  it('finds translate="no", .notranslate, nav, pre and data-et ancestors', () => {
    const cases: [string, string][] = [
      ['<div id="a" translate="no"><p id="x">Text</p></div>', 'a'],
      ['<div id="a" class="notranslate"><p id="x">Text</p></div>', 'a'],
      ['<nav id="a"><p id="x">Text</p></nav>', 'a'],
      ['<pre id="a"><span id="x">Text</span></pre>', 'a'],
      ['<div id="a" data-et="1"><p id="x">Text</p></div>', 'a'],
    ];
    for (const [markup, id] of cases) {
      expect(protectedAncestor(find(markup, '#x'), document.body)?.id).toBe(id);
    }
  });

  it('ignores hidden, inert and aria-hidden ancestors', () => {
    for (const attribute of ['hidden', 'inert', 'aria-hidden="true"']) {
      const el = find(`<div ${attribute}><p id="x">Text</p></div>`, '#x');
      expect(protectedAncestor(el, document.body)).toBeNull();
    }
  });

  it('returns null for an ordinary paragraph', () => {
    expect(
      protectedAncestor(find('<div><p id="x">Text</p></div>', '#x'), document.body),
    ).toBeNull();
  });

  it('does not check the stop element itself', () => {
    document.body.innerHTML = '<p id="x">Text</p>';
    document.body.className = 'notranslate';
    try {
      expect(protectedAncestor(document.getElementById('x') as Element, document.body)).toBeNull();
    } finally {
      document.body.className = '';
    }
  });
});

describe('role=img', () => {
  it('is protected', () => {
    expect(isProtected(find('<div role="img" aria-label="chart">x</div>', 'div'))).toBe(true);
  });
});

describe('code block toolbars', () => {
  it.each([
    [
      'claude.dev',
      '<div class="art-code"><div class="ch"><span>CODE<span class="lang">Python</span></span><button>Copy</button></div><pre>x = 1</pre></div>',
      '.ch',
    ],
    [
      'MDN',
      '<div class="code-example"><div class="example-header"><span class="language-name">js</span></div><pre>x</pre></div>',
      '.example-header',
    ],
    [
      'VitePress',
      '<div class="language-sh"><button class="copy"></button><span class="lang">sh</span><pre>ls</pre></div>',
      '.lang',
    ],
    [
      'Docusaurus',
      '<div><div class="codeBlockTitle">/src/components/HelloCodeTitle/index.js</div><div class="codeBlockContent"><pre>x</pre></div></div>',
      '.codeBlockTitle',
    ],
    [
      'Tailwind',
      '<div><div class="relative"><div>Terminal</div><button>Copy</button></div><div><pre>npm i</pre></div></div>',
      '.relative',
    ],
  ])('protects the %s toolbar', (_site, markup, selector) => {
    expect(isProtected(find(markup, selector))).toBe(true);
  });

  it.each([
    ['a heading', '<h3 class="title">Setup</h3><pre>x</pre>', '.title'],
    ['a label after the block', '<pre>x</pre><div class="lang">py</div>', '.lang'],
    [
      'a span inside a sentence',
      '<ul><li>Install <span class="lang">Python</span> first:<pre>x</pre></li></ul>',
      '.lang',
    ],
    [
      'a long text with a button',
      `<div>${'long text '.repeat(6)}<button>Copy</button></div><pre>x</pre>`,
      'div',
    ],
    [
      'a titled sentence',
      '<div class="title">Example 1. Configuring the server</div><div><pre>x</pre></div>',
      '.title',
    ],
    ['a paragraph', '<p>Run:</p><pre>x</pre>', 'p'],
    ['a plain div', '<div>Output:</div><pre>x</pre>', 'div'],
  ])('leaves %s alone', (_name, markup, selector) => {
    expect(isProtected(find(markup, selector))).toBe(false);
  });
});

describe('site skips', () => {
  let originalHref = '';
  beforeEach(() => {
    originalHref = location.href;
  });
  afterEach(() => {
    setURL(originalHref);
  });

  const figure = () => find('<figure class="efx-fig"><div class="in">x</div></figure>', '.efx-fig');

  it.each([
    ['https://www.claude.dev/blog', true],
    ['https://claude.dev/', true],
    ['https://notclaude.dev/', false],
    ['https://example.com/', false],
  ])('on %s the mock-up is protected: %s', (url, expected) => {
    setURL(url);
    expect(isProtected(figure())).toBe(expected);
  });
});

describe('isSingleLineLocked', () => {
  const root = document.createElement('div');
  const read =
    (style: Record<string, string>): StyleReader =>
    () => ({ display: 'block', ...style });

  it.each([
    ['a run with nowrap', 'run', { whiteSpace: 'nowrap' }, true],
    ['a run with pre', 'run', { whiteSpace: 'pre' }, true],
    ['a flex root with nowrap', 'block', { display: 'flex', whiteSpace: 'nowrap' }, true],
    ['a grid root with pre', 'block', { display: 'inline-grid', whiteSpace: 'pre' }, true],
    [
      'a block with nowrap and ellipsis',
      'block',
      { whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
      true,
    ],
    ['a block with only nowrap', 'block', { whiteSpace: 'nowrap' }, false],
    ['a block with only ellipsis', 'block', { textOverflow: 'ellipsis' }, false],
    ['a run with pre-wrap', 'run', { whiteSpace: 'pre-wrap' }, false],
    ['a run with normal white-space', 'run', { whiteSpace: 'normal' }, false],
    ['a flex root that wraps normally', 'block', { display: 'flex', whiteSpace: 'normal' }, false],
    ['a run with no white-space known', 'run', {}, false],
  ] as const)('%s: %s', (_name, kind, style, expected) => {
    expect(isSingleLineLocked({ kind, root }, read(style))).toBe(expected);
  });
});

describe('our interface hosts', () => {
  it('are all skipped: every HOST_TAGS entry is in SKIP_TAGS', () => {
    expect(HOST_TAGS).toEqual(['ET-ISLE', 'ET-SELECTION', 'ET-PALETTE']);
    for (const tag of HOST_TAGS) expect(SKIP_TAGS.has(tag)).toBe(true);
  });
});
