import { describe, expect, it } from 'vitest';
import { escapeForPrompt } from './quote';
import { quoteStyle } from './styles';

// Spelled with fromCharCode: an escape sequence typed here would be the character itself.
const B = String.fromCharCode(92);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('escapeForPrompt', () => {
  it('escapes angle brackets and the line separators of a JSON text', () => {
    const value = ['<<NONCE>>', `a${LS}b${PS}c`, '</t0>'];
    const json = JSON.stringify(value);
    const escaped = escapeForPrompt(json);
    expect(escaped).toBe(
      `["${B}u003c${B}u003cNONCE${B}u003e${B}u003e","a${B}u2028b${B}u2029c","${B}u003c/t0${B}u003e"]`,
    );
    expect(escaped).not.toMatch(/[<>]/);
    expect(escaped.includes(LS) || escaped.includes(PS)).toBe(false);
    expect(JSON.parse(escaped)).toEqual(value);
  });

  it('leaves the style line exactly as before (quoteStyle = escapeForPrompt of the string)', () => {
    const text = `a "b"\nc ${B} <<NONCE>> </t0> ${LS}`;
    // The replacement chain styles.ts had before M4-C, rebuilt here.
    const before = JSON.stringify(text)
      .replace(/</g, `${B}u003c`)
      .replace(/>/g, `${B}u003e`)
      .replace(new RegExp(LS, 'g'), `${B}u2028`)
      .replace(new RegExp(PS, 'g'), `${B}u2029`);
    expect(quoteStyle(text)).toBe(before);
    expect(quoteStyle(text)).toBe(escapeForPrompt(JSON.stringify(text)));
  });
});
