import { type AppError, isAppError } from '@/lib/errors';
import { isEchoedTranslation } from '../echo';
import type { ProviderAdapter, ProviderContext, ProviderEvent } from '../types';
import { badResponseError, errorFromResponse, safeFetch } from './errors';
import { fromHtml, hasTags, tagsIntact, toHtml } from './google-html';

const BASE = 'https://translate.googleapis.com/translate_a';
const LIMITS = { maxItems: 50, maxChars: 5000 };
/** The GET fallback shares the URL length ceiling; above this Google answers 429. */
const SINGLE_MAX_ENCODED_BYTES = 6000;

type Attempt = { ok: true; texts: string[] } | { ok: false; error: AppError; fallback: boolean };

function query(ctx: ProviderContext): string {
  return `client=gtx&sl=${encodeURIComponent(ctx.source)}&tl=${encodeURIComponent(ctx.target)}`;
}

/** Reads the shapes translate_a/t returns; undefined when unrecognizable. */
function readRows(json: unknown, count: number): string[] | undefined {
  if (typeof json === 'string') return [json];
  if (!Array.isArray(json) || json.length === 0) return undefined;
  if (json.every((row): row is string => typeof row === 'string')) {
    // One item may come back as ["text", "detected-lang"].
    return count === 1 ? json.slice(0, 1) : json;
  }
  const rows: string[] = [];
  for (const row of json) {
    const text = Array.isArray(row) ? row[0] : row;
    if (typeof text !== 'string') return undefined;
    rows.push(text);
  }
  return rows;
}

