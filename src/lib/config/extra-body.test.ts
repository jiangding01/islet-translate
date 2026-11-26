import { describe, expect, it } from 'vitest';
import { isExtraBodyValid, parseExtraBody } from './extra-body';

describe('extra request body', () => {
  it('reads a JSON object', () => {
    expect(parseExtraBody('{"reasoning_effort": "low"}')).toEqual({ reasoning_effort: 'low' });
    expect(parseExtraBody('\n  {\n "a": {"b": [1, 2]} }\n')).toEqual({ a: { b: [1, 2] } });
  });

  it('treats blank text and an empty object as no extra fields', () => {
    for (const text of ['', '   ', '\n', '{}', ' { } ', undefined]) {
      expect(parseExtraBody(text)).toBeUndefined();
      if (text !== undefined) expect(isExtraBodyValid(text)).toBe(true);
    }
  });

  it('rejects anything that is not a JSON object', () => {
    for (const text of ['[]', '[1]', '1', '"x"', 'null', 'true', '{', '{"a": }', "{'a': 1}", 'a']) {
      expect(parseExtraBody(text)).toBeNull();
      expect(isExtraBodyValid(text)).toBe(false);
    }
  });

  it('rejects top-level keys that could reach the prototype instead of the request', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const text = `{"a": 1, "${key}": {"x": 1}}`;
      expect(parseExtraBody(text)).toBeNull();
      expect(isExtraBodyValid(text)).toBe(false);
    }
    // Nested, they are plain data: sent as typed and keyed as sent.
    expect(parseExtraBody('{"a": {"__proto__": 1}}')).toEqual(
      JSON.parse('{"a": {"__proto__": 1}}'),
    );
  });

  it('ignores a value that is not text (hand-edited storage)', () => {
    for (const value of [1, {}, [], null, true]) expect(parseExtraBody(value)).toBeNull();
  });
});
