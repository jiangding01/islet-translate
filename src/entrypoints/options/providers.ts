import { i18n } from '#i18n';
import type { BuiltinEngine, CustomProviderId, CustomStyleId } from '@/lib/config/types';
import { normalizeBaseURL } from '@/lib/endpoint';
import { hostName, type NotReady } from '@/lib/engine-view';

// Settings-page-only data: kept out of the shared engine view so the toolbar
// panel does not carry it. Copy is held as keys and looked up at use (docs/plans/i18n.md 4.2).

type KeyLinkLabel = 'options.engine.getKey' | 'options.engine.getKeyAndModels';

/** Where to get a key (and, for Gemini, the model list). */
export const KEY_LINKS: Partial<Record<BuiltinEngine, { href: string; label: KeyLinkLabel }>> = {
  openai: { href: 'https://platform.openai.com/api-keys', label: 'options.engine.getKey' },
  deepseek: { href: 'https://platform.deepseek.com/api_keys', label: 'options.engine.getKey' },
  gemini: {
    href: 'https://ai.google.dev/gemini-api/docs/models',
    label: 'options.engine.getKeyAndModels',
  },
};

type PresetLabel =
  | 'options.add.presetOllama'
  | 'options.add.presetLmstudio'
  | 'options.add.presetOpenrouter'
  | 'options.add.presetSiliconflow'
  | 'options.add.presetOther';

export interface Preset {
  id: string;
  /** Copy key of the preset's name. */
  label: PresetLabel;
  baseURL: string;
  /** Local servers usually take no key. */
  local: boolean;
}

/** Base URLs checked against each vendor's docs (2026-11-14). */
export const PRESETS: readonly Preset[] = [
  {
    id: 'ollama',
    label: 'options.add.presetOllama',
    baseURL: 'http://localhost:11434/v1',
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'options.add.presetLmstudio',
    baseURL: 'http://localhost:1234/v1',
    local: true,
  },
  {
    id: 'openrouter',
    label: 'options.add.presetOpenrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    local: false,
  },
  {
    id: 'siliconflow',
    label: 'options.add.presetSiliconflow',
    baseURL: 'https://api.siliconflow.cn/v1',
    local: false,
  },
  { id: 'other', label: 'options.add.presetOther', baseURL: '', local: false },
];

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
const randomBytes: RandomBytes = (bytes) => crypto.getRandomValues(bytes);

/** `prefix-` + 8 random lowercase letters or digits, unique among `existing`. */
function newId<P extends string>(
  prefix: P,
  existing: Iterable<string>,
  random: RandomBytes,
): `${P}-${string}` {
  const taken = new Set(existing);
  // Bytes from `limit` up would wrap onto the first letters: skip them, so every
  // character is equally likely.
  const limit = 256 - (256 % ID_ALPHABET.length);
  for (;;) {
    let suffix = '';
    while (suffix.length < 8) {
      for (const byte of random(new Uint8Array(8))) {
        if (byte < limit && suffix.length < 8) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
      }
    }
    const id: `${P}-${string}` = `${prefix}-${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** `custom-` + 8 random lowercase letters or digits, unique among `existing`. */
export function newCustomId(
  existing: Iterable<string>,
  random: RandomBytes = randomBytes,
): CustomProviderId {
  return newId('custom', existing, random);
}

/** `style-` + 8 random lowercase letters or digits (as newCustomId), unique among `existing`. */
export function newStyleId(
  existing: Iterable<string>,
  random: RandomBytes = randomBytes,
): CustomStyleId {
  return newId('style', existing, random);
}

/** A preset keeps its label while its address is untouched; otherwise the host names it. */
export function defaultProviderName(preset: Preset | undefined, baseURL: string): string {
  if (preset && preset.id !== 'other' && normalizeBaseURL(baseURL) === preset.baseURL) {
    return i18n.t(preset.label);
  }
  return hostName(baseURL);
}

/** Why the connection test is disabled. */
export const TEST_BLOCKED_TEXT = {
  'bad-url': 'options.test.blocked.badUrl',
  'checking-grant': 'options.test.blocked.checkingGrant',
  'needs-grant': 'options.test.blocked.needsGrant',
  'needs-key': 'options.test.blocked.needsKey',
  'needs-model': 'options.test.blocked.needsModel',
} as const satisfies Record<NotReady, string>;
