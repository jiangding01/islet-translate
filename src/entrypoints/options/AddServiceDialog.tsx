import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { i18n } from '#i18n';
import {
  CUSTOM_PROVIDER_LIMITS,
  type CustomProviderId,
  MAX_CUSTOM_PROVIDERS,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { normalizeBaseURL, requiredHostPermission } from '@/lib/endpoint';
import { describeError } from '@/lib/error-messages';
import { requestHostPermission } from '@/lib/host-permission';
import { DialogShell } from './DialogShell';
import { admin } from './hooks';
import { useNotice } from './notice';
import styles from './options.module.css';
import { defaultProviderName, newCustomId, PRESETS } from './providers';

interface Props {
  open: boolean;
  /** Where the dialog grows from (the "添加服务" button). */
  origin: HTMLElement | null;
  existingIds: readonly string[];
  onClose(): void;
  onAdded(id: CustomProviderId, granted: boolean): void;
}

interface Draft {
  preset: string;
  name: string;
  baseURL: string;
  key: string;
  model: string;
}

const emptyDraft = (): Draft => ({
  preset: PRESETS[0]?.id ?? 'other',
  name: '',
  baseURL: PRESETS[0]?.baseURL ?? '',
  key: '',
  model: '',
});

/**
 * Adds a custom provider. The host permission is requested inside the "添加" click, as the
 * browser requires.
 */
export function AddServiceDialog({ open, origin, existingIds, onClose, onAdded }: Props) {
  const modelInput = useRef<HTMLInputElement>(null);
  const baseInput = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const { patch } = useConfig();
  const notice = useNotice();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const preset = PRESETS.find((item) => item.id === draft.preset);
  const endpoint = requiredHostPermission(draft.baseURL);
  const baseInvalid = touched && !endpoint.ok;
  const ready = draft.baseURL.trim() !== '' && draft.model.trim() !== '' && !busy;
  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = event.target;
    setDraft((current) => ({ ...current, [field]: value }));
    if (field === 'baseURL') setTouched(false);
    setError(undefined);
  };

  async function submit() {
    if (!endpoint.ok) {
      // Render the hint before moving the focus, so the field is read with it.
      flushSync(() => setTouched(true));
      baseInput.current?.focus();
      return;
    }
    if (existingIds.length >= MAX_CUSTOM_PROVIDERS) {
      setError(i18n.t('options.services.limitReached', [String(MAX_CUSTOM_PROVIDERS)]));
      return;
    }
    setBusy(true);
    // First await of the click: the permission prompt needs the user gesture.
    const granted = endpoint.data ? await requestHostPermission(endpoint.data.pattern) : true;
    const id = newCustomId(existingIds);
    const baseURL = normalizeBaseURL(draft.baseURL);
    const name = draft.name.trim() || defaultProviderName(preset, baseURL);
    const added = await patch([
      { path: 'customProviders', key: id, add: { name, baseURL, model: draft.model.trim() } },
    ]);
    if (!added.ok) {
      setBusy(false);
      setError(describeError(added.error, i18n.t('errors.action.addFailed')));
      return;
    }
    const key = draft.key.trim();
    if (key) {
      const saved = await admin.setSecret(id, key);
      if (!saved.ok) {
        // The provider exists; the key can be pasted again in its details.
        setBusy(false);
        onAdded(id, granted);
        notice.failed(saved.error, i18n.t('options.add.keyNotSaved'));
        return;
      }
    }
    setBusy(false);
    onAdded(id, granted);
  }

  return (
    <DialogShell
      open={open}
      origin={origin}
      title={i18n.t('options.add.title')}
      sub={i18n.t('options.add.sub')}
      busy={busy}
      // The preset already fills the address; the model is what the user types next.
      initialFocus={modelInput}
      onOpen={() => {
        setDraft(emptyDraft());
        setTouched(false);
        setError(undefined);
        setBusy(false);
      }}
      onClose={onClose}
      onSubmit={() => void submit()}
      error={error}
      hint={endpoint.ok && endpoint.data === null ? undefined : i18n.t('options.add.accessHint')}
      cancelLabel={i18n.t('options.add.cancel')}
      submitLabel={busy ? i18n.t('options.add.adding') : i18n.t('options.add.submit')}
      submitDisabled={!ready}
    >
      <div className={styles.formGrid}>
        <fieldset className={`${styles.chips} ${styles.formWide}`}>
          <legend className={styles.visuallyHidden}>{i18n.t('options.add.presets')}</legend>
          {PRESETS.map((item) => (
            <label key={item.id} className={styles.chip}>
              <input
                type="radio"
                name="preset"
                className={styles.radioInput}
                checked={draft.preset === item.id}
                onChange={() => {
                  setDraft((current) => ({ ...current, preset: item.id, baseURL: item.baseURL }));
                  setTouched(false);
                  setError(undefined);
                }}
              />
              {i18n.t(item.label)}
            </label>
          ))}
        </fieldset>

        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-name`}>
            {i18n.t('options.add.name')}
          </label>
          <input
            id={`${fieldId}-name`}
            className={styles.input}
            maxLength={CUSTOM_PROVIDER_LIMITS.name}
            value={draft.name}
            onChange={set('name')}
            placeholder={
              defaultProviderName(preset, draft.baseURL) || i18n.t('options.add.namePlaceholder')
            }
          />
        </div>
        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-base`}>
            {i18n.t('options.add.baseUrl')}
          </label>
          <div className={styles.fieldStack}>
            <input
              id={`${fieldId}-base`}
              ref={baseInput}
              className={`${styles.input} ${styles.mono}`}
              spellCheck={false}
              value={draft.baseURL}
              onChange={set('baseURL')}
              onBlur={() => draft.baseURL.trim() !== '' && setTouched(true)}
              placeholder="https://example.com/v1"
              maxLength={CUSTOM_PROVIDER_LIMITS.baseURL}
              aria-invalid={baseInvalid}
              aria-describedby={baseInvalid ? `${fieldId}-base-error` : undefined}
              required
            />
            {baseInvalid && (
              <span
                id={`${fieldId}-base-error`}
                className={`${styles.appear} ${styles.fieldError}`}
              >
                {i18n.t('options.add.baseUrlInvalid')}
              </span>
            )}
          </div>
        </div>
        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-key`}>
            {i18n.t('options.add.apiKey')}
          </label>
          <input
            id={`${fieldId}-key`}
            className={`${styles.input} ${styles.mono}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.key}
            onChange={set('key')}
            placeholder={
              preset?.local
                ? i18n.t('options.add.keyPlaceholderLocal')
                : i18n.t('options.add.keyPlaceholderOptional')
            }
          />
        </div>
        <div className={styles.formRow}>
          <label className={styles.label} htmlFor={`${fieldId}-model`}>
            {i18n.t('options.add.model')}
          </label>
          <input
            id={`${fieldId}-model`}
            className={`${styles.input} ${styles.mono}`}
            spellCheck={false}
            maxLength={CUSTOM_PROVIDER_LIMITS.model}
            ref={modelInput}
            value={draft.model}
            onChange={set('model')}
            placeholder={i18n.t('options.add.modelPlaceholder')}
            required
          />
        </div>
      </div>
    </DialogShell>
  );
}
