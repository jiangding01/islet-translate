import { useId, useRef, useState } from 'react';
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
import { useRefocus } from './hooks';
import { DeleteIcon, EditIcon, PlusIcon } from './icons';
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
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Kept after closing, so the closing dialog (it fades out) keeps its title and fields.
  const [dialog, setDialog] = useState<DialogState>({ origin: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = (state: DialogState) => {
    setConfirming(undefined);
    setDialog(state);
    setDialogOpen(true);
  };
  const [confirming, setConfirming] = useState<CustomStyleId>();

  const current = config.translation.style;
  const customs = customStyleEntries(config);
  const full = customs.length >= MAX_CUSTOM_STYLES;
  const refocus = useRefocus(sectionRef, addButton, full);
  const limitText = i18n.t('options.styles.limitReached', [String(MAX_CUSTOM_STYLES)]);

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
    refocus(addButton.current);
    notice.saved(i18n.t('options.services.deleted'));
  }

  const card = (id: TranslationStyleId, name: string, note: string, badge: boolean) => (
    <label className={styles.styleCardLabel}>
      <input
        type="radio"
        name="translation-style"
        value={id}
        className={styles.radioInput}
        checked={current === id}
        onChange={() => void choose(id)}
      />
      <span className={styles.styleCardHead}>
        <span aria-hidden="true" className={styles.styleDot} />
        <span className={styles.styleCardName}>{name}</span>
        {badge && (
          <span className={styles.defaultTag}>{i18n.t('options.general.defaultBadge')}</span>
        )}
      </span>
      <span className={styles.styleCardNote}>{note}</span>
    </label>
  );

  return (
    <>
      <section
        ref={sectionRef}
        tabIndex={-1}
        aria-labelledby={titleId}
        className={`${styles.section} ${styles.quietFocus}`}
      >
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitleRow}>
            <h2 id={titleId} className={styles.sectionTitle}>
              {i18n.t('options.styles.section')}
            </h2>
            <span className={styles.headHintKeep}>
              {i18n.t('options.styles.sectionHint', [builtinName('google')])}
            </span>
          </div>
          <button
            ref={addButton}
            type="button"
            className={styles.addButton}
            onClick={() => openDialog({ origin: addButton.current })}
            disabled={full}
            title={full ? limitText : undefined}
          >
            <PlusIcon />
            {i18n.t('options.styles.add')}
          </button>
        </div>

        <fieldset className={styles.styleCards}>
          <legend className={styles.visuallyHidden}>{i18n.t('options.nav.styles')}</legend>
          {TRANSLATION_STYLES.map((id) => (
            <div key={id} className={styles.styleCard}>
              {card(
                id,
                i18n.t(PRESET_COPY[id].name),
                i18n.t(PRESET_COPY[id].note),
                id === 'general',
              )}
            </div>
          ))}
          {customs.map(([id, style]) => (
            <div key={id} className={`${styles.styleCard} ${styles.styleCardCustom}`}>
              {card(id, style.name, style.description, false)}
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
                  <EditIcon />
                </button>
                <button
                  id={`${titleId}-${id}-delete`}
                  type="button"
                  className={styles.iconButton}
                  aria-label={i18n.t('options.styles.deleteAria', [style.name])}
                  aria-expanded={confirming === id}
                  onClick={() => setConfirming(confirming === id ? undefined : id)}
                >
                  <DeleteIcon />
                </button>
              </div>
              {confirming === id && (
                <div className={`${styles.appear} ${styles.styleConfirm}`}>
                  <span>
                    {current === id
                      ? i18n.t('options.styles.deleteNoteCurrent', [
                          i18n.t('options.styles.general'),
                        ])
                      : i18n.t('options.engine.deleteNote')}
                  </span>
                  <span className={styles.styleConfirmActions}>
                    <button
                      type="button"
                      className={styles.ghostSmall}
                      onClick={() => {
                        setConfirming(undefined);
                        // Back on this card's delete button (the confirmation it opened goes).
                        refocus(document.getElementById(`${titleId}-${id}-delete`));
                      }}
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
        {full && <p className={styles.hint}>{limitText}</p>}
      </section>

      <StyleDialog
        open={dialogOpen}
        origin={dialog.origin}
        editing={dialog.editing}
        existingIds={customs.map(([id]) => id)}
        onClose={() => {
          setDialogOpen(false);
          refocus(dialog.origin);
        }}
      />
    </>
  );
}
