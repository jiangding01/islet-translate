import { isPlainObject } from './merge';

// Extra request body fields (M4-A): JSON object text the user types for OpenAI and custom
// providers. Pure and zod-free: the background checks writes and reads it per request, the
// settings page checks the draft.

// Top-level keys that merging (`Object.assign`) would treat as the prototype or that only
// make sense as one: never request fields, so the text is refused rather than half sent.
const RESERVED = ['__proto__', 'constructor', 'prototype'];

/**
 * The fields of an extra body text: `undefined` when there are none (blank, `{}`), `null`
 * when it is not a JSON object or has a reserved top-level key.
 */
export function parseExtraBody(text: unknown): Record<string, unknown> | undefined | null {
  if (text === undefined || (typeof text === 'string' && text.trim() === '')) return undefined;
  if (typeof text !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || RESERVED.some((key) => Object.hasOwn(value, key))) return null;
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Blank, or a JSON object. */
export function isExtraBodyValid(text: string): boolean {
  return parseExtraBody(text) !== null;
}
