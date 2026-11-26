import { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import type { ConfigV1 } from '@/lib/config/types';
import { changeGlossary, readGlossary, watchGlossary } from '@/lib/glossary/client';
import { type GlossaryEntry, MAX_GLOSSARY_ENTRIES } from '@/lib/glossary/types';
import { languageName } from '@/lib/languages';
import { GlossaryDialog } from './GlossaryDialog';
import { useRefocus } from './hooks';
import { DeleteIcon, EditIcon, PlusIcon } from './icons';
import { useNotice } from './notice';
import styles from './options.module.css';

// The glossary page (M4-C, redesigned in M4): one entry per row on a shared grid, added and
// edited in a dialog like the custom styles.

/** The stored entries (malformed ones skipped), kept in step with storage; undefined while loading. */
export function useGlossaryEntries(): GlossaryEntry[] | undefined {
  const [entries, setEntries] = useState<GlossaryEntry[]>();
  useEffect(() => {
    let live = true;
    const stop = watchGlossary((next) => setEntries(next));
    readGlossary()
      .then((next) => {
        if (live) setEntries((current) => current ?? next);
      })
      .catch(() => {
        if (live) setEntries((current) => current ?? []);
      });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return entries;
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
  const entries = useGlossaryEntries();
  const notice = useNotice();
  const titleId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // Kept after closing, so the closing dialog (it fades out) keeps its title and fields.
  const [dialog, setDialog] = useState<DialogState>({ origin: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  /** The entry just added or edited: its row flashes once. */
  const [flash, setFlash] = useState<string>();
  const list = entries ?? [];
  const full = list.length >= MAX_GLOSSARY_ENTRIES;
  const limitText = i18n.t('errors.config.glossaryLimit');
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

      {entries !== undefined && (
        <div className={styles.card}>
          {list.length === 0 ? (
            <div className={styles.glossaryEmpty}>
              <span className={styles.glossaryEmptyIcon}>
                <BookIcon />
              </span>
              <p>{i18n.t('options.glossary.empty')}</p>
            </div>
          ) : (
            <ul className={styles.glossaryList}>
              {list.map((entry) => (
                <li
                  key={entry.id}
                  className={`${styles.glossaryRow} ${flash === entry.id ? styles.rowFlash : ''}`}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) setFlash(undefined);
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

      <GlossaryDialog
        open={dialogOpen}
        origin={dialog.origin}
        editing={dialog.editing}
        defaultLang={config.language.target}
        onSaved={setFlash}
        onClose={() => {
          setDialogOpen(false);
          refocus(dialog.origin);
        }}
      />
    </section>
  );
}
