import { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import { Select, type SelectOption } from '@/components/Select';
import { describeError } from '@/lib/error-messages';
import { changeGlossary } from '@/lib/glossary/client';
import { GLOSSARY_LIMITS, type GlossaryDraft, type GlossaryEntry } from '@/lib/glossary/types';
import { LANGUAGES, type LanguageCode } from '@/lib/languages';
import { CloseIcon } from './icons';
import { useNotice } from './notice';
import styles from './options.module.css';

const LANGUAGE_OPTIONS: SelectOption<LanguageCode>[] = LANGUAGES.map((language) => ({
  value: language.code,
  label: language.name,
  sub: language.code,
  lang: language.code,
}));

interface Props {
  open: boolean;
  /** Where the dialog grows from (the button that opened it). */
  origin: HTMLElement | null;
  /** The entry being edited; absent when adding one. */
  editing?: GlossaryEntry;
  /** The language a new translation applies to: the current target language. */
  defaultLang: LanguageCode;
  /** After a successful save, with the id of the entry written (added entries go last). */
  onSaved(id: string | undefined): void;
  onClose(): void;
}

const DIALOG_WIDTH = 640;
const DIALOG_TOP = 96;

/**
 * Adds or edits one glossary entry. Native modal dialog, written like StyleDialog; the
 * background checks the entry (duplicates, the limit) and its refusal keeps the dialog open.
 */
export function GlossaryDialog({ open, origin, editing, defaultLang, onSaved, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const notice = useNotice();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [lang, setLang] = useState<LanguageCode>(defaultLang);
  const [caseSensitive, setCaseSensitive] = useState(false);
  // The empty hint shows once the source has been typed in, never on leaving it: a hint that
  // appears on blur moves the buttons below it, so the click that caused the blur (Cancel)
  // would miss.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A refusal from the background: a duplicate belongs to the source field. */
  const [refusal, setRefusal] = useState<{ field: 'source' | 'form'; text: string }>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is filled when the dialog opens, not on every edit elsewhere
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSource(editing?.source ?? '');
      setTarget(editing?.target ?? '');
      setLang(editing && editing.lang !== '' ? editing.lang : defaultLang);
      setCaseSensitive(editing?.caseSensitive ?? false);
      setTouched(false);
      setRefusal(undefined);
      setBusy(false);
      if (origin) {
        const button = origin.getBoundingClientRect();
        const width = Math.min(DIALOG_WIDTH, window.innerWidth - 32);
        const left = (window.innerWidth - width) / 2;
        dialog.style.transformOrigin = `${button.left + button.width / 2 - left}px ${button.top + button.height / 2 - DIALOG_TOP}px`;
      }
      dialog.showModal();
      sourceInput.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, origin]);

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
    onSaved(editing ? editing.id : result.data.at(-1)?.id);
    onClose();
  }

  const edited = () => setRefusal(undefined);
  const formError = refusal?.field === 'form' ? refusal.text : undefined;

  return (
    // Esc is handled natively (onCancel); the click only adds close-on-backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close with Esc
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form className={styles.dialogForm} onSubmit={(event) => void submit(event)}>
        <header className={styles.dialogHeader}>
          <div>
            <h2 id={id} className={styles.dialogTitle}>
              {editing ? i18n.t('options.glossary.editTitle') : i18n.t('options.glossary.addTitle')}
            </h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={i18n.t('options.add.close')}
            onClick={onClose}
            disabled={busy}
          >
            <CloseIcon />
          </button>
        </header>

        <div className={styles.formGrid}>
          <div className={styles.formRow}>
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
          <div className={styles.formRow}>
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
            <div className={`${styles.appear} ${styles.formRow}`}>
              <span id={`${id}-lang-label`} className={styles.label}>
                {i18n.t('options.glossary.lang')}
              </span>
              <div>
                <Select
                  id={`${id}-lang`}
                  labelledBy={`${id}-lang-label`}
                  minWidth={168}
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
          <div className={styles.formRow}>
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
        </div>

        <footer className={styles.dialogFooter}>
          <span
            className={formError ? styles.dialogError : styles.hint}
            role={formError ? 'alert' : undefined}
          >
            {formError ?? ''}
          </span>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            {i18n.t('options.glossary.cancel')}
          </button>
          <button type="submit" className={styles.primary} disabled={!ready}>
            {i18n.t('options.glossary.save')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
