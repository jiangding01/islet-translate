// Background-only (src/lib/translate/types.ts): user text embedded in a prompt as data.

/**
 * Escapes a value that is already `JSON.stringify`-ed, so it can sit inside a prompt: `<` and
 * `>` (it can then neither form a prompt placeholder such as `<<NONCE>>` nor an inline tag
 * such as `</t0>`), and the line and paragraph separators JSON.stringify leaves as they are (it
 * stays on one line). The result still parses back to the same value.
 */
export function escapeForPrompt(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
