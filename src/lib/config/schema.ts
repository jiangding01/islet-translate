import { z } from 'zod';
import { LANGUAGE_CODES } from '@/lib/languages';
import {
  type ConfigV1,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_LIMITS,
  CUSTOM_STYLE_ID_PATTERN,
  CUSTOM_STYLE_LIMITS,
  type Engine,
  HOLD_KEYS,
  ISLE_DOCKS,
  isBuiltinEngine,
  isCustomStyleId,
  isEngineId,
  isTranslationStyleId,
  PAGE_MODES,
  PAGE_STYLES,
  THEMES,
  type TranslationStyleId,
} from './types';

const LIMITS = CUSTOM_PROVIDER_LIMITS;

const customProviderSchema = z.looseObject({
  name: z.string().max(LIMITS.name),
  baseURL: z.string().max(LIMITS.baseURL),
  model: z.string().max(LIMITS.model),
  // Only the length here: a stored value that is not a JSON object is ignored at request
  // time (an invalid field here would drop the whole provider); writes are checked in the
  // repository.
  extraBody: z.string().max(LIMITS.extraBody).optional(),
});

// No minimum length: a blank description (only a hand-edited store has one) is skipped at
// request time; writes are checked in the repository.
const customStyleSchema = z.looseObject({
  name: z.string().max(CUSTOM_STYLE_LIMITS.name),
  description: z.string().max(CUSTOM_STYLE_LIMITS.description),
});

// Background-only: the client never imports zod.
// Objects are loose so keys written by a newer build survive a downgrade.
export const configSchema = z
  .looseObject({
    ui: z.looseObject({
      theme: z.enum(THEMES),
    }),
    language: z.looseObject({
      target: z.enum(LANGUAGE_CODES),
      source: z.enum(['auto', ...LANGUAGE_CODES]),
    }),
    translation: z.looseObject({
      engine: z.custom<Engine>(isEngineId, { message: 'Unknown engine' }),
      style: z.custom<TranslationStyleId>(isTranslationStyleId, { message: 'Unknown style' }),
    }),
    page: z.looseObject({
      style: z.enum(PAGE_STYLES),
      mode: z.enum(PAGE_MODES),
      isleDock: z.enum(ISLE_DOCKS),
      holdKey: z.enum(HOLD_KEYS),
    }),
    selection: z.looseObject({
      showDot: z.boolean(),
    }),
    providers: z.looseObject({
      openai: z.looseObject({
        baseURL: z.string().max(LIMITS.baseURL),
        model: z.string().max(LIMITS.model),
        thinking: z.boolean(),
        extraBody: z.string().max(LIMITS.extraBody),
      }),
      deepseek: z.looseObject({
        model: z.string().max(LIMITS.model),
        thinking: z.boolean(),
      }),
      gemini: z.looseObject({ model: z.string().max(LIMITS.model), thinking: z.boolean() }),
    }),
    // The 10-entry limit is enforced when adding (repository), not here: a stored
    // record over the limit (a newer build) must not lose every entry on repair.
    customProviders: z.record(z.string().regex(CUSTOM_PROVIDER_ID_PATTERN), customProviderSchema),
    // Same as customProviders: the 10-entry limit is enforced when adding.
    customStyles: z.record(z.string().regex(CUSTOM_STYLE_ID_PATTERN), customStyleSchema),
  })
  // Runs only once the shape is valid: the default engine and the chosen style must exist.
  .superRefine((config, ctx) => {
    const { engine, style } = config.translation;
    if (!isBuiltinEngine(engine) && !Object.hasOwn(config.customProviders, engine)) {
      ctx.addIssue({
        code: 'custom',
        path: ['translation', 'engine'],
        message: 'Engine refers to a missing custom provider',
      });
    }
    if (isCustomStyleId(style) && !Object.hasOwn(config.customStyles, style)) {
      ctx.addIssue({
        code: 'custom',
        path: ['translation', 'style'],
        message: 'Style refers to a missing custom style',
      });
    }
  });

export type ConfigSchema = typeof configSchema;

// Compile-time only (type position, nothing emitted): the schema output must
// match ConfigV1. looseObject adds an index signature, so compare known keys only.
type StripIndex<T> = T extends object
  ? { [K in keyof T as string extends K ? never : K]: StripIndex<T[K]> }
  : T;
type SchemaOutput = StripIndex<z.output<typeof configSchema>>;
type Assert<T extends true> = T;
export type ConfigSchemaMatchesType = Assert<
  [SchemaOutput] extends [ConfigV1] ? ([ConfigV1] extends [SchemaOutput] ? true : false) : false
>;
