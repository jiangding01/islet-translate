import { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import type { ConfigV1 } from '@/lib/config/types';
import {
  changeGlossary,
  type GlossaryState,
  readGlossary,
  watchGlossary,
} from '@/lib/glossary/client';
import { type GlossaryEntry, MAX_GLOSSARY_ENTRIES } from '@/lib/glossary/types';
import { languageName } from '@/lib/languages';
import { GlossaryDialog } from './GlossaryDialog';
import { GlossaryExportMenu } from './GlossaryExportMenu';
import { GlossaryImportDialog } from './GlossaryImportDialog';
import { useRefocus } from './hooks';
import { DeleteIcon, EditIcon, ImportIcon, PlusIcon, SearchIcon } from './icons';
import { useNotice } from './notice';
import styles from './options.module.css';

// The glossary page (M4-C, redesigned in M4): one entry per row on a shared grid, added and
// edited in a dialog like the custom styles. M4-D adds import, export and a filter.

/**
 * The stored entries (malformed ones skipped) and whether a newer build wrote them, kept in
 * step with storage; undefined while loading.
 */
export function useGlossary(): GlossaryState | undefined {
  const [state, setState] = useState<GlossaryState>();
  useEffect(() => {
    let live = true;
    const stop = watchGlossary((next) => setState(next));
    readGlossary()
      .then((next) => {
        if (live) setState((current) => current ?? next);
      })
      .catch(() => {
        if (live) setState((current) => current ?? { entries: [], readOnly: false });
      });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

/** Entries whose source or translation contains the query, case ignored. */
function filterEntries(entries: GlossaryEntry[], query: string): GlossaryEntry[] {
  const text = query.trim().toLowerCase();
  if (!text) return entries;
  return entries.filter(
    (entry) =>
      entry.source.toLowerCase().includes(text) || entry.target.toLowerCase().includes(text),
  );
}

function BookIcon() {
  return (
    <svg
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d="M2.5 3.2c1.9-.7 3.8-.6 5.5.6v9.6c-1.7-1.2-3.6-1.3-5.5-.6z" />
      <path d="M13.5 3.2c-1.9-.7-3.8-.6-5.5.6v9.6c1.7-1.2 3.6-1.3 5.5-.6z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.glossaryArrow}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M3 8h9M9 5l3 3-3 3" />
    </svg>
  );
}

type DialogState = { origin: HTMLElement | null; editing?: GlossaryEntry };

export function GlossaryPage({ config }: { config: ConfigV1 }) {
  const glossary = useGlossary();
  const entries = glossary?.entries;
  const readOnly = glossary?.readOnly ?? false;
  const notice = useNotice();
  const titleId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  // Kept after closing, so the closing dialog (it fades out) keeps its title and fields.
  const [dialog, setDialog] = useState<DialogState>({ origin: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  /** The entries just added, edited or imported: their rows flash once. */
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const list = entries ?? [];
  const shown = filterEntries(list, query);
  const full = list.length >= MAX_GLOSSARY_ENTRIES;
  const limitText = i18n.t('errors.config.glossaryLimit');
  const readOnlyText = i18n.t('errors.config.glossaryNewerVersion');
  const refocus = useRefocus(sectionRef, addRef, full);

  const openDialog = (state: DialogState) => {
    setConfirming(undefined);
    setDialog(state);
    setDialogOpen(true);
  };

  async function remove(id: string) {
    const result = await changeGlossary({ type: 'remove', id });
    if (!result.ok) {
      notice.failed(result.error, i18n.t('errors.action.deleteFailed'));
      return;
    }
    setConfirming(undefined);
    refocus(addRef.current);
    notice.saved(i18n.t('options.services.deleted'));
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`${styles.section} ${styles.quietFocus}`}
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitleRow}>
          <h2 id={titleId} className={styles.sectionTitle}>
            {i18n.t('options.glossary.section')}
          </h2>
          {list.length > 0 && (
            <span className={styles.headHintKeep}>
              {i18n.t('options.glossary.count', [
                String(list.length),
                String(MAX_GLOSSARY_ENTRIES),
              ])}
            </span>
          )}
        </div>
        <div className={styles.headActions}>
          <button
            ref={importRef}
            type="button"
            className={styles.addButton}
            onClick={() => {
              setConfirming(undefined);
              setImportOpen(true);
            }}
            disabled={entries === undefined || readOnly}
            title={readOnly ? readOnlyText : undefined}
          >
            <ImportIcon />
            {i18n.t('options.glossary.import')}
          </button>
          <GlossaryExportMenu
            entries={list}
            disabled={list.length === 0 || readOnly}
            title={readOnly ? readOnlyText : undefined}
            onExported={() => notice.saved(i18n.t('options.glossary.exported'))}
          />
          <button
            ref={addRef}
            type="button"
            className={styles.addButton}
            onClick={() => openDialog({ origin: addRef.current })}
            disabled={full}
            title={full ? limitText : undefined}
          >
            <PlusIcon />
            {i18n.t('options.glossary.add')}
          </button>
        </div>
      </div>

      {list.length > 0 && (
        <label className={styles.filter}>
          <span className={styles.visuallyHidden}>{i18n.t('options.glossary.filterLabel')}</span>
          <SearchIcon className={styles.filterIcon} />
          <input
            type="search"
            className={`${styles.input} ${styles.filterInput}`}
            value={query}
            placeholder={i18n.t('options.glossary.filterPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      {entries !== undefined && (
        <div className={styles.card}>
          {list.length > 0 && shown.length === 0 ? (
            <p className={styles.noMatch}>{i18n.t('options.glossary.noMatch')}</p>
          ) : list.length === 0 ? (
            <div className={styles.glossaryEmpty}>
              <span className={styles.glossaryEmptyIcon}>
                <BookIcon />
              </span>
              <p>{i18n.t('options.glossary.empty')}</p>
            </div>
          ) : (
            <ul className={styles.glossaryList}>
              {shown.map((entry) => (
                <li
                  key={entry.id}
                  className={`${styles.glossaryRow} ${flash.has(entry.id) ? styles.rowFlash : ''}`}
                  onAnimationEnd={(event) => {
                    if (event.target !== event.currentTarget) return;
                    setFlash((current) => {
                      const next = new Set(current);
                      next.delete(entry.id);
                      return next;
                    });
                  }}
                >
                  <span
                    className={`${styles.glossaryCell} ${styles.glossaryText} ${styles.glossarySource}`}
                  >
                    {entry.source}
                  </span>
                  <ArrowIcon />
                  <span className={styles.glossaryCell}>
                    {entry.target ? (
                      <span className={styles.glossaryText}>{entry.target}</span>
                    ) : (
                      <span className={`${styles.defaultTag} ${styles.glossaryKeep}`}>
                        {i18n.t('options.glossary.keep')}
                      </span>
                    )}
                  </span>
                  <span className={styles.glossaryMeta}>
                    {entry.lang !== '' && (
                      <span className={styles.glossaryTag}>{languageName(entry.lang)}</span>
                    )}
                    {entry.caseSensitive && (
                      <span className={`${styles.glossaryTag} ${styles.glossaryCase}`}>
                        <span aria-hidden="true">Aa</span>
                        <span className={styles.visuallyHidden}>
                          {i18n.t('options.glossary.caseSensitive')}
                        </span>
                      </span>
                    )}
                  </span>
                  <span className={styles.glossaryActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={i18n.t('options.glossary.editAria', [entry.source])}
                      onClick={(event) =>
                        openDialog({ origin: event.currentTarget, editing: entry })
                      }
                    >
                      <EditIcon />
                    </button>
                    <button
                      id={`${titleId}-${entry.id}-delete`}
                      type="button"
                      className={styles.iconButton}
                      aria-label={i18n.t('options.glossary.deleteAria', [entry.source])}
                      aria-expanded={confirming === entry.id}
                      onClick={() => setConfirming(confirming === entry.id ? undefined : entry.id)}
                    >
                      <DeleteIcon />
                    </button>
                  </span>
                  {confirming === entry.id && (
                    <div className={`${styles.appear} ${styles.glossaryConfirm}`}>
                      <span>{i18n.t('options.glossary.deleteNote')}</span>
                      <button
                        type="button"
                        className={styles.ghostSmall}
                        onClick={() => {
                          setConfirming(undefined);
                          refocus(document.getElementById(`${titleId}-${entry.id}-delete`));
                        }}
                      >
                        {i18n.t('options.glossary.cancel')}
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => void remove(entry.id)}
                      >
                        {i18n.t('options.glossary.confirmDelete')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {full && <p className={styles.hint}>{limitText}</p>}
      {readOnly && <p className={styles.hint}>{readOnlyText}</p>}

      <GlossaryDialog
        open={dialogOpen}
        origin={dialog.origin}
        editing={dialog.editing}
        defaultLang={config.language.target}
        onSaved={(id) => setFlash(new Set(id ? [id] : []))}
        onClose={() => {
          setDialogOpen(false);
          refocus(dialog.origin);
        }}
      />
      <GlossaryImportDialog
        open={importOpen}
        origin={importRef.current}
        entries={list}
        defaultLang={config.language.target}
        onImported={({ ids, added, updated }) => {
          setImportOpen(false);
          setQuery('');
          setFlash(new Set(ids));
          notice.saved(
            i18n.t('options.glossary.imported', added + updated, [
              String(added + updated),
              String(added),
              String(updated),
            ]),
          );
          refocus(importRef.current);
        }}
        onClose={() => {
          setImportOpen(false);
          refocus(importRef.current);
        }}
      />
    </section>
  );
}
