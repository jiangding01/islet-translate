// Google's plain-text endpoint sometimes drops the inline tags of a page segment
// when the sentence is reordered (claude.dev, 2026-11-17: "written and <t0>reviewed
// by Claude</t0>" came back with no tags at all). Its HTML mode puts them on the
// right words, so such an item is sent once more as HTML and converted back.
//
// Measured on translate_a/t with format=html (m2 plan, appendix B):
// - nested <a> is flattened (HTML forbids it), <a> around <b> keeps the nesting;
// - an empty <code> survives untouched.
// Hence: outermost pair → <a id>, inner pairs → <b id>, void → <code id></code>.
//
// Glossary terms (M4-C) are marked `<gN>…</gN>` by the service and sent as
// `<span translate="no" id="gN">`: Google keeps the word and its place in the sentence
// (m4c plan, appendix A). Line breaks go as `<br>`, since a raw `\n` is merged or even
// answered with an empty string in HTML mode; Google adds a space after each `<br>`.
//
// The reply is never parsed as HTML: tags are matched by pattern, text is decoded.
//
// Known limit: the adapter does not know which prefix a segment chose, so a page
// whose own text literally reads like a tag of another prefix (`<u1>`) has it
// treated as a tag here. At worst that costs one extra request (or no repair);
// the text itself round-trips unchanged.

/** Segment tags as segment() writes them (prefixes as in content/segment.ts), and term marks. */
const SOURCE_TAG = /<(\/?)((?:tt|uu|t|u|w|z|g)\d{1,3})(\/?)>/g;
/** Segment tags as content/segment.ts `tokenize` still accepts them in a reply. */
const REPLY_TAG = /<(\/?)((?:tt|uu|t|u|w|z|g)\d{1,3})\s*(\/?)>/g;
/** Google's line breaks: the tag and the spaces it adds around it. */
const LINE_BREAK = / *<br\s*\/?> */gi;
const HTML_TAG = /<(\/?)([a-z]+)\b([^>]*)>/gi;
const ID_ATTRIBUTE = /\bid\s*=\s*"([^"]*)"/i;

type Kind = 'pair' | 'void';
type Token = { type: 'open' | 'close' | 'void'; id: string };

/** `t007` → `t7`: segment.ts `tokenize` compares ids as numbers. */
function canonical(id: string): string {
  const match = /^([a-z]+)(\d+)$/.exec(id);
  return match ? `${match[1]}${Number(match[2])}` : id;
}

function tokens(text: string, pattern: RegExp): Token[] {
  return [...text.matchAll(pattern)].map((match) => ({
    type: match[1] ? 'close' : match[3] ? 'void' : 'open',
    id: canonical(match[2] ?? ''),
  }));
}

/** The source's tags by id, or undefined when they are not a well-formed set. */
function sourceKinds(source: string): Map<string, Kind> | undefined {
  const kinds = new Map<string, Kind>();
  const stack: string[] = [];
  for (const token of tokens(source, SOURCE_TAG)) {
    if (token.type === 'close') {
      if (stack.pop() !== token.id) return undefined;
      continue;
    }
    if (kinds.has(token.id)) return undefined;
    kinds.set(token.id, token.type === 'void' ? 'void' : 'pair');
    if (token.type === 'open') stack.push(token.id);
  }
  return stack.length === 0 ? kinds : undefined;
}

/** Whether the source carries segment tags at all. */
export function hasTags(source: string): boolean {
  return /<\/?(?:tt|uu|t|u|w|z|g)\d{1,3}\/?>/.test(source);
}

/**
 * Whether every source tag comes back exactly once, of the same kind and properly
 * nested: the same rule content/segment.ts `restoreTranslation` applies.
 */
export function tagsIntact(source: string, output: string): boolean {
  const kinds = sourceKinds(source);
  if (!kinds) return false;
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const token of tokens(output, REPLY_TAG)) {
    const kind = kinds.get(token.id);
    if (!kind) return false;
    if (token.type === 'close') {
      if (stack.pop() !== token.id) return false;
      continue;
    }
    if (seen.has(token.id) || (token.type === 'void') !== (kind === 'void')) return false;
    seen.add(token.id);
    if (token.type === 'open') stack.push(token.id);
  }
  return stack.length === 0 && seen.size === kinds.size;
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

/** Term marks (`gN`) become spans Google leaves untranslated. */
const isTerm = (id: string) => id.startsWith('g');

/**
 * The source with its tags as HTML elements and its line breaks as `<br>`; undefined when the
 * tags are malformed.
 */
export function toHtml(source: string): string | undefined {
  if (!sourceKinds(source)) return undefined;
  const out: string[] = [];
  const open: string[] = [];
  let last = 0;
  for (const match of source.matchAll(SOURCE_TAG)) {
    const index = match.index ?? 0;
    out.push(escapeText(source.slice(last, index)));
    last = index + match[0].length;
    const id = match[2] ?? '';
    if (match[1]) out.push(`</${open.pop()}>`);
    else if (match[3]) out.push(`<code id="${id}"></code>`);
    else if (isTerm(id)) {
      open.push('span');
      out.push(`<span translate="no" id="${id}">`);
    } else {
      const name = open.length === 0 ? 'a' : 'b';
      open.push(name);
      out.push(`<${name} id="${id}">`);
    }
  }
  out.push(escapeText(source.slice(last)));
  return out.join('');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = Number.parseInt(
        body[1] === 'x' || body[1] === 'X' ? body.slice(2) : body.slice(1),
        body[1] === 'x' || body[1] === 'X' ? 16 : 10,
      );
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * An HTML reply back to segment tags and line breaks; undefined unless it holds only our
 * elements, balanced, and the result passes `tagsIntact` against the source.
 */
export function fromHtml(reply: string, source: string): string | undefined {
  const kinds = sourceKinds(source);
  if (!kinds) return undefined;
  const html = reply.replace(LINE_BREAK, '<br>');
  const out: string[] = [];
  const stack: { name: string; id?: string }[] = [];
  let last = 0;
  for (const match of html.matchAll(HTML_TAG)) {
    const index = match.index ?? 0;
    out.push(decodeEntities(html.slice(last, index)));
    last = index + match[0].length;
    const name = (match[2] ?? '').toLowerCase();
    if (name === 'br' && !match[1]) {
      out.push('\n');
      continue;
    }
    if (name !== 'a' && name !== 'b' && name !== 'code' && name !== 'span') return undefined;
    if (match[1]) {
      const top = stack.pop();
      if (!top || top.name !== name) return undefined;
      if (top.id) out.push(`</${top.id}>`);
      continue;
    }
    const id = ID_ATTRIBUTE.exec(match[3] ?? '')?.[1];
    const kind = id ? kinds.get(id) : undefined;
    if (
      !id ||
      !kind ||
      (kind === 'void') !== (name === 'code') ||
      isTerm(id) !== (name === 'span')
    ) {
      return undefined;
    }
    if (kind === 'void') {
      // Anything Google put inside the empty <code> stays as text after the tag.
      out.push(`<${id}/>`);
      stack.push({ name });
    } else {
      out.push(`<${id}>`);
      stack.push({ name, id });
    }
  }
  if (stack.length > 0) return undefined;
  out.push(decodeEntities(html.slice(last)));
  const text = out.join('');
  return tagsIntact(source, text) ? text : undefined;
}
