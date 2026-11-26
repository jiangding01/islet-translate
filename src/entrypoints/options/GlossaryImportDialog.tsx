import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { i18n } from '#i18n';
import { Select, type SelectOption } from '@/components/Select';
import { describeError } from '@/lib/error-messages';
import { changeGlossary, readGlossary } from '@/lib/glossary/client';
import {
  type Blocker,
  blockedImport,
  type ImportNote,
  type ImportPreview,
  type InvalidReason,
  LEGACY_ENCODINGS,
  type LegacyEncoding,
  MAX_IMPORT_BYTES,
  type PreviewRow,
  type RowStatus,
  readImport,
} from '@/lib/glossary/transfer';
import { type GlossaryEntry, glossaryBase } from '@/lib/glossary/types';
import {
  browserUiLanguage,
  isLanguageCode,
  type LanguageCode,
  languageName,
} from '@/lib/languages';
import { DialogShell } from './DialogShell';
import { AlertIcon, FileIcon } from './icons';
import styles from './options.module.css';

// The glossary import (M4-D): pick or drop one file, see what it would change, confirm. The
// file is parsed here (src/lib/glossary/transfer.ts); the background writes the whole list in
// one change, refused as stale when the glossary changed since the preview.

const ENCODING_OPTIONS: SelectOption<LegacyEncoding>[] = LEGACY_ENCODINGS.map((value) => ({
  value,
  label: value,
}));

/** The file picked: its bytes, or why it was not read at all. */
type Picked = { name: string; bytes: Uint8Array } | { name: string; blocker: Blocker };

export interface ImportResult {
  /** The entries written or overwritten: they flash once in the list. */
  ids: string[];
  added: number;
  updated: number;
}

interface Props {
  open: boolean;
  /** Where the dialog grows from (the import button). */
  origin: HTMLElement | null;
  /** The glossary as stored now: a change while the preview shows previews it again. */
  entries: readonly GlossaryEntry[];
  /** The language a translation without one applies to: the current target language. */
  defaultLang: LanguageCode;
  onImported(result: ImportResult): void;
  onClose(): void;
}

const STATUS_TEXT: Record<RowStatus, () => string> = {
  new: () => i18n.t('options.glossaryImport.statNew'),
  update: () => i18n.t('options.glossaryImport.statUpdate'),
  same: () => i18n.t('options.glossaryImport.statSame'),
  invalid: () => i18n.t('options.glossaryImport.statInvalid'),
};

const STATUS_CLASS: Record<RowStatus, string | undefined> = {
  new: styles.pillNew,
  update: styles.pillUpdate,
  same: styles.pillSame,
  invalid: styles.pillInvalid,
};

export function blockerText(blocker: Blocker): string {
  switch (blocker.code) {
    case 'quote':
      return i18n.t('options.glossaryImport.quote', [String(blocker.line)]);
    case 'duplicateColumn':
      return i18n.t('options.glossaryImport.duplicateColumn', [blocker.name]);
    case 'limit':
      return i18n.t('options.glossaryImport.limit', [String(blocker.total), String(blocker.max)]);
    default:
      return i18n.t(`options.glossaryImport.${blocker.code}`);
  }
}

function reasonText(reason: InvalidReason): string {
  switch (reason.code) {
    case 'lang':
      return i18n.t('options.glossaryImport.badLang', [reason.value]);
    case 'case':
      return i18n.t('options.glossaryImport.badCase');
    case 'extra':
      return i18n.t('options.glossaryImport.extraColumn');
    case 'duplicate':
      return i18n.t('options.glossaryImport.duplicate', [String(reason.line)]);
    case 'sameEntry':
      return i18n.t('options.glossaryImport.sameEntry', [String(reason.line)]);
    default:
      return i18n.t(`options.glossaryImport.${reason.code}`);
  }
}

function noteText(note: ImportNote): string {
  if (note.code === 'ignoredColumn') {
    return i18n.t('options.glossaryImport.ignoredColumn', [String(note.index)]);
  }
  const separator = browserUiLanguage().toLowerCase().startsWith('zh') ? '、' : ', '; // i18n-ignore: list separator
  return i18n.t('options.glossaryImport.unknownColumns', [note.names.join(separator)]);
}

function Arrow() {
  return (
    <svg
      aria-hidden="true"
      className={styles.previewArrow}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M3 8h9M9 5l3 3-3 3" />
    </svg>
  );
}

