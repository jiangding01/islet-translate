import { describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@/lib/config/repository';
import { createGlossaryRepository, parseStoredGlossary } from './repository';
import {
  GLOSSARY_STORAGE_KEY,
  type GlossaryDraft,
  type GlossaryEntry,
  glossaryBase,
  type ImportEntry,
  isDuplicateEntry,
  isReadOnlyGlossary,
  MAX_GLOSSARY_ENTRIES,
  readGlossaryEntries,
} from './types';

function memoryStore(initial?: unknown) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set(GLOSSARY_STORAGE_KEY, structuredClone(initial));
  const store: KeyValueStore & { data: Map<string, unknown> } = {
    data,
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    }),
  };
  return store;
}

/** Sequential, distinct ids: term-00000001, term-00000002… */
function counterRandom() {
  let next = 0;
  return (bytes: Uint8Array<ArrayBuffer>) => {
    next += 1;
    const digits = String(next).padStart(8, '0');
    // Bytes 26–35 map to the digits 0–9 (ID_ALPHABET).
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = 26 + Number(digits[index] ?? 0);
    }
    return bytes;
  };
}

const draft = (source: string, fields: Partial<GlossaryDraft> = {}): GlossaryDraft => ({
  source,
  target: '',
  lang: '',
  caseSensitive: false,
  ...fields,
});

const stored = (store: ReturnType<typeof memoryStore>) =>
  store.data.get(GLOSSARY_STORAGE_KEY) as { version: number; entries: GlossaryEntry[] };

function setup(initial?: unknown) {
  const store = memoryStore(initial);
  const repo = createGlossaryRepository({ store, random: counterRandom() });
  return { store, repo };
}

