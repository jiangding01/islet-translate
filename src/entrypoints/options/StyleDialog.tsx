import { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import {
  CUSTOM_STYLE_LIMITS,
  type CustomStyle,
  type CustomStyleId,
  MAX_CUSTOM_STYLES,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { describeError } from '@/lib/error-messages';
import { useNotice } from './notice';
import styles from './options.module.css';
import { newStyleId } from './providers';

interface Props {
  open: boolean;
  /** Where the dialog grows from (the button that opened it). */
  origin: HTMLElement | null;
  /** The custom style being edited; absent when adding one. */
  editing?: { id: CustomStyleId; style: CustomStyle };
  existingIds: readonly string[];
  onClose(): void;
}

const DIALOG_WIDTH = 640;
const DIALOG_TOP = 96;

/**
 * Adds or edits a custom style: a name (shown on the card only) and the description sent to
 * the model. Native modal dialog, written like AddServiceDialog.
 */
export function StyleDialog({ open, origin, editing, existingIds, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { patch } = useConfig();
  const notice = useNotice();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // A field's empty hint shows once it has been typed in or left, not on a fresh dialog.
  const [touched, setTouched] = useState({ name: false, description: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is filled when the dialog opens, not on every edit elsewhere
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setName(editing?.style.name ?? '');
      setDescription(editing?.style.description ?? '');
      setTouched({ name: false, description: false });
      setError(undefined);
      setBusy(false);
      if (origin) {
        const button = origin.getBoundingClientRect();
        const width = Math.min(DIALOG_WIDTH, window.innerWidth - 32);
        const left = (window.innerWidth - width) / 2;
        dialog.style.transformOrigin = `${button.left + button.width / 2 - left}px ${button.top + button.height / 2 - DIALOG_TOP}px`;
      }
      dialog.showModal();
      nameInput.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, origin]);

  const nameEmpty = name.trim() === '';
  const descriptionEmpty = description.trim() === '';
  const ready = !nameEmpty && !descriptionEmpty && !busy;

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!ready) return;
    const fields = { name: name.trim(), description: description.trim() };
    if (!editing && existingIds.length >= MAX_CUSTOM_STYLES) {
      setError(i18n.t('options.styles.limitReached', [String(MAX_CUSTOM_STYLES)]));
      return;
    }
    setBusy(true);
    const result = await patch([
      editing
        ? { path: 'customStyles', key: editing.id, update: fields }
        : { path: 'customStyles', key: newStyleId(existingIds), add: fields },
    ]);
    setBusy(false);
    if (!result.ok) {
      setError(
        describeError(
          result.error,
          editing ? i18n.t('errors.config.writeFailed') : i18n.t('errors.action.addFailed'),
        ),
      );
      return;
    }
    notice.saved();
    onClose();
  }

  return (
    // Esc is handled natively (onCancel); the click only adds close-on-backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close with Esc
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
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
            <h2 id={titleId} className={styles.dialogTitle}>
              {editing ? i18n.t('options.styles.editTitle') : i18n.t('options.styles.addTitle')}
            </h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={i18n.t('options.add.close')}
            onClick={onClose}
            disabled={busy}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </header>

        <div className={styles.dialogBody}>
          <div className={styles.dialogField}>
            <label className={styles.label} htmlFor={`${titleId}-name`}>
              {i18n.t('options.styles.name')}
            </label>
            <div className={styles.fieldStack}>
              <input
                id={`${titleId}-name`}
                ref={nameInput}
                className={styles.input}
                maxLength={CUSTOM_STYLE_LIMITS.name}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setTouched((current) => ({ ...current, name: true }));
                  setError(undefined);
                }}
                onBlur={() => setTouched((current) => ({ ...current, name: true }))}
                placeholder={i18n.t('options.styles.namePlaceholder')}
                aria-invalid={touched.name && nameEmpty}
                aria-describedby={touched.name && nameEmpty ? `${titleId}-name-error` : undefined}
                required
              />
              {touched.name && nameEmpty && (
                <span
                  id={`${titleId}-name-error`}
                  className={`${styles.appear} ${styles.fieldError}`}
                >
                  {i18n.t('options.styles.nameRequired')}
                </span>
              )}
            </div>
          </div>
          <div className={styles.dialogField}>
            <label className={styles.label} htmlFor={`${titleId}-description`}>
              {i18n.t('options.styles.description')}
            </label>
            <div className={styles.fieldStack}>
              <textarea
                id={`${titleId}-description`}
                className={`${styles.input} ${styles.textarea} ${styles.styleTextarea}`}
                maxLength={CUSTOM_STYLE_LIMITS.description}
                rows={5}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setTouched((current) => ({ ...current, description: true }));
                  setError(undefined);
                }}
                onBlur={() => setTouched((current) => ({ ...current, description: true }))}
                placeholder={i18n.t('options.styles.descriptionPlaceholder')}
                aria-invalid={touched.description && descriptionEmpty}
                aria-describedby={
                  touched.description && descriptionEmpty
                    ? `${titleId}-description-error ${titleId}-count`
                    : `${titleId}-count`
                }
                required
              />
              <span className={styles.hint}>
                {touched.description && descriptionEmpty && (
                  <span
                    id={`${titleId}-description-error`}
                    className={`${styles.appear} ${styles.fieldError}`}
                  >
                    {i18n.t('options.styles.descriptionRequired')}
                  </span>
                )}
                <span id={`${titleId}-count`} className={styles.counter}>
                  {description.length} / {CUSTOM_STYLE_LIMITS.description}
                </span>
              </span>
            </div>
          </div>
        </div>

        <footer className={styles.dialogFooter}>
          <span
            className={error ? styles.dialogError : styles.hint}
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            {i18n.t('options.styles.cancel')}
          </button>
          <button type="submit" className={styles.primary} disabled={!ready}>
            {i18n.t('options.styles.save')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