async function primary(batch: string[], ctx: ProviderContext, html = false): Promise<Attempt> {
  const body = new URLSearchParams();
  for (const text of batch) body.append('q', text);
  let response: Response;
  try {
    response = await safeFetch(ctx, `${BASE}/t?${query(ctx)}${html ? '&format=html' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { ok: false, error, fallback: error.code === 'network/fetch-failed' };
  }
  if (!response.ok) {
    const { status } = response;
    const fallback = status === 403 || status === 404 || status >= 500;
    return { ok: false, error: await errorFromResponse(response), fallback };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: badResponseError(), fallback: true };
  }
  const rows = readRows(json, batch.length);
  if (!rows) return { ok: false, error: badResponseError(), fallback: true };
  if (rows.length !== batch.length) {
    return { ok: false, error: badResponseError('Item count mismatch'), fallback: false };
  }
  return { ok: true, texts: rows };
}

async function single(text: string, ctx: ProviderContext): Promise<string> {
  const url = `${BASE}/single?${query(ctx)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await safeFetch(ctx, url, { method: 'GET' });
  if (!response.ok) throw await errorFromResponse(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw badResponseError();
  }
  const segments = Array.isArray(json) ? json[0] : undefined;
  if (!Array.isArray(segments)) throw badResponseError();
  let result = '';
  for (const segment of segments) {
    if (!Array.isArray(segment) || typeof segment[0] !== 'string') throw badResponseError();
    result += segment[0];
  }
  return result;
}

function fitsSingle(text: string): boolean {
  return encodeURIComponent(text).length <= SINGLE_MAX_ENCODED_BYTES;
}

/**
 * translate_a/t sometimes answers 200 with sentences left in the source language.
 * Each such item gets one more try on translate_a/single: its answer replaces the
 * first one only when it no longer echoes. A failed retry (429, block page…) keeps
 * the first answers and stops further retries; only an abort fails the request.
 */
async function retryEchoed(batch: string[], texts: string[], ctx: ProviderContext) {
  const result = [...texts];
  for (const [index, source] of batch.entries()) {
    const text = result[index];
    if (text === undefined || !fitsSingle(source)) continue;
    if (!isEchoedTranslation(source, text, ctx)) continue;
    let retried: string;
    try {
      retried = await single(source, ctx);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      break;
    }
    if (retried.trim() !== '' && !isEchoedTranslation(source, retried, ctx)) {
      result[index] = retried;
    }
  }
  return result;
}

/**
 * translate_a/t in plain mode sometimes drops a segment's inline tags when the
 * sentence is reordered, and the page then loses the links. Items whose tags did
 * not come back intact are sent once more, together, in HTML mode (see google-html).
 * A restored answer replaces the first one; a failed retry keeps the first answers;
 * only an abort fails the request.
 */
async function repairTags(batch: string[], texts: string[], ctx: ProviderContext) {
  const result = [...texts];
  const picks: { index: number; html: string }[] = [];
  let chars = 0;
  for (const [index, source] of batch.entries()) {
    const text = result[index];
    if (text === undefined || !hasTags(source) || tagsIntact(source, text)) continue;
    const html = toHtml(source);
    // One request only: items beyond the size limit keep their first answer.
    if (!html || chars + html.length > LIMITS.maxChars) continue;
    chars += html.length;
    picks.push({ index, html });
  }
  if (picks.length === 0) return result;
  const attempt = await primary(
    picks.map((pick) => pick.html),
    ctx,
    true,
  );
  if (!attempt.ok) {
    if (ctx.signal.aborted) throw attempt.error;
    return result;
  }
  for (const [position, { index }] of picks.entries()) {
    const source = batch[index];
    const reply = attempt.texts[position];
    if (source === undefined || reply === undefined) continue;
    const restored = fromHtml(reply, source);
    // An echo of the source would replace a translation that only lost its links.
    if (restored !== undefined && !isEchoedTranslation(source, restored, ctx)) {
      result[index] = restored;
    }
  }
  return result;
}

/** Term marks of the service (M4-C); a failed item comes back with them removed. */
const TERM_MARK = /<\/?g\d{1,3}>/g;

/**
 * A batch with glossary term marks goes straight to HTML mode (spans Google keeps), never to
 * the plain endpoint, retryEchoed, repairTags or /single, which would send the marks as text.
 * Requests are cut by HTML length. An item whose HTML alone is over the limit, whose reply
 * does not convert back, or whose request failed in a way plain mode falls back from (network,
 * 403, 404, 5xx, unreadable body) is answered with its source without marks: the service's term
 * check refuses it and asks again without the glossary, which may then use /single. Any other
 * failure (429, 400…) throws, so the scheduler retries and cools down as usual.
 */
async function* translateTerms(batch: string[], ctx: ProviderContext) {
  const texts = batch.map((source) => source.replace(TERM_MARK, ''));
  let group: { index: number; html: string }[] = [];
  let chars = 0;
  const send = async () => {
    if (group.length === 0) return;
    const picks = group;
    group = [];
    chars = 0;
    const attempt = await primary(
      picks.map((pick) => pick.html),
      ctx,
      true,
    );
    if (!attempt.ok) {
      if (!attempt.fallback || ctx.signal.aborted) throw attempt.error;
      return;
    }
    for (const [position, { index }] of picks.entries()) {
      const source = batch[index];
      const reply = attempt.texts[position];
      if (source === undefined || reply === undefined) continue;
      const restored = fromHtml(reply, source);
      if (restored !== undefined) texts[index] = restored;
    }
  };
  for (const [index, source] of batch.entries()) {
    const html = toHtml(source);
    if (html === undefined || html.length > LIMITS.maxChars) continue;
    if (chars + html.length > LIMITS.maxChars) await send();
    group.push({ index, html });
    chars += html.length;
  }
  await send();
  for (const [index, text] of texts.entries()) yield { type: 'item' as const, index, text };
}

async function* translate(batch: string[], ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
  if (ctx.terms) {
    yield* translateTerms(batch, ctx);
    return;
  }
  const attempt = await primary(batch, ctx);
  if (attempt.ok) {
    const texts = await repairTags(batch, await retryEchoed(batch, attempt.texts, ctx), ctx);
    for (const [index, text] of texts.entries()) yield { type: 'item', index, text };
    return;
  }
  if (!attempt.fallback) throw attempt.error;
  // An oversized GET would be answered with 429, so those items fail as-is.
  if (!batch.every(fitsSingle)) throw attempt.error;
  const texts: string[] = [];
  for (const text of batch) texts.push(await single(text, ctx));
  for (const [index, text] of texts.entries()) yield { type: 'item', index, text };
}

export function createGoogleAdapter(): ProviderAdapter {
  return { kind: 'mt', limits: LIMITS, translate };
}
