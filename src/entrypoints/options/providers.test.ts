import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { i18n } from '#i18n';
import { CUSTOM_STYLE_ID_PATTERN } from '@/lib/config/types';
import { createGetMessage, loadLocales } from '../../../scripts/i18n-messages.mjs';
import {
  defaultProviderName,
  KEY_LINKS,
  newCustomId,
  newStyleId,
  PRESETS,
  TEST_BLOCKED_TEXT,
} from './providers';

/** Switches the getMessage stub to the en copy (vitest.setup puts zh_CN back before each test). */
async function useEnglish() {
  const getMessage = createGetMessage(await loadLocales(), 'en');
  fakeBrowser.i18n.getMessage = getMessage as typeof fakeBrowser.i18n.getMessage;
}

describe('newStyleId', () => {
  it('makes a valid custom style id the same way, and skips taken ones', () => {
    const fixed = (value: number) => (bytes: Uint8Array<ArrayBuffer>) => bytes.fill(value);
    expect(newStyleId([], fixed(0))).toBe('style-aaaaaaaa');
    let calls = 0;
    const random = (bytes: Uint8Array<ArrayBuffer>) => bytes.fill(calls++ === 0 ? 0 : 1);
    expect(newStyleId(['style-aaaaaaaa'], random)).toBe('style-bbbbbbbb');
    expect(newStyleId([])).toMatch(CUSTOM_STYLE_ID_PATTERN);
  });
});

describe('newCustomId', () => {
  it('makes a valid id and skips taken ones', () => {
    const fixed = (value: number) => (bytes: Uint8Array<ArrayBuffer>) => bytes.fill(value);
    expect(newCustomId([], fixed(0))).toBe('custom-aaaaaaaa');
    let calls = 0;
    const random = (bytes: Uint8Array<ArrayBuffer>) => bytes.fill(calls++ === 0 ? 0 : 1);
    expect(newCustomId(['custom-aaaaaaaa'], random)).toBe('custom-bbbbbbbb');
    expect(newCustomId([])).toMatch(/^custom-[a-z0-9]{8}$/);
  });

  it('draws every character uniformly: bytes past the last whole round of 36 are skipped', () => {
    // 252 = 7 × 36. Mapping 252–255 with `% 36` would favor a–d.
    const bytes = [255, 252, 0, 253, 35, 1, 254, 2, 3, 4, 5, 6];
    let next = 0;
    const random = (buffer: Uint8Array<ArrayBuffer>) => {
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = bytes[next++ % bytes.length] ?? 0;
      return buffer;
    };
    expect(newCustomId([], random)).toBe('custom-a9bcdefg');
  });
});

describe('names and hosts', () => {
  it('keeps the preset label only while its address is untouched', () => {
    const ollama = PRESETS.find((preset) => preset.id === 'ollama');
    expect(defaultProviderName(ollama, 'http://localhost:11434/v1/')).toBe('Ollama（本地）');
    expect(defaultProviderName(ollama, 'http://localhost:9999/v1')).toBe('localhost:9999');
  });
});

describe('copy in the UI language', () => {
  const ollama = PRESETS.find((preset) => preset.id === 'ollama');

  it('names presets and explains a blocked test in zh and en', async () => {
    expect(
      i18n.t(
        PRESETS.find((preset) => preset.id === 'siliconflow')?.label ?? 'options.add.presetOther',
      ),
    ).toBe('硅基流动');
    expect(i18n.t(TEST_BLOCKED_TEXT['needs-key'])).toBe('填写 API Key 后可以测试');
    expect(i18n.t(KEY_LINKS.gemini?.label ?? 'options.engine.getKey')).toBe('密钥与模型列表 ↗');
    await useEnglish();
    expect(defaultProviderName(ollama, 'http://localhost:11434/v1')).toBe('Ollama (local)');
    expect(defaultProviderName(ollama, 'http://localhost:9999/v1')).toBe('localhost:9999');
    expect(
      i18n.t(
        PRESETS.find((preset) => preset.id === 'siliconflow')?.label ?? 'options.add.presetOther',
      ),
    ).toBe('SiliconFlow');
    expect(
      i18n.t(PRESETS.find((preset) => preset.id === 'other')?.label ?? 'options.add.presetOther'),
    ).toBe('Other');
    expect(i18n.t(TEST_BLOCKED_TEXT['needs-key'])).toBe('Enter an API key to test');
    expect(i18n.t(TEST_BLOCKED_TEXT['checking-grant'])).toBe('Checking access…');
    expect(i18n.t(KEY_LINKS.openai?.label ?? 'options.engine.getKeyAndModels')).toBe(
      'Get an API key ↗',
    );
  });
});
