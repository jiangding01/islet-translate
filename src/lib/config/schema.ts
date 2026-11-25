import { z } from 'zod';
import { LANGUAGE_CODES } from '@/lib/languages';
import {
  type ConfigV1,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_LIMITS,
  type Engine,
  HOLD_KEYS,
  ISLE_DOCKS,
  isBuiltinEngine,
  isEngineId,
  PAGE_MODES,
  PAGE_STYLES,
  THEMES,
} from './types';

const LIMITS = CUSTOM_PROVIDER_LIMITS;

const customProviderSchema = z.looseObject({
  name: z.string().max(LIMITS.name),
  baseURL: z.string().max(LIMITS.baseURL),
  model: z.string().max(LIMITS.model),
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
      }),
      deepseek: z.looseObject({
        model: z.string().max(LIMITS.model),
        thinking: z.boolean(),
      }),
      gemini: z.looseObject({ model: z.string().max(LIMITS.model) }),
    }),
    // The 10-entry limit is enforced when adding (repository), not here: a stored
    // record over the limit (a newer build) must not lose every entry on repair.
    customProviders: z.record(z.string().regex(CUSTOM_PROVIDER_ID_PATTERN), customProviderSchema),
  })
  // Runs only once the shape is valid: the default engine must exist.
  .superRefine((config, ctx) => {
    const { engine } = config.translation;
    if (!isBuiltinEngine(engine) && !Object.hasOwn(config.customProviders, engine)) {
      ctx.addIssue({
        code: 'custom',
        path: ['translation', 'engine'],
        message: 'Engine refers to a missing custom provider',
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