describe('glossary repository: changes', () => {
  it('skips the random bytes that would make some id characters more likely', async () => {
    const store = memoryStore();
    // 252–255 would wrap onto a–d; the next batch fills the rest: 26 + k is digit k.
    const batches = [
      [252, 26, 253, 27, 254, 28, 255, 29],
      [30, 31, 32, 33, 34, 35, 26, 27],
    ];
    const random = (bytes: Uint8Array<ArrayBuffer>) => {
      bytes.set(batches.shift() ?? []);
      return bytes;
    };
    const repo = createGlossaryRepository({ store, random });
    const [entry] = await repo.change({ type: 'add', entry: draft('Sonnet') });
    expect(entry?.id).toBe('term-01234567');
  });

  it('adds, updates and removes entries, trimmed, in order', async () => {
    const { store, repo } = setup();
    const added = await repo.change({
      type: 'add',
      entry: draft('  pull request ', { target: ' 拉取请求 ', lang: 'zh-CN' }),
    });
    expect(added).toEqual([
      {
        id: 'term-00000001',
        source: 'pull request',
        target: '拉取请求',
        lang: 'zh-CN',
        caseSensitive: false,
      },
    ]);
    await repo.change({ type: 'add', entry: draft('Sonnet', { caseSensitive: true }) });
    expect(stored(store)).toEqual({ version: 1, entries: expect.any(Array) });
    expect(stored(store).entries.map((entry) => entry.source)).toEqual(['pull request', 'Sonnet']);

    // A keep-as-is entry applies to every language, whatever the page sent.
    const updated = await repo.change({
      type: 'update',
      id: 'term-00000001',
      entry: draft('pull request', { target: '  ', lang: 'ja' }),
    });
    expect(updated[0]).toMatchObject({ target: '', lang: '' });

    expect(await repo.change({ type: 'remove', id: 'term-00000001' })).toHaveLength(1);
    // Removing an entry that is gone is a no-op.
    expect(await repo.change({ type: 'remove', id: 'term-00000001' })).toHaveLength(1);
    expect((await repo.snapshot()).entries.map((entry) => entry.source)).toEqual(['Sonnet']);
  });

  it.each([
    ['an empty source', draft('   ')],
    ['an overlong source', draft('x'.repeat(201))],
    ['an overlong target', draft('x', { target: 'y'.repeat(201), lang: 'en' })],
    ['a target without a language', draft('x', { target: 'y', lang: '' })],
    ['an unknown language', draft('x', { target: 'y', lang: 'xx' as never })],
    ['a case flag that is not a boolean', draft('x', { caseSensitive: 'yes' as never })],
  ])('refuses %s', async (_name, entry) => {
    const { store, repo } = setup();
    await expect(repo.change({ type: 'add', entry })).rejects.toMatchObject({
      code: 'config/glossary-invalid',
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('accepts exactly 200 characters', async () => {
    const { repo } = setup();
    const entries = await repo.change({
      type: 'add',
      entry: draft('x'.repeat(200), { target: 'y'.repeat(200), lang: 'en' }),
    });
    expect(entries).toHaveLength(1);
  });

  it('refuses entry 501', async () => {
    const entries = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, index) => ({
      id: `term-${String(index).padStart(8, '0')}`,
      source: `word${index}`,
      target: '',
      lang: '',
      caseSensitive: false,
    }));
    const { repo } = setup({ version: 1, entries });
    await expect(repo.change({ type: 'add', entry: draft('one more') })).rejects.toMatchObject({
      code: 'config/glossary-limit',
    });
    // Editing still works at the limit.
    await expect(
      repo.change({
        type: 'update',
        id: 'term-00000000',
        entry: draft('word0', { caseSensitive: true }),
      }),
    ).resolves.toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it('refuses to update an entry that was removed', async () => {
    const { repo } = setup();
    await expect(
      repo.change({ type: 'update', id: 'term-zzzzzzzz', entry: draft('x') }),
    ).rejects.toMatchObject({ code: 'config/glossary-missing' });
  });

  it('refuses duplicates by source, case rule and language overlap', async () => {
    const { repo } = setup();
    await repo.change({ type: 'add', entry: draft('Sonnet', { caseSensitive: true }) });
    await repo.change({ type: 'add', entry: draft('PR', { target: '拉取请求', lang: 'zh-CN' }) });
    const duplicate = { code: 'config/glossary-duplicate' };
    // Both case-sensitive with another case: allowed.
    await expect(
      repo.change({ type: 'add', entry: draft('sonnet', { caseSensitive: true }) }),
    ).resolves.toHaveLength(3);
    // One of them ignores case: the same source.
    await expect(repo.change({ type: 'add', entry: draft('SONNET') })).rejects.toMatchObject(
      duplicate,
    );
    // A keep-as-is entry overlaps every language.
    await expect(repo.change({ type: 'add', entry: draft('pr') })).rejects.toMatchObject(duplicate);
    await expect(
      repo.change({ type: 'add', entry: draft('PR', { target: '拉取請求', lang: 'zh-TW' }) }),
    ).resolves.toHaveLength(4);
    await expect(
      repo.change({ type: 'add', entry: draft('pr', { target: '合并请求', lang: 'zh-CN' }) }),
    ).rejects.toMatchObject(duplicate);
    // An entry is no duplicate of itself.
    await expect(
      repo.change({
        type: 'update',
        id: 'term-00000001',
        entry: draft('Sonnet', { caseSensitive: true }),
      }),
    ).resolves.toHaveLength(4);
  });

  it('runs concurrent writes one after the other', async () => {
    const { store, repo } = setup();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((source) => repo.change({ type: 'add', entry: draft(source) })),
    );
    expect(results.map((entries) => entries.length)).toEqual([1, 2, 3, 4]);
    expect(stored(store).entries.map((entry) => entry.source)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports a failed write and keeps the snapshot', async () => {
    const { store, repo } = setup();
    vi.mocked(store.set).mockRejectedValueOnce(new Error('quota'));
    await expect(repo.change({ type: 'add', entry: draft('a') })).rejects.toMatchObject({
      code: 'config/glossary-write-failed',
    });
    expect((await repo.snapshot()).entries).toEqual([]);
  });
});

describe('glossary repository: import (M4-D)', () => {
  const kept = {
    id: 'term-aaaaaaaa',
    source: 'pull request',
    target: '拉取请求',
    lang: 'zh-CN',
    caseSensitive: false,
    note: 'from a newer build',
  } as GlossaryEntry;
  const other: GlossaryEntry = {
    id: 'term-bbbbbbbb',
    source: 'GitHub',
    target: '',
    lang: '',
    caseSensitive: false,
  };
  const fields = ({ id, source, target, lang, caseSensitive }: GlossaryEntry): ImportEntry => ({
    id,
    source,
    target,
    lang,
    caseSensitive,
  });

  function setupImport(entries: GlossaryEntry[] = [kept, other]) {
    const context = setup({ version: 1, entries });
    return { ...context, base: glossaryBase(entries) };
  }

  it('writes the whole list at once: updates in place keep id and unknown fields', async () => {
    const { store, repo, base } = setupImport();
    const entries: ImportEntry[] = [
      { ...fields(kept), target: '合并请求' },
      fields(other),
      draft('token', { target: '词元', lang: 'zh-CN' }),
      draft('Claude'),
    ];
    const written = await repo.change({ type: 'import', base, entries });
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(written.map((entry) => [entry.id, entry.source, entry.target])).toEqual([
      ['term-aaaaaaaa', 'pull request', '合并请求'],
      ['term-bbbbbbbb', 'GitHub', ''],
      ['term-00000001', 'token', '词元'],
      ['term-00000002', 'Claude', ''],
    ]);
    expect(stored(store).entries[0]).toMatchObject({ note: 'from a newer build' });
    expect((await repo.snapshot()).entries).toEqual(written);
  });

  it('never gives a new entry an id already taken', async () => {
    const store = memoryStore({
      version: 1,
      entries: [{ ...other, id: 'term-00000001' }],
    });
    const repo = createGlossaryRepository({ store, random: counterRandom() });
    const written = await repo.change({
      type: 'import',
      base: glossaryBase([{ ...other, id: 'term-00000001' }]),
      entries: [fields({ ...other, id: 'term-00000001' }), draft('a'), draft('b')],
    });
    expect(written.map((entry) => entry.id)).toEqual([
      'term-00000001',
      'term-00000002',
      'term-00000003',
    ]);
  });

  it.each([
    ['removed', [other]],
    ['edited', [{ ...kept, target: '别的译法' }, other]],
    ['added to', [kept, other, { ...other, id: 'term-cccccccc', source: 'new' }]],
    ['reordered', [other, kept]],
  ])('refuses as stale when the glossary was %s elsewhere, writing nothing', async (_name, now) => {
    const { store, repo, base } = setupImport();
    store.data.set(GLOSSARY_STORAGE_KEY, { version: 1, entries: now });
    vi.mocked(store.set).mockClear();
    await expect(
      repo.change({ type: 'import', base, entries: [fields(kept), fields(other), draft('x')] }),
    ).rejects.toMatchObject({ code: 'config/glossary-stale' });
    expect(store.set).not.toHaveBeenCalled();
    expect(stored(store).entries).toEqual(now);
  });

  it.each([
    ['an id that does not exist', [{ ...draft('x'), id: 'term-zzzzzzzz' }], 'invalid'],
    ['an id given twice', [fields(kept), { ...fields(kept), source: 'again' }], 'invalid'],
    ['a stored entry left out', [fields(kept), draft('x')], 'invalid'],
    ['a duplicate entry', [fields(kept), draft('Pull Request')], 'duplicate'],
    ['an invalid field', [draft('x', { target: 'y', lang: 'xx' as never })], 'invalid'],
    ['an empty source', [draft('  ')], 'invalid'],
    ['entries that are not an array', 'nope', 'invalid'],
    [
      'more than 500 entries',
      Array.from({ length: MAX_GLOSSARY_ENTRIES + 1 }, (_, index) => draft(`w${index}`)),
      'limit',
    ],
  ])('refuses %s, writing nothing', async (_name, entries, code) => {
    const { store, repo, base } = setupImport();
    vi.mocked(store.set).mockClear();
    await expect(
      repo.change({ type: 'import', base, entries: entries as ImportEntry[] }),
    ).rejects.toMatchObject({ code: `config/glossary-${code}` });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('accepts exactly 500 entries', async () => {
    const { repo } = setupImport([]);
    const entries = Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, index) => draft(`w${index}`));
    await expect(
      repo.change({ type: 'import', base: glossaryBase([]), entries }),
    ).resolves.toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it('never imports into a glossary from a newer version', async () => {
    const { store, repo } = setup({ version: 2, entries: [other] });
    await expect(
      repo.change({ type: 'import', base: glossaryBase([other]), entries: [draft('x')] }),
    ).rejects.toMatchObject({ code: 'config/glossary-newer-version' });
    expect(store.set).not.toHaveBeenCalled();
    expect(isReadOnlyGlossary({ version: 2, entries: [] })).toBe(true);
    expect(isReadOnlyGlossary({ version: 1, entries: [] })).toBe(false);
    expect(isReadOnlyGlossary(undefined)).toBe(false);
  });

  it('computes the base from the id and four fields, in order', () => {
    expect(glossaryBase([other])).toBe('[["term-bbbbbbbb","GitHub","","",false]]');
    // Unknown fields never change it.
    expect(glossaryBase([kept])).toBe(glossaryBase([{ ...kept, note: 'other' } as GlossaryEntry]));
  });
});

describe('glossary repository: stored data', () => {
  const good = {
    id: 'term-aaaaaaaa',
    source: 'Sonnet',
    target: '',
    lang: '',
    caseSensitive: true,
    note: 'from a newer build',
  };

  it('drops malformed entries one by one and keeps unknown fields', async () => {
    const { store, repo } = setup({
      version: 1,
      extra: { kept: true },
      entries: [
        good,
        { ...good, id: 'term-aaaaaaaa', source: 'duplicate id' },
        { ...good, id: 'bad' },
        { ...good, id: 'term-bbbbbbbb', source: '' },
        { ...good, id: 'term-cccccccc', target: 'x', lang: '' },
        { ...good, id: 'term-dddddddd', caseSensitive: 'no' },
        'text',
      ],
    });
    expect((await repo.snapshot()).entries).toEqual([good]);
    await repo.change({ type: 'add', entry: draft('Haiku') });
    const value = store.data.get(GLOSSARY_STORAGE_KEY) as Record<string, unknown>;
    expect(value.extra).toEqual({ kept: true });
    expect((value.entries as GlossaryEntry[])[0]).toEqual(good);
    // An edit keeps the fields it does not know.
    await repo.change({ type: 'update', id: 'term-aaaaaaaa', entry: draft('Sonnet 4') });
    expect(stored(store).entries[0]).toMatchObject({
      source: 'Sonnet 4',
      note: 'from a newer build',
    });
  });

  it('reads a value that is not an object, or has no usable entries, as empty', () => {
    for (const raw of [undefined, null, 'x', [], { version: 1 }, { version: 1, entries: {} }]) {
      expect(parseStoredGlossary(raw).snapshot.entries).toEqual([]);
    }
  });

  it('matches with a newer version but never writes over it', async () => {
    const { store, repo } = setup({ version: 2, entries: [good] });
    const snapshot = await repo.snapshot();
    expect(snapshot).toMatchObject({ readOnly: true, entries: [good] });
    await expect(repo.change({ type: 'add', entry: draft('x') })).rejects.toMatchObject({
      code: 'config/glossary-newer-version',
    });
    await expect(repo.change({ type: 'remove', id: good.id })).rejects.toMatchObject({
      code: 'config/glossary-newer-version',
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    ['entries that are not an array', { version: 2, entries: {} }],
    ['no entries at all', { version: 2 }],
    ['a version that is not a number', { version: '2', entries: [] }],
    ['no version', { entries: [] }],
  ])('is read-only for a stored object with %s', async (_name, raw) => {
    const { store, repo } = setup(raw);
    expect(await repo.snapshot()).toMatchObject({ readOnly: true, entries: [] });
    await expect(repo.change({ type: 'add', entry: draft('x') })).rejects.toMatchObject({
      code: 'config/glossary-newer-version',
    });
    expect(store.set).not.toHaveBeenCalled();
    expect(store.data.get(GLOSSARY_STORAGE_KEY)).toEqual(raw);
  });

  it('keeps one snapshot object until a write or a change event replaces it', async () => {
    const { store, repo } = setup({ version: 1, entries: [good] });
    const first = await repo.snapshot();
    expect(await repo.snapshot()).toBe(first);
    expect(store.get).toHaveBeenCalledTimes(1);

    repo.replace({ version: 1, entries: [{ ...good, source: 'Opus' }] });
    const replaced = await repo.snapshot();
    expect(replaced).not.toBe(first);
    expect(replaced.entries.map((entry) => entry.source)).toEqual(['Opus']);
    expect(store.get).toHaveBeenCalledTimes(1);

    await repo.change({ type: 'add', entry: draft('Haiku') });
    const written = await repo.snapshot();
    expect(written).not.toBe(replaced);
    expect(written.entries.map((entry) => entry.source)).toEqual(['Sonnet', 'Haiku']);

    repo.replace(undefined);
    expect((await repo.snapshot()).entries).toEqual([]);
  });

  it('translates on without a glossary when storage cannot be read', async () => {
    const { store, repo } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(store.get).mockRejectedValueOnce(new Error('broken'));
    expect((await repo.snapshot()).entries).toEqual([]);
    // Read again on the next request.
    expect((await repo.snapshot()).entries).toEqual([]);
    expect(store.get).toHaveBeenCalledTimes(2);
  });
});

describe('glossary types', () => {
  it('reads entries for the settings page, skipping malformed ones', () => {
    const entry = {
      id: 'term-aaaaaaaa',
      source: 'a',
      target: 'b',
      lang: 'en',
      caseSensitive: false,
    };
    expect(
      readGlossaryEntries({ version: 1, entries: [entry, { ...entry }, null, { id: 1 }] }),
    ).toEqual([entry]);
    expect(readGlossaryEntries(undefined)).toEqual([]);
  });

  it('compares sources by the case rule and language overlap', () => {
    expect(isDuplicateEntry(draft('A'), draft('a', { caseSensitive: true }))).toBe(true);
    expect(
      isDuplicateEntry(draft('A', { caseSensitive: true }), draft('a', { caseSensitive: true })),
    ).toBe(false);
    expect(
      isDuplicateEntry(
        draft('a', { target: 'x', lang: 'ja' }),
        draft('a', { target: 'y', lang: 'ko' }),
      ),
    ).toBe(false);
  });
});
