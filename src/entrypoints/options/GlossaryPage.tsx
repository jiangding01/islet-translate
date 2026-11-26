import { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import { Select, type SelectOption } from '@/components/Select';
import type { ConfigV1 } from '@/lib/config/types';
import { describeError } from '@/lib/error-messages';
import { changeGlossary, readGlossary, watchGlossary } from '@/lib/glossary/client';
import {
  GLOSSARY_LIMITS,
  type GlossaryDraft,
  type GlossaryEntry,
  MAX_GLOSSARY_ENTRIES,
} from '@/lib/glossary/types';
import { LANGUAGES, type LanguageCode, languageName } from '@/lib/languages';
import { useNotice } from './notice';
import styles from './options.module.css';

// The glossary page (M4-C): one entry per row, added and edited in an inline form at the top.

const LANGUAGE_OPTIONS: SelectOption<LanguageCode>[] = LANGUAGES.map((language) => ({
  value: language.code,
  label: language.name,
  sub: language.code,
  lang: language.code,
}));

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

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

type FormState = { editing?: GlossaryEntry; key: number };

export function GlossaryPage({ config }: { config: ConfigV1 }) {
  const entries = useGlossaryEntries();
  const notice = useNotice();
  const [form, setForm] = useState<FormState>();
  const [confirming, setConfirming] = useState<string>();
  const addRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const rowsId = useId();
  /** Where the focus goes once the form or a row it was in goes away (set, then applied after render). */
  const [refocus, setRefocus] = useState<'home' | { deleteOf: string }>();
  const list = entries ?? [];
  const full = list.length >= MAX_GLOSSARY_ENTRIES;
  const limitText = i18n.t('errors.config.glossaryLimit');

  // After the render that removed the focused form or row: the add button, or the section when
  // the button is disabled (full); the row's delete button when its confirmation was cancelled.
  useEffect(() => {
    if (!refocus) return;
    setRefocus(undefined);
    if (refocus !== 'home') {
      document.getElementById(`${rowsId}-${refocus.deleteOf}`)?.focus();
    } else if (addRef.current && !addRef.current.disabled) {
      addRef.current.focus();
    } else {
      sectionRef.current?.focus();
    }
  }, [refocus, rowsId]);

  const openForm = (editing?: GlossaryEntry) =>
    setForm((current) => ({ editing, key: (current?.key ?? 0) + 1 }));

  async function remove(id: string) {
    const result = await changeGlossary({ type: 'remove', id });
    if (!result.ok) {
      notice.failed(result.error, i18n.t('errors.action.deleteFailed'));
      return;
    }
    setConfirming(undefined);
    if (form?.editing?.id === id) setForm(undefined);
    setRefocus('home');
    notice.saved(i18n.t('options.services.deleted'));
  }

  const addButton = (ref?: React.Ref<HTMLButtonElement>) => (
    <button
      ref={ref}
      type="button"
      className={styles.addButton}
      onClick={() => openForm()}
      disabled={full}
      title={full ? limitText : undefined}
    >
      <PlusIcon />
      {i18n.t('options.glossary.add')}
    </button>
  );

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label={i18n.t('options.nav.glossary')}
      className={`${styles.section} ${styles.glossarySection}`}
    >
      <div className={styles.sectionHead}>
        <span />
        {addButton(addRef)}
      </div>
      {full && <p className={styles.hint}>{limitText}</p>}

      {entries !== undefined && (form || list.length > 0) && (
        <div className={styles.card}>
          {form && (
            <GlossaryForm
              key={form.key}
              editing={form.editing}
              defaultLang={config.language.target}
              onDone={() => {
                setForm(undefined);
                setRefocus('home');
              }}
            />
          )}
          {list.length > 0 && (
            <ul className={styles.glossaryList}>
              {list.map((entry) => (
                <li key={entry.id} className={styles.glossaryRow}>
                  <div className={styles.glossaryLine}>
                    <span className={styles.glossaryTerm}>
                      <span>{entry.source}</span>
                      <span aria-hidden="true" className={styles.glossaryArrow}>
                        →
                      </span>
                      {entry.target ? (
                        <span>{entry.target}</span>
                      ) : (
                        <span className={styles.defaultTag}>{i18n.t('options.glossary.keep')}</span>
                      )}
                      {(entry.lang !== '' || entry.caseSensitive) && (
                        <span className={styles.glossaryTag}>
                          {[entry.lang === '' ? '' : languageName(entry.lang)]
                            .concat(entry.caseSensitive ? ['Aa'] : [])
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className={styles.glossaryActions}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={i18n.t('options.glossary.editAria', [entry.source])}
                        onClick={() => openForm(entry)}
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                        >
                          <path d="M9.5 2.5l2 2L5 11H3V9z" />
                        </svg>
                      </button>
                      <button
                        id={`${rowsId}-${entry.id}`}
                        type="button"
                        className={styles.iconButton}
                        aria-label={i18n.t('options.glossary.deleteAria', [entry.source])}
                        aria-expanded={confirming === entry.id}
                        onClick={() =>
                          setConfirming(confirming === entry.id ? undefined : entry.id)
                        }
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                        >
                          <path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" />
                        </svg>
                      </button>
                    </span>
                  </div>
                  {confirming === entry.id && (
                    <div className={`${styles.appear} ${styles.glossaryConfirm}`}>
                      <span className={styles.hint}>{i18n.t('options.glossary.deleteNote')}</span>
                      <button
                        type="button"
                        className={styles.ghostSmall}
                        onClick={() => {
                          setConfirming(undefined);
                          setRefocus({ deleteOf: entry.id });
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

      {entries !== undefined && !form && list.length === 0 && (
        <div className={`${styles.card} ${styles.glossaryEmpty}`}>
          <p>{i18n.t('options.glossary.empty')}</p>
          {addButton()}
        </div>
      )}
    </section>
  );
}

interface FormProps {
  /** The entry being edited; absent when adding one. */
  editing?: GlossaryEntry;
  /** The language a new translation applies to: the current target language. */
  defaultLang: LanguageCode;
  onDone(): void;
}

/** Adds or edits one entry, inline at the top of the list. */
function GlossaryForm({ editing, defaultLang, onDone }: FormProps) {
  const id = useId();
  const notice = useNotice();
  const sourceInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState(editing?.source ?? '');
  const [target, setTarget] = useState(editing?.target ?? '');
  const [lang, setLang] = useState<LanguageCode>(
    editing && editing.lang !== '' ? editing.lang : defaultLang,
  );
  const [caseSensitive, setCaseSensitive] = useState(editing?.caseSensitive ?? false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A refusal from the background: a duplicate belongs to the source field. */
  const [refusal, setRefusal] = useState<{ field: 'source' | 'form'; text: string }>();

  useEffect(() => {
    sourceInput.current?.focus();
  }, []);

  const sourceText = source.trim();
  const targetText = target.trim();
  const sourceError =
    touched && sourceText === ''
      ? i18n.t('options.glossary.sourceRequired')
      : sourceText.length > GLOSSARY_LIMITS.source
        ? i18n.t('options.glossary.sourceTooLong')
        : refusal?.field === 'source'
          ? refusal.text
          : undefined;
  const targetError =
    targetText.length > GLOSSARY_LIMITS.target
      ? i18n.t('options.glossary.targetTooLong')
      : undefined;
  const ready =
    !busy &&
    sourceText !== '' &&
    sourceText.length <= GLOSSARY_LIMITS.source &&
    targetError === undefined;

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    setTouched(true);
    if (!ready) return;
    const entry: GlossaryDraft = {
      source: sourceText,
      target: targetText,
      lang: targetText === '' ? '' : lang,
      caseSensitive,
    };
    setBusy(true);
    const result = await changeGlossary(
      editing ? { type: 'update', id: editing.id, entry } : { type: 'add', entry },
    );
    setBusy(false);
    if (!result.ok) {
      const text = describeError(
        result.error,
        editing ? i18n.t('errors.config.writeFailed') : i18n.t('errors.action.addFailed'),
      );
      setRefusal({
        field: result.error.code === 'config/glossary-duplicate' ? 'source' : 'form',
        text,
      });
      return;
    }
    notice.saved();
    onDone();
  }

  const edited = () => setRefusal(undefined);

  return (
    <form className={styles.glossaryForm} onSubmit={(event) => void submit(event)}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-source`}>
          {i18n.t('options.glossary.source')}
        </label>
        <div className={styles.fieldStack}>
          <input
            id={`${id}-source`}
            ref={sourceInput}
            className={styles.input}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setTouched(true);
              edited();
            }}
            onBlur={() => setTouched(true)}
            aria-invalid={sourceError !== undefined}
            aria-describedby={sourceError ? `${id}-source-error` : undefined}
            required
          />
          {sourceError && (
            <span id={`${id}-source-error`} className={`${styles.appear} ${styles.fieldError}`}>
              {sourceError}
            </span>
          )}
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-target`}>
          {i18n.t('options.glossary.target')}
        </label>
        <div className={styles.fieldStack}>
          <input
            id={`${id}-target`}
            className={styles.input}
            value={target}
            placeholder={i18n.t('options.glossary.targetPlaceholder')}
            onChange={(event) => {
              setTarget(event.target.value);
              edited();
            }}
            aria-invalid={targetError !== undefined}
            aria-describedby={targetError ? `${id}-target-error` : undefined}
          />
          {targetError && (
            <span id={`${id}-target-error`} className={`${styles.appear} ${styles.fieldError}`}>
              {targetError}
            </span>
          )}
        </div>
      </div>
      {targetText !== '' && (
        <div className={styles.field}>
          <span id={`${id}-lang-label`} className={styles.label}>
            {i18n.t('options.glossary.lang')}
          </span>
          <div className={styles.fieldStack}>
            <Select
              id={`${id}-lang`}
              labelledBy={`${id}-lang-label`}
              minWidth={200}
              value={lang}
              options={LANGUAGE_OPTIONS}
              onChange={(value) => {
                setLang(value);
                edited();
              }}
            />
          </div>
        </div>
      )}
      <div className={styles.field}>
        <span />
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => {
              setCaseSensitive(event.target.checked);
              edited();
            }}
          />
          {i18n.t('options.glossary.caseSensitive')}
        </label>
      </div>
      <div className={styles.glossaryFormFooter}>
        <span
          className={refusal?.field === 'form' ? styles.dialogError : styles.hint}
          role={refusal?.field === 'form' ? 'alert' : undefined}
        >
          {refusal?.field === 'form' ? refusal.text : ''}
        </span>
        <button type="button" className={styles.ghost} onClick={onDone} disabled={busy}>
          {i18n.t('options.glossary.cancel')}
        </button>
        <button type="submit" className={styles.primary} disabled={!ready}>
          {i18n.t('options.glossary.save')}
        </button>
      </div>
    </form>
  );
}
