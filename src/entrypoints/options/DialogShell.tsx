import { type ReactNode, type RefObject, useEffect, useEffectEvent, useId, useRef } from 'react';
import { i18n } from '#i18n';
import { CloseIcon } from './icons';
import styles from './options.module.css';

interface Props {
  open: boolean;
  /** Where the dialog grows from (the button that opened it). */
  origin: HTMLElement | null;
  title: string;
  sub?: string;
  /** While saving: the dialog can't be closed and its buttons are disabled. */
  busy: boolean;
  /** The field focused when the dialog opens. */
  initialFocus: RefObject<HTMLElement | null>;
  /** Right before the dialog opens: reset the draft here. */
  onOpen(): void;
  onClose(): void;
  onSubmit(): void;
  /** A refusal for the whole form, announced; replaces the hint while shown. */
  error?: string;
  hint?: string;
  cancelLabel: string;
  submitLabel: string;
  submitDisabled: boolean;
  /** The fields, laid out on `.formGrid`. */
  children?: ReactNode;
}

const DIALOG_WIDTH = 640;
const DIALOG_TOP = 96;

/**
 * The native modal dialog shared by the settings pages: focus is trapped and Esc closes it
 * for free. It grows out of the button that opened it and shrinks back. The page owns the
 * draft and its checks; this owns opening, closing, the header and the footer.
 */
export function DialogShell({
  open,
  origin,
  title,
  sub,
  busy,
  initialFocus,
  onOpen,
  onClose,
  onSubmit,
  error,
  hint,
  cancelLabel,
  submitLabel,
  submitDisabled,
  children,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  /** Whether the current press started on the backdrop. */
  const pressedBackdrop = useRef(false);
  const opening = useEffectEvent(onOpen);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opening();
      if (origin) {
        const button = origin.getBoundingClientRect();
        const width = Math.min(DIALOG_WIDTH, window.innerWidth - 32);
        const left = (window.innerWidth - width) / 2;
        dialog.style.transformOrigin = `${button.left + button.width / 2 - left}px ${button.top + button.height / 2 - DIALOG_TOP}px`;
      }
      dialog.showModal();
      initialFocus.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, origin, initialFocus]);

  // Chrome lets a page cancel Esc only once without a user activation in between: a second Esc
  // closes the dialog even though `cancel` is prevented. Stopping the key itself holds. It is
  // caught on the document: the focus is not always inside the dialog while it saves (Save is
  // disabled under it).
  useEffect(() => {
    if (!busy) return;
    const hold = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', hold, true);
    return () => document.removeEventListener('keydown', hold, true);
  }, [busy]);

  return (
    // Esc is handled natively (onCancel); the click only adds close-on-backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close with Esc
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      // The `close` event is queued: it can arrive after the dialog was opened again, and must
      // not close the new one.
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
      // A press on the backdrop lands on the dialog element itself. The click alone is not
      // enough: a text selection dragged out of a field and released on the backdrop also
      // clicks the dialog (the common ancestor), and must not close it.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromBackdrop = pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (fromBackdrop && event.target === event.currentTarget && !busy) onClose();
      }}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form
        className={styles.dialogForm}
        // Required fields get the page's own hints, not the browser's bubbles.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className={styles.dialogHeader}>
          <div>
            <h2 id={titleId} className={styles.dialogTitle}>
              {title}
            </h2>
            {sub && <p className={styles.dialogSub}>{sub}</p>}
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

        {children}

        <footer className={styles.dialogFooter}>
          <span className={styles.dialogStatus}>
            {/* Always mounted, so screen readers announce the text put into it. */}
            <span role="alert" className={styles.dialogError}>
              {error ?? ''}
            </span>
            {!error && hint ? <span className={styles.hint}>{hint}</span> : null}
          </span>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="submit" className={styles.primary} disabled={submitDisabled}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
