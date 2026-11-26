import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { i18n } from '#i18n';
import { Select, type SelectOption } from '@/components/Select';
import { describeError } from '@/lib/error-messages';
import { changeGlossary } from '@/lib/glossary/client';
import { GLOSSARY_LIMITS, type GlossaryDraft, type GlossaryEntry } from '@/lib/glossary/types';
import { LANGUAGES, type LanguageCode } from '@/lib/languages';
import { DialogShell } from './DialogShell';
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

/**
 * Adds or edits one glossary entry. The background checks the entry (duplicates, the limit)
 * and its refusal keeps the dialog open.
 */
export function GlossaryDialog({ open, origin, editing, defaultLang, onSaved, onClose }: Props) {
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

  async function submit() {
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
      const field = result.error.code === 'config/glossary-duplicate' ? 'source' : 'form';
      // Render the refusal before moving the focus, so the source is read with its hint; a
      // refusal for the whole form is announced by the footer's alert instead.
      flushSync(() => setRefusal({ field, text }));
      if (field === 'source') sourceInput.current?.focus();
      return;
    }
    notice.saved();
    onSaved(editing ? editing.id : result.data.at(-1)?.id);
    onClose();
  }

  const edited = () => setRefusal(undefined);
  const formError = refusal?.field === 'form' ? refusal.text : undefined;

  return (
    <DialogShell
      open={open}
      origin={origin}
      title={editing ? i18n.t('options.glossary.editTitle') : i18n.t('options.glossary.addTitle')}
      busy={busy}
      initialFocus={sourceInput}
      onOpen={() => {
        setSource(editing?.source ?? '');
        setTarget(editing?.target ?? '');
        setLang(editing && editing.lang !== '' ? editing.lang : defaultLang);
        setCaseSensitive(editing?.caseSensitive ?? false);
        setTouched(false);
        setRefusal(undefined);
        setBusy(false);
      }}
      onClose={onClose}
      onSubmit={() => void submit()}
      error={formError}
      cancelLabel={i18n.t('options.glossary.cancel')}
      submitLabel={i18n.t('options.glossary.save')}
      submitDisabled={!ready}
    >
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
    </DialogShell>
  );
}
