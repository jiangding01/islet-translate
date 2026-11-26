import { normalizeBaseURL } from '@/lib/endpoint';
import { DEFAULT_OPENAI_BASE_URL } from './defaults';
import type { Engine } from './types';

// What "thinking off" sends to each known model (M4-A, docs/plans/m4a-thinking-extra.md).
// Pure and zod-free: the background builds requests from it, the settings page decides
// whether to show the switch and how to explain it. Only levels the official docs state are
// listed (checked 2026-11-26); a model that is not listed gets nothing, which is always safe.
// Check the table against the docs before every release.

/** `off`: the model can stop thinking; `minimum`: it can only go down to its lowest level. */
export type ThinkingKind = 'off' | 'minimum';

export interface ThinkingRule {
  kind: ThinkingKind;
  /** Request body fields sent while the switch is off (the default). */
  body: Record<string, unknown>;
}

type Group<T> = readonly [kind: ThinkingKind, value: T, models: readonly string[]];

/** Chat Completions `reasoning_effort`. */
const OPENAI: readonly Group<string>[] = [
  ['off', 'none', ['gpt-5.1', 'gpt-5.2', 'gpt-5.5', 'gpt-6-luna', 'gpt-6.1-terra']],
  ['minimum', 'minimal', ['gpt-5', 'gpt-5-mini', 'gpt-5-nano']],
  // Officially no `none` (a 400).
  ['minimum', 'low', ['gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol']],
];

/** `generationConfig.thinkingConfig`: 2.5 takes a budget, 3 and later a level (never both). */
const GEMINI: readonly Group<Record<string, unknown>>[] = [
  ['off', { thinkingBudget: 0 }, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']],
  ['minimum', { thinkingBudget: 128 }, ['gemini-2.5-pro']],
  [
    'minimum',
    { thinkingLevel: 'MINIMAL' },
    [
      'gemini-3-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
    ],
  ],
  [
    'minimum',
    { thinkingLevel: 'LOW' },
    [
      'gemini-3-pro-preview',
      'gemini-3.1-pro',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-4-hydrogen',
      'gemini-4-carbon',
      'gemini-4-neon',
      'gemini-4-argon',
    ],
  ],
];

/**
 * What may follow a listed id: a date, `-preview` (with a month-year or month-day), or a
 * numbered version. Anything else (`-mini`, `-image`, `-tts`, `-latest`) is another model.
 */
const SNAPSHOT = /^(?:-\d{4}-\d{2}-\d{2}|-preview(?:-\d{2}-(?:\d{4}|\d{2}))?|-00\d)?$/;

function find<T>(groups: readonly Group<T>[], model: string): [ThinkingKind, T] | undefined {
  const id = model.trim().replace(/^models\//, '');
  for (const [kind, value, models] of groups) {
    if (models.some((name) => id.startsWith(name) && SNAPSHOT.test(id.slice(name.length)))) {
      return [kind, value];
    }
  }
  return undefined;
}

/** The official endpoint, however written: host case and the default port do not matter. */
function isOfficialOpenAI(baseURL: string): boolean {
  try {
    return new URL(normalizeBaseURL(baseURL)).href === DEFAULT_OPENAI_BASE_URL;
  } catch {
    return false;
  }
}

/**
 * The thinking rule of an engine and model; undefined when nothing is sent. DeepSeek has one
 * rule for every model (#88). OpenAI's address can be changed, and a proxy may serve other
 * models under the same names, so only the official endpoint gets the fields.
 */
export function thinkingRule(
  engine: Engine,
  model: string,
  baseURL: string,
): ThinkingRule | undefined {
  if (engine === 'deepseek') return { kind: 'off', body: { thinking: { type: 'disabled' } } };
  if (engine === 'openai') {
    if (!isOfficialOpenAI(baseURL)) return undefined;
    const found = find(OPENAI, model);
    return found && { kind: found[0], body: { reasoning_effort: found[1] } };
  }
  if (engine === 'gemini') {
    const found = find(GEMINI, model);
    return (
      found && {
        kind: found[0],
        body: { generationConfig: { thinkingConfig: { ...found[1] } } },
      }
    );
  }
  return undefined;
}
