import { isPlainObject } from '@/lib/config/merge';
import { describe, type KeyValueStore } from '@/lib/config/repository';
import { type AppError, appError } from '@/lib/errors';
import {
  GLOSSARY_STORAGE_KEY,
  GLOSSARY_VERSION,
  type GlossaryChange,
  type GlossaryDraft,
  type GlossaryEntry,
  isDuplicateEntry,
  isGlossaryEntry,
  MAX_GLOSSARY_ENTRIES,
  readGlossaryEntries,
} from './types';

// Background-only: the single writer of `storage.local.glossary`.
//
// Parsed by hand (types.ts, readGlossaryEntries), not with zod: the zod schema cost about
// 1.2 KB of the background budget. Entries are kept as stored objects, so fields a newer build
// adds survive, as a zod looseObject would keep them.

/** What the translation path reads: the same object until the glossary changes. */
export interface GlossarySnapshot {
  readonly entries: readonly GlossaryEntry[];
  /** Written by a newer build: kept for matching, never written over. */
  readonly readOnly: boolean;
}

export interface GlossaryRepository {
  /** The in-memory snapshot, read from storage on first use. Never rejects. */
  snapshot(): Promise<GlossarySnapshot>;
  /** Applies one change and returns the entries as stored. Rejects with an AppError. */
  change(change: GlossaryChange): Promise<GlossaryEntry[]>;
  /** Replaces the snapshot with a stored value seen through `storage.onChanged`. */
  replace(raw: unknown): void;
}

export interface GlossaryRepositoryDeps {
  store: KeyValueStore;
  /** Random bytes for new ids (tests pin them). */
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

interface Parsed {
  snapshot: GlossarySnapshot;
  /** The stored top-level object, unknown keys included. */
  stored: Record<string, unknown>;
}

const EMPTY: GlossarySnapshot = Object.freeze({ entries: Object.freeze([]), readOnly: false });

/**
 * Lenient: a malformed entry is dropped on its own. A stored object whose version is not one
 * this build knows (newer, missing or not a number) is read-only, whatever its entries look
 * like, so a rolled-back build never writes over it; anything else reads as an empty glossary.
 */
export function parseStoredGlossary(raw: unknown): Parsed {
  if (!isPlainObject(raw)) return { snapshot: EMPTY, stored: {} };
  const readOnly = !(typeof raw.version === 'number' && raw.version <= GLOSSARY_VERSION);
  return { snapshot: { entries: readGlossaryEntries(raw), readOnly }, stored: raw };
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function invalid(): AppError {
  return appError('config', 'config/glossary-invalid', 'Invalid entry');
}

/** The draft trimmed and checked like a stored entry; a keep-as-is entry has no language. */
function cleanDraft(draft: unknown): GlossaryDraft {
  const given = isPlainObject(draft) ? draft : {};
  const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
  const target = trim(given.target);
  const entry = {
    id: 'term-00000000',
    source: trim(given.source),
    target,
    lang: target === '' ? '' : given.lang,
    caseSensitive: given.caseSensitive ?? false,
  };
  if (!isGlossaryEntry(entry)) throw invalid();
  return {
    source: entry.source,
    target: entry.target,
    lang: entry.lang,
    caseSensitive: entry.caseSensitive,
  };
}

function checkDuplicate(entries: readonly GlossaryEntry[], draft: GlossaryDraft, self?: string) {
  if (entries.some((entry) => entry.id !== self && isDuplicateEntry(entry, draft))) {
    throw appError('config', 'config/glossary-duplicate', 'Duplicate');
  }
}

/**
 * Every write runs on one promise chain (as the config repository), reads storage afresh and
 * replaces the snapshot once stored. `storage.onChanged` replaces it too (`replace`), so the
 * translation path never pairs new entries with a matcher built for old ones.
 */
export function createGlossaryRepository(deps: GlossaryRepositoryDeps): GlossaryRepository {
  const { store } = deps;
  const random = deps.random ?? ((bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes));
  let queue: Promise<unknown> = Promise.resolve();
  let current: GlossarySnapshot | undefined;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(): Promise<Parsed> {
    try {
      return parseStoredGlossary(await store.get(GLOSSARY_STORAGE_KEY));
    } catch (error) {
      throw appError('config', 'config/read-failed', describe(error), { retryable: true });
    }
  }

  /**
   * `term-` and 8 random letters or digits, unique. Bytes from 252 up would wrap onto the first
   * characters: they are skipped, so every character is equally likely (as in options/providers).
   */
  function newId(taken: ReadonlySet<string>): string {
    for (;;) {
      let id = 'term-';
      while (id.length < 13) {
        for (const byte of random(new Uint8Array(8))) {
          if (byte < 252 && id.length < 13) id += ID_ALPHABET[byte % 36];
        }
      }
      if (!taken.has(id)) return id;
    }
  }

  function apply(entries: readonly GlossaryEntry[], change: GlossaryChange): GlossaryEntry[] {
    if (typeof change !== 'object' || change === null) throw invalid();
    if (change.type === 'remove') return entries.filter((entry) => entry.id !== change.id);
    if (change.type === 'add') {
      if (entries.length >= MAX_GLOSSARY_ENTRIES) {
        throw appError('config', 'config/glossary-limit', 'Too many entries');
      }
      const draft = cleanDraft(change.entry);
      checkDuplicate(entries, draft);
      return [...entries, { id: newId(new Set(entries.map((entry) => entry.id))), ...draft }];
    }
    if (change.type === 'update') {
      const index = entries.findIndex((entry) => entry.id === change.id);
      const existing = entries[index];
      // Updating an entry another page just removed must not bring it back.
      if (!existing) throw appError('config', 'config/glossary-missing', 'Not found');
      const draft = cleanDraft(change.entry);
      checkDuplicate(entries, draft, existing.id);
      const next = [...entries];
      // Unknown fields of the stored entry (a newer build's) survive the edit.
      next[index] = { ...existing, ...draft };
      return next;
    }
    throw invalid();
  }

  return {
    snapshot: async () => {
      if (current) return current;
      try {
        const parsed = await enqueue(read);
        current ??= parsed.snapshot;
        return current;
      } catch {
        // Translation goes on without a glossary; the next request reads again.
        return EMPTY;
      }
    },

    change: (change) =>
      enqueue(async () => {
        const { snapshot, stored } = await read();
        if (snapshot.readOnly) {
          throw appError('config', 'config/glossary-newer-version', 'Newer version');
        }
        const entries = apply(snapshot.entries, change);
        try {
          await store.set(GLOSSARY_STORAGE_KEY, {
            ...stored,
            version: GLOSSARY_VERSION,
            entries,
          });
        } catch (error) {
          throw appError('config', 'config/glossary-write-failed', describe(error), {
            retryable: true,
          });
        }
        current = { entries, readOnly: false };
        return entries;
      }),

    replace: (raw) => {
      current = parseStoredGlossary(raw).snapshot;
    },
  };
}
