import { useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import {
  CUSTOM_STYLE_LIMITS,
  type CustomStyle,
  type CustomStyleId,
  MAX_CUSTOM_STYLES,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { describeError } from '@/lib/error-messages';
import { DialogShell } from './DialogShell';
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

/**
 * Adds or edits a custom style: a name (shown on the card only) and the description sent to
 * the model.
 */
export function StyleDialog({ open, origin, editing, existingIds, onClose }: Props) {
  const nameInput = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const { patch } = useConfig();
  const notice = useNotice();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // A field's empty hint shows once it has been typed in, never on leaving it: a hint that
  // appears on blur moves the buttons below it, so the click that caused the blur (Cancel)
  // would miss.
  const [touched, setTouched] = useState({ name: false, description: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const nameEmpty = name.trim() === '';
  const descriptionEmpty = description.trim() === '';
  const ready = !nameEmpty && !descriptionEmpty && !busy;

  async function submit() {
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
    <DialogShell
      open={open}
      origin={origin}
      title={editing ? i18n.t('options.styles.editTitle') : i18n.t('options.styles.addTitle')}
      busy={busy}
      initialFocus={nameInput}
      onOpen={() => {
        setName(editing?.style.name ?? '');
        setDescription(editing?.style.description ?? '');
        setTouched({ name: false, description: false });
        setError(undefined);
        setBusy(false);
      }}
      onClose={onClose}
      onSubmit={() => void submit()}
      error={error}
      cancelLabel={i18n.t('options.styles.cancel')}
      submitLabel={i18n.t('options.styles.save')}
      submitDisabled={!ready}
    >
      <div className={styles.formGrid}>
        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-name`}>
            {i18n.t('options.styles.name')}
          </label>
          <div className={styles.fieldStack}>
            <input
              id={`${fieldId}-name`}
              ref={nameInput}
              className={styles.input}
              maxLength={CUSTOM_STYLE_LIMITS.name}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setTouched((current) => ({ ...current, name: true }));
                setError(undefined);
              }}
              placeholder={i18n.t('options.styles.namePlaceholder')}
              aria-invalid={touched.name && nameEmpty}
              aria-describedby={touched.name && nameEmpty ? `${fieldId}-name-error` : undefined}
              required
            />
            {touched.name && nameEmpty && (
              <span
                id={`${fieldId}-name-error`}
                className={`${styles.appear} ${styles.fieldError}`}
              >
                {i18n.t('options.styles.nameRequired')}
              </span>
            )}
          </div>
        </div>
        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-description`}>
            {i18n.t('options.styles.description')}
          </label>
          <div className={styles.fieldStack}>
            <textarea
              id={`${fieldId}-description`}
              className={`${styles.input} ${styles.textarea} ${styles.styleTextarea}`}
              maxLength={CUSTOM_STYLE_LIMITS.description}
              rows={5}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setTouched((current) => ({ ...current, description: true }));
                setError(undefined);
              }}
              placeholder={i18n.t('options.styles.descriptionPlaceholder')}
              aria-invalid={touched.description && descriptionEmpty}
              aria-describedby={
                touched.description && descriptionEmpty
                  ? `${fieldId}-description-error ${fieldId}-count`
                  : `${fieldId}-count`
              }
              required
            />
            <span className={styles.hint}>
              {touched.description && descriptionEmpty && (
                <span
                  id={`${fieldId}-description-error`}
                  className={`${styles.appear} ${styles.fieldError}`}
                >
                  {i18n.t('options.styles.descriptionRequired')}
                </span>
              )}
              <span id={`${fieldId}-count`} className={styles.counter}>
                {description.length} / {CUSTOM_STYLE_LIMITS.description}
              </span>
            </span>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
