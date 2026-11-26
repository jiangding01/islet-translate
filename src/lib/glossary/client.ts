import { browser } from 'wxt/browser';
import type { Result } from '@/lib/errors';
import { call } from '@/lib/messaging/handle';
import { sendMessage } from '@/lib/messaging/protocol';
import {
  GLOSSARY_STORAGE_KEY,
  type GlossaryChange,
  type GlossaryEntry,
  isReadOnlyGlossary,
  readGlossaryEntries,
} from './types';

// Glossary access for the settings page: reads storage directly (malformed entries skipped),
// writes through the background, the only writer.

export interface GlossaryState {
  entries: GlossaryEntry[];
  /** Written by a newer build: the background refuses every change (M4-D disables import). */
  readOnly: boolean;
}

function toState(raw: unknown): GlossaryState {
  return { entries: readGlossaryEntries(raw), readOnly: isReadOnlyGlossary(raw) };
}

export async function readGlossary(): Promise<GlossaryState> {
  const stored = await browser.storage.local.get(GLOSSARY_STORAGE_KEY);
  return toState(stored[GLOSSARY_STORAGE_KEY]);
}

/** Calls `callback` whenever the stored glossary changes; returns the unsubscribe function. */
export function watchGlossary(callback: (state: GlossaryState) => void): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown } | undefined>,
    area: string,
  ): void => {
    if (area !== 'local' || !Object.hasOwn(changes, GLOSSARY_STORAGE_KEY)) return;
    callback(toState(changes[GLOSSARY_STORAGE_KEY]?.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export function changeGlossary(change: GlossaryChange): Promise<Result<GlossaryEntry[]>> {
  return call(() => sendMessage('glossary.change', change));
}
