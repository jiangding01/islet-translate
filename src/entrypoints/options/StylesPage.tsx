import { useRef, useState } from 'react';
import { i18n } from '#i18n';
import { isPlainObject } from '@/lib/config/merge';
import {
  type ConfigV1,
  type CustomStyle,
  type CustomStyleId,
  isCustomStyleId,
  MAX_CUSTOM_STYLES,
  TRANSLATION_STYLES,
  type TranslationStyle,
  type TranslationStyleId,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { builtinName } from '@/lib/engine-view';
import { useNotice } from './notice';
import styles from './options.module.css';
import { StyleDialog } from './StyleDialog';

// Key tables only: the copy is looked up at render.
const PRESET_COPY = {
  general: { name: 'options.styles.general', note: 'options.styles.generalNote' },
  tech: { name: 'options.styles.tech', note: 'options.styles.techNote' },
  academic: { name: 'options.styles.academic', note: 'options.styles.academicNote' },
  casual: { name: 'options.styles.casual', note: 'options.styles.casualNote' },
  literary: { name: 'options.styles.literary', note: 'options.styles.literaryNote' },
} as const satisfies Record<TranslationStyle, { name: string; note: string }>;

/**
 * Well-formed custom styles in stored order. The client passes the record through unchecked
 * (it stays small for the content script), so an entry with missing or mistyped fields (a
 * newer or hand-edited store) is skipped here. Exported for tests.
 */
export function customStyleEntries(config: ConfigV1): [CustomStyleId, CustomStyle][] {
  const records: unknown = config.customStyles;
  if (!isPlainObject(records)) return [];
  return Object.entries(records).flatMap(([id, value]) =>
    isCustomStyleId(id) &&
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string'
      ? [[id, { name: value.name, description: value.description }]]
      : [],
  );
}

type DialogState = {
  origin: HTMLElement | null;
  editing?: { id: CustomStyleId; style: CustomStyle };
};

export function StylesPage({ config }: { config: ConfigV1 }) {
  const { patch } = useConfig();
  const notice = useNotice();
  const addButton = useRef<HTMLButtonElement>(null);
  // Kept after closing, so the closing dialog (it fades out) keeps its title and fields.
  const [dialog, setDialog] = useState<DialogState>({ origin: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = (state: DialogState) => {
    setDialog(state);
    setDialogOpen(true);
  };
  const [confirming, setConfirming] = useState<CustomStyleId>();

  const current = config.translation.style;
  const customs = customStyleEntries(config);
  const full = customs.length >= MAX_CUSTOM_STYLES;

  async function choose(style: TranslationStyleId) {
    if (style === current) return;
    const result = await patch([{ path: 'translation.style', value: style }]);
    if (result.ok) notice.saved();
    else notice.failed(result.error);
  }

  async function remove(id: CustomStyleId) {
    const result = await patch([{ path: 'customStyles', key: id, remove: true }]);
    if (!result.ok) {
      notice.failed(result.error, i18n.t('errors.action.deleteFailed'));
      return;
    }
    setConfirming(undefined);
    notice.saved(i18n.t('options.services.deleted'));
  }

  return (
    <>
      <section aria-label={i18n.t('options.nav.styles')} className={styles.section}>
        <div className={styles.sectionHead}>
          {config.translation.engine === 'google' ? (
            <p className={`${styles.hint} ${styles.styleNote}`}>
              {i18n.t('options.styles.googleNote', [builtinName('google')])}
            </p>
          ) : (
            <span />
          )}
          <button
            ref={addButton}
            type="button"
            className={styles.addButton}
            onClick={() => openDialog({ origin: addButton.current })}
            disabled={full}
            title={
              full ? i18n.t('options.styles.limitReached', [String(MAX_CUSTOM_STYLES)]) : undefined
            }
          >
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
            {i18n.t('options.styles.add')}
          </button>
        </div>
        {full && (
          <p className={styles.hint}>
            {i18n.t('options.styles.limitReached', [String(MAX_CUSTOM_STYLES)])}
          </p>
        )}

        <fieldset className={styles.styleCards}>
          <legend className={styles.visuallyHidden}>{i18n.t('options.nav.styles')}</legend>
          {TRANSLATION_STYLES.map((id) => (
            <div key={id} className={styles.styleCard}>
              <label className={styles.styleCardLabel}>
                <input
                  type="radio"
                  name="translation-style"
                  value={id}
                  className={styles.radioInput}
                  checked={current === id}
                  onChange={() => void choose(id)}
                />
                <span className={styles.styleCardName}>{i18n.t(PRESET_COPY[id].name)}</span>
                <span className={styles.styleCardNote}>{i18n.t(PRESET_COPY[id].note)}</span>
              </label>
            </div>
          ))}
          {customs.map(([id, style]) => (
            <div key={id} className={`${styles.styleCard} ${styles.styleCardCustom}`}>
              <label className={styles.styleCardLabel}>
                <input
                  type="radio"
                  name="translation-style"
                  value={id}
                  className={styles.radioInput}
                  checked={current === id}
                  onChange={() => void choose(id)}
                />
                <span className={styles.styleCardName}>{style.name}</span>
                <span className={`${styles.styleCardNote} ${styles.clamp}`}>
                  {style.description}
                </span>
              </label>
              {/* Outside the label: a button inside it would be part of the radio's name. */}
              <div className={styles.styleCardActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={i18n.t('options.styles.editAria', [style.name])}
                  onClick={(event) =>
                    openDialog({ origin: event.currentTarget, editing: { id, style } })
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
                    <path d="M9.5 2.5l2 2L5 11H3V9z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={i18n.t('options.styles.deleteAria', [style.name])}
                  aria-expanded={confirming === id}
                  onClick={() => setConfirming(confirming === id ? undefined : id)}
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
              </div>
              {confirming === id && (
                <div className={`${styles.appear} ${styles.styleConfirm}`}>
                  <span className={styles.hint}>
                    {current === id
                      ? i18n.t('options.styles.deleteNoteCurrent', [
                          i18n.t('options.styles.general'),
                        ])
                      : i18n.t('options.engine.deleteNote')}
                  </span>
                  <span className={styles.inline}>
                    <button
                      type="button"
                      className={styles.ghostSmall}
                      onClick={() => setConfirming(undefined)}
                    >
                      {i18n.t('options.styles.cancel')}
                    </button>
                    <button type="button" className={styles.danger} onClick={() => void remove(id)}>
                      {i18n.t('options.styles.confirmDelete')}
                    </button>
                  </span>
                </div>
              )}
            </div>
          ))}
        </fieldset>
      </section>

      <StyleDialog
        open={dialogOpen}
        origin={dialog.origin}
        editing={dialog.editing}
        existingIds={customs.map(([id]) => id)}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