function Target({ text }: { text: string }) {
  return text ? (
    <span>{text}</span>
  ) : (
    <span className={styles.previewKeep}>{i18n.t('options.glossary.keep')}</span>
  );
}

function PreviewLine({ row }: { row: PreviewRow }) {
  const lang =
    row.target === '' ? '' : isLanguageCode(row.lang) ? languageName(row.lang) : row.lang;
  return (
    <li className={styles.previewRow}>
      <span className={`${styles.pill} ${STATUS_CLASS[row.status]}`}>
        {STATUS_TEXT[row.status]()}
      </span>
      <span className={`${styles.previewCell} ${row.source ? '' : styles.previewEmpty}`}>
        {row.source || '—'}
      </span>
      <Arrow />
      <span className={styles.previewCell}>
        {row.previous ? (
          <>
            <Target text={row.previous.target} />
            <span className={styles.previewChange}> → </span>
            <Target text={row.target} />
          </>
        ) : (
          <Target text={row.target} />
        )}
      </span>
      <span className={styles.previewLang}>
        {lang && <span className={styles.glossaryTag}>{lang}</span>}
      </span>
    </li>
  );
}

export function GlossaryImportDialog({
  open,
  origin,
  entries,
  defaultLang,
  onImported,
  onClose,
}: Props) {
  const chooseRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<'choose' | 'preview'>('choose');
  const [picked, setPicked] = useState<Picked>();
  const [encoding, setEncoding] = useState<LegacyEncoding>();
  /** The glossary the preview compares with. */
  const [existing, setExisting] = useState<readonly GlossaryEntry[]>(entries);
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const [multiple, setMultiple] = useState(false);
  /** The glossary changed under the preview, which was made again. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Bumped on every open and close: a file read late belongs to an earlier opening. */
  const session = useRef(0);
  const live = useRef({ open, step, busy, base: glossaryBase(existing) });
  live.current = { open, step, busy, base: glossaryBase(existing) };
  /** Where the focus goes after the next step change. */
  const focusNext = useRef<'preview' | 'choose'>(undefined);

  const preview: ImportPreview | undefined = useMemo(() => {
    if (!picked) return undefined;
    if ('blocker' in picked) return blockedImport(picked.blocker, existing);
    return readImport(picked.bytes, {
      uiLanguage: browserUiLanguage(),
      defaultLang,
      existing,
      encoding,
    });
  }, [picked, encoding, existing, defaultLang]);

  // The glossary changed elsewhere while the dialog is open: compare with the new one. While
  // our own import is being written the change is ours, and the dialog closes on success. A
  // closed dialog ignores changes: it reads the glossary again on the next open.
  useEffect(() => {
    const { open: isOpen, step: shown, busy: writing, base } = live.current;
    if (!isOpen || writing || base === glossaryBase(entries)) return;
    setExisting(entries);
    if (shown === 'preview') setStale(true);
  }, [entries]);

  // Files dropped outside the drop area must not replace the settings page with the file.
  useEffect(() => {
    if (!open) return;
    const hold = (event: Event) => event.preventDefault();
    window.addEventListener('dragover', hold);
    window.addEventListener('drop', hold);
    return () => {
      window.removeEventListener('dragover', hold);
      window.removeEventListener('drop', hold);
    };
  }, [open]);

  useEffect(() => {
    if (!open) session.current += 1;
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new step is rendered
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = undefined;
    if (target === 'preview') previewRef.current?.focus();
    else if (target === 'choose') chooseRef.current?.focus();
  }, [step]);

  function show(next: Picked) {
    setPicked(next);
    setEncoding(undefined);
    setStale(false);
    setError(undefined);
    focusNext.current = 'preview';
    setStep('preview');
  }

  async function take(files: readonly File[], folder: boolean) {
    const [file] = files;
    if (folder || files.length > 1) {
      setMultiple(true);
      return;
    }
    if (!file) return;
    setMultiple(false);
    if (file.size > MAX_IMPORT_BYTES) {
      show({ name: file.name, blocker: { code: 'tooLarge' } });
      return;
    }
    const opening = session.current;
    setReading(true);
    let next: Picked;
    try {
      next = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch {
      next = { name: file.name, blocker: { code: 'unreadable' } };
    }
    if (opening !== session.current) return;
    setReading(false);
    show(next);
  }

  function onDrag(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setOver(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    if (reading) return;
    const folder = [...event.dataTransfer.items].some(
      (item) => item.webkitGetAsEntry?.()?.isDirectory,
    );
    void take([...event.dataTransfer.files], folder);
  }

  function back() {
    setPicked(undefined);
    setError(undefined);
    setStale(false);
    focusNext.current = 'choose';
    setStep('choose');
  }

  const importCount = preview ? preview.counts.new + preview.counts.update : 0;
  const ready =
    !busy && preview !== undefined && !preview.blocker && !preview.allSame && importCount > 0;

  async function submit() {
    if (!ready || !preview) return;
    setBusy(true);
    setError(undefined);
    const result = await changeGlossary({
      type: 'import',
      base: preview.base,
      entries: preview.entries,
    });
    if (!result.ok) {
      if (result.error.code === 'config/glossary-stale') {
        // Changed since the preview: preview against the stored glossary, then ask again.
        const latest = await readGlossary().catch(() => undefined);
        if (latest) setExisting(latest.entries);
        setStale(true);
      } else {
        setError(describeError(result.error, i18n.t('errors.config.writeFailed')));
      }
      setBusy(false);
      return;
    }
    setBusy(false);
    const before = new Set(existing.map((entry) => entry.id));
    const added = result.data.filter((entry) => !before.has(entry.id)).map((entry) => entry.id);
    onImported({
      ids: [...preview.updatedIds, ...added],
      added: preview.counts.new,
      updated: preview.counts.update,
    });
  }

  return (
    <DialogShell
      open={open}
      origin={origin}
      title={i18n.t('options.glossaryImport.title')}
      sub={i18n.t('options.glossaryImport.sub')}
      busy={busy || reading}
      initialFocus={chooseRef}
      onOpen={() => {
        session.current += 1;
        // Reopened after a preview: the choose button is not rendered yet, focus it once it is.
        focusNext.current = 'choose';
        setStep('choose');
        setPicked(undefined);
        setEncoding(undefined);
        setExisting(entries);
        setReading(false);
        setOver(false);
        setMultiple(false);
        setStale(false);
        setBusy(false);
        setError(undefined);
      }}
      onClose={onClose}
      onSubmit={() => void submit()}
      error={error}
      cancelLabel={
        step === 'preview'
          ? i18n.t('options.glossaryImport.rechoose')
          : i18n.t('options.glossary.cancel')
      }
      onCancel={step === 'preview' ? back : onClose}
      submitLabel={
        step === 'preview'
          ? i18n.t('options.glossaryImport.submit', importCount, [String(importCount)])
          : undefined
      }
      submitDisabled={!ready}
    >
      {step === 'choose' || !preview || !picked ? (
        <div className={styles.importBody}>
          {/* Drops land here; the window only swallows the ones that miss it. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the button inside is the keyboard path */}
          <div
            className={`${styles.drop} ${over ? styles.dropOver : ''}`}
            onDragEnter={onDrag}
            onDragOver={onDrag}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
            }}
            onDrop={onDrop}
          >
            <span className={styles.dropIcon}>
              <FileIcon size={28} upload />
            </span>
            <span className={styles.dropText} role="status">
              {reading
                ? i18n.t('options.glossaryImport.reading')
                : i18n.t('options.glossaryImport.drop')}
            </span>
            <button
              ref={chooseRef}
              type="button"
              className={`${styles.ghost} ${styles.chooseButton}`}
              disabled={reading}
              onClick={() => inputRef.current?.click()}
            >
              {i18n.t('options.glossaryImport.choose')}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,.json"
              hidden
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                // Picking the same file again must fire `change` again.
                event.currentTarget.value = '';
                void take(files, false);
              }}
            />
          </div>
          {multiple && (
            <div className={`${styles.appear} ${styles.banner}`} role="alert">
              <AlertIcon />
              <span>{i18n.t('options.glossaryImport.multiple')}</span>
            </div>
          )}
          <ul className={styles.formatNotes}>
            <li>{i18n.t('options.glossaryImport.note1')}</li>
            <li>{i18n.t('options.glossaryImport.note2', [languageName(defaultLang)])}</li>
            <li>{i18n.t('options.glossaryImport.note3')}</li>
            <li>{i18n.t('options.glossaryImport.note4')}</li>
          </ul>
        </div>
      ) : (
        <PreviewBody
          ref={previewRef}
          name={picked.name}
          preview={preview}
          encoding={encoding ?? preview.encoding}
          onEncoding={(value) => {
            setEncoding(value as LegacyEncoding);
            setStale(false);
          }}
          stale={stale}
        />
      )}
    </DialogShell>
  );
}

interface PreviewProps {
  ref: React.Ref<HTMLDivElement>;
  name: string;
  preview: ImportPreview;
  encoding: string | undefined;
  onEncoding(value: string): void;
  stale: boolean;
}

/** File line, counts, the blocker, the rows and the invalid reasons. */
function PreviewBody({ ref, name, preview, encoding, onEncoding, stale }: PreviewProps) {
  const encodingLabel = useId();
  const picker =
    preview.guessed && encoding ? (
      <span className={styles.encodingPick}>
        <span id={encodingLabel} className={styles.visuallyHidden}>
          {i18n.t('options.glossaryImport.encoding')}
        </span>
        <Select
          variant="quiet"
          labelledBy={encodingLabel}
          minWidth={150}
          value={encoding as LegacyEncoding}
          options={ENCODING_OPTIONS}
          onChange={onEncoding}
        />
      </span>
    ) : (
      encoding
    );
  const fileName = <span className={styles.importName}>{name}</span>;
  // The file line is one sentence in every language, with the name and the encoding control
  // put in where the copy has them.
  let meta: React.ReactNode;
  if (preview.rowCount > 0 && encoding) {
    const text = i18n.t('options.glossaryImport.meta', preview.rowCount, [
      '{name}',
      String(preview.rowCount),
      '{encoding}',
    ]);
    meta = text.split(/(\{name\}|\{encoding\})/).map((part, index) => {
      const key = `${index}-${part}`;
      if (part === '{name}') return <span key={key}>{fileName}</span>;
      if (part === '{encoding}') return <span key={key}>{picker}</span>;
      return <span key={key}>{part}</span>;
    });
  } else {
    meta = (
      <>
        {fileName}
        {encoding && <span> · </span>}
        {encoding && picker}
      </>
    );
  }
  const { counts, blocker } = preview;
  const issue = (row: PreviewRow) =>
    i18n.t(
      preview.unit === 'item'
        ? 'options.glossaryImport.itemIssue'
        : 'options.glossaryImport.lineIssue',
      [String(row.line), reasonText(row.reason ?? { code: 'sourceEmpty' })],
    );

  return (
    <div ref={ref} tabIndex={-1} className={`${styles.importBody} ${styles.quietFocus}`}>
      <div className={styles.importMeta}>
        <FileIcon size={14} />
        <span className={styles.importMetaText}>{meta}</span>
        {preview.header && (
          <span className={styles.importHeader}>{i18n.t('options.glossaryImport.header')}</span>
        )}
      </div>
      {preview.notes.map((note) => (
        <p key={noteText(note)} className={styles.importNote}>
          {noteText(note)}
        </p>
      ))}
      {stale && (
        <p className={`${styles.appear} ${styles.importNote}`} role="status">
          {i18n.t('options.glossaryImport.stale')}
        </p>
      )}
      <div className={styles.statGrid}>
        {(['new', 'update', 'same', 'invalid'] as const).map((status) => (
          <span key={status} className={styles.stat}>
            <b>{counts[status]}</b>
            {STATUS_TEXT[status]()}
          </span>
        ))}
      </div>
      {blocker && (
        <div className={styles.banner} role="alert">
          <AlertIcon />
          <span>{blockerText(blocker)}</span>
        </div>
      )}
      {preview.allSame && (
        <div className={`${styles.banner} ${styles.bannerQuiet}`} role="status">
          <span>{i18n.t('options.glossaryImport.allSame')}</span>
        </div>
      )}
      {preview.rows.length > 0 && (
        <div className={styles.previewBox}>
          <ul className={styles.previewList}>
            {preview.rows.map((row) => (
              <PreviewLine key={row.line} row={row} />
            ))}
          </ul>
          {preview.hiddenRows > 0 && (
            <p className={styles.previewMore}>
              {i18n.t('options.glossaryImport.moreRows', preview.hiddenRows, [
                String(preview.hiddenRows),
              ])}
            </p>
          )}
        </div>
      )}
      {preview.issues.length > 0 && (
        <div className={styles.issues}>
          <div className={styles.issuesTitle}>
            {i18n.t('options.glossaryImport.invalidTitle', counts.invalid, [
              String(counts.invalid),
            ])}
          </div>
          {preview.issues.map((row) => (
            <div key={row.line}>{issue(row)}</div>
          ))}
          {preview.hiddenIssues > 0 && (
            <div>
              {i18n.t('options.glossaryImport.moreIssues', preview.hiddenIssues, [
                String(preview.hiddenIssues),
              ])}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
