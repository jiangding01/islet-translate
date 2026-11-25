import { useEffect, useId, useState } from 'react';
import { i18n } from '#i18n';
import { ProviderIcon } from '@/components/ProviderIcon';
import { DEFAULT_OPENAI_BASE_URL } from '@/lib/config/defaults';
import {
  engineFields,
  fieldChange,
  hasEditableBaseURL,
  takesApiKey,
} from '@/lib/config/engine-fields';
import {
  type ConfigChange,
  type ConfigV1,
  CUSTOM_PROVIDER_LIMITS,
  isBuiltinEngine,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { normalizeBaseURL, requiredHostPermission } from '@/lib/endpoint';
import {
  builtinName,
  customShort,
  type EngineEntry,
  engineReadiness,
  hostName,
  hostOf,
  permissionPattern,
} from '@/lib/engine-view';
import { appError } from '@/lib/errors';
import { requestHostPermission, useHostPermission } from '@/lib/host-permission';
import type { SecretStatusInfo } from '@/lib/messaging/protocol';
import { providerIconFor } from '@/lib/provider-icons';
import { admin } from './hooks';
import { useNotice } from './notice';
import styles from './options.module.css';
import { KEY_LINKS, TEST_BLOCKED_TEXT } from './providers';
import { TestStrip } from './TestStrip';

interface Props {
  entry: EngineEntry;
  config: ConfigV1;
  isDefault: boolean;
  expanded: boolean;
  /** Just added: highlight once and run a connection test. */
  fresh: boolean;
  secret: SecretStatusInfo | undefined;
  onToggle(): void;
  onMakeDefault(): void;
  onSecretsChanged(): void;
  onDelete(): Promise<void>;
}

type TextField = 'name' | 'baseURL' | 'model';

const THINKING_OPTIONS = [
  { value: true, label: 'options.engine.thinkingOn' },
  { value: false, label: 'options.engine.thinkingOff' },
] as const;

/** A private-use character stands in for the node that goes mid-sentence (the host name). */
export const SPLIT_MARK = '\uE000';

/** Splits copy that was given `SPLIT_MARK` as its one substitution into the text before and after it. */
export function splitAround(text: string): [string, string] {
  const at = text.indexOf(SPLIT_MARK);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + SPLIT_MARK.length)];
}

export function EngineItem(props: Props) {
  const { entry, config, isDefault, expanded, fresh, secret } = props;
  const { patch } = useConfig();
  const notice = useNotice();
  const panelId = useId();
  const { id: engine, custom } = entry;
  const builtin = isBuiltinEngine(engine);
  const hasBase = hasEditableBaseURL(engine);
  const takesKey = takesApiKey(engine);

  const fields = engineFields(config, engine);
  const saved: Record<TextField, string> = {
    name: custom?.name ?? '',
    baseURL: fields?.baseURL ?? '',
    model: fields?.model ?? '',
  };
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState<TextField>();
  const [baseError, setBaseError] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Follow changes made elsewhere (another tab, a reset), except in the field being typed in.
  const savedKey = `${saved.name}\n${saved.baseURL}\n${saved.model}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey captures `saved`
  useEffect(() => {
    setDraft((current) => ({
      name: editing === 'name' ? current.name : saved.name,
      baseURL: editing === 'baseURL' ? current.baseURL : saved.baseURL,
      model: editing === 'model' ? current.model : saved.model,
    }));
  }, [savedKey]);

  const pattern = hasBase ? permissionPattern(saved.baseURL) : undefined;
  const granted = useHostPermission(pattern);
  const readiness = engineReadiness({ engine, ...saved, secret, granted });

  async function apply(change: ConfigChange, text = i18n.t('options.notice.saved')) {
    const result = await patch([change]);
    if (result.ok) notice.saved(text);
    else notice.failed(result.error);
  }

  async function commit(field: TextField) {
    setEditing(undefined);
    const value = draft[field].trim();
    if (field === 'baseURL') {
      const empty = value === '';
      const valid = empty ? engine === 'openai' : requiredHostPermission(value).ok;
      setBaseError(!valid);
      if (!valid) return;
      const next = empty ? DEFAULT_OPENAI_BASE_URL : normalizeBaseURL(value);
      setDraft((current) => ({ ...current, baseURL: next }));
      if (next === saved.baseURL) return;
      const change = fieldChange(engine, 'baseURL', next);
      if (change) await apply(change);
      return;
    }
    if (value === saved[field]) return;
    if (field === 'name') {
      if (builtin) return;
      const name = value || hostName(saved.baseURL);
      setDraft((current) => ({ ...current, name }));
      await apply({ path: 'customProviders', key: engine, update: { name } });
      return;
    }
    const change = fieldChange(engine, 'model', value);
    if (change) await apply(change);
  }

  async function saveKey() {
    const value = keyDraft.trim();
    if (!value || engine === 'google') return;
    const result = await admin.setSecret(engine, value);
    if (result.ok) {
      setKeyDraft('');
      setShowKey(false);
      props.onSecretsChanged();
      notice.saved(i18n.t('options.engine.keySaved'));
    } else {
      notice.failed(result.error);
    }
  }

  async function clearKey() {
    if (engine === 'google') return;
    const result = await admin.setSecret(engine, null);
    if (result.ok) {
      props.onSecretsChanged();
      notice.saved(i18n.t('options.engine.keyCleared'));
    } else {
      notice.failed(result.error);
    }
  }

  async function grant() {
    if (!pattern) return;
    const ok = await requestHostPermission(pattern);
    if (ok) notice.saved(i18n.t('options.engine.granted'));
    else
      notice.failed(appError('config', 'config/permission-missing', 'Permission was not granted'));
  }

  const keyed = secret?.configured === true;
  // The test runs on what is typed now, so readiness is judged on the drafts. A
  // host typed but not saved yet has no known grant: the background checks it.
  const draftPattern = hasBase ? permissionPattern(draft.baseURL) : undefined;
  const testReadiness = engineReadiness({
    engine,
    baseURL: draft.baseURL,
    model: draft.model,
    secret,
    granted: draftPattern === pattern ? granted : true,
    keyDraft: keyDraft.trim() !== '',
  });
  const blocked = testReadiness.reason
    ? i18n.t(TEST_BLOCKED_TEXT[testReadiness.reason])
    : undefined;
  // Key saves are not part of it: a key saved mid-test must not discard that result.
  const testedWith = `${draft.baseURL.trim()}\n${draft.model.trim()}\n${fields?.thinking ?? ''}`;

  const sub = rowSubtitle(engine, saved);
  const [grantBefore, grantAfter] = splitAround(i18n.t('options.engine.grantNeeded', [SPLIT_MARK]));
  const link = builtin ? KEY_LINKS[engine] : undefined;
  const field = (name: TextField) => ({
    value: draft[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setDraft((current) => ({ ...current, [name]: value }));
      if (name === 'baseURL') setBaseError(false);
    },
    onFocus: () => setEditing(name),
    onBlur: () => void commit(name),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur();
    },
  });

  return (
    <div
      className={[styles.item, expanded ? styles.itemOpen : '', fresh ? styles.rowFlash : ''].join(
        ' ',
      )}
    >
      <div className={styles.row}>
        <button
          type="button"
          className={styles.radio}
          aria-pressed={isDefault}
          aria-label={i18n.t('options.engine.makeDefaultAria', [entry.name])}
          onClick={props.onMakeDefault}
        >
          <span aria-hidden="true" className={styles.radioMark} />
        </button>
        <button
          type="button"
          className={styles.rowMain}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={props.onToggle}
        >
          <ProviderIcon
            icon={providerIconFor(engine, saved.baseURL)}
            fallback={customShort(saved.name)}
            size={20}
          />
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>
              <span className={styles.rowName}>{entry.name}</span>
              {isDefault && (
                <span className={styles.defaultTag}>{i18n.t('options.engine.defaultBadge')}</span>
              )}
            </span>
            <span className={styles.rowSub}>{sub}</span>
          </span>
          <span className={styles.rowStatus}>
            {readiness.attention && <span aria-hidden="true" className={styles.warnDot} />}
            <span className={readiness.mono ? styles.mono : undefined}>{readiness.status}</span>
          </span>
          <svg
            aria-hidden="true"
            className={styles.chevron}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
      </div>

      <div className={styles.panel} id={panelId} inert={!expanded}>
        <div className={styles.panelClip}>
          <div className={styles.panelInner}>
            {engine === 'google' && (
              <p className={styles.note}>
                {i18n.t('options.engine.googleNote', [builtinName('google')])}
              </p>
            )}

            {!builtin && (
              <label className={styles.field}>
                <span className={styles.label}>{i18n.t('options.engine.name')}</span>
                <input
                  className={styles.input}
                  maxLength={CUSTOM_PROVIDER_LIMITS.name}
                  placeholder={hostName(saved.baseURL)}
                  {...field('name')}
                />
              </label>
            )}

            {hasBase && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${panelId}-base`}>
                  {i18n.t('options.engine.baseUrl')}
                </label>
                <div className={styles.fieldStack}>
                  <input
                    id={`${panelId}-base`}
                    className={`${styles.input} ${styles.mono}`}
                    spellCheck={false}
                    maxLength={CUSTOM_PROVIDER_LIMITS.baseURL}
                    placeholder={
                      engine === 'openai' ? DEFAULT_OPENAI_BASE_URL : 'https://example.com/v1'
                    }
                    aria-invalid={baseError}
                    {...field('baseURL')}
                  />
                  {baseError && (
                    <span className={`${styles.appear} ${styles.fieldError}`}>
                      {i18n.t('options.engine.baseUrlInvalid')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {takesKey && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${panelId}-key`}>
                  {i18n.t('options.engine.apiKey')}
                </label>
                <div className={styles.fieldStack}>
                  <div className={styles.inline}>
                    <input
                      id={`${panelId}-key`}
                      className={`${styles.input} ${styles.mono}`}
                      type={showKey ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      value={keyDraft}
                      placeholder={keyPlaceholder(builtin, secret)}
                      onChange={(event) => setKeyDraft(event.target.value)}
                      onBlur={(event) => {
                        // "Show" keeps the draft: it only reveals what is being typed.
                        if (
                          event.relatedTarget instanceof HTMLElement &&
                          event.relatedTarget.dataset.keepKey
                        )
                          return;
                        void saveKey();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                    {keyDraft !== '' && (
                      <button
                        type="button"
                        className={styles.ghost}
                        data-keep-key="true"
                        onClick={() => setShowKey(!showKey)}
                      >
                        {showKey
                          ? i18n.t('options.engine.keyHide')
                          : i18n.t('options.engine.keyShow')}
                      </button>
                    )}
                    {keyed && keyDraft === '' && (
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => void clearKey()}
                      >
                        {i18n.t('options.engine.keyClear')}
                      </button>
                    )}
                  </div>
                  <span className={styles.hint}>
                    <svg
                      aria-hidden="true"
                      width="11"
                      height="11"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    >
                      <rect x="2.5" y="5.2" width="7" height="5" rx="1.2" />
                      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" />
                    </svg>
                    {i18n.t('options.engine.keyLocalOnly')}
                    {link && (
                      <a className={styles.link} href={link.href} target="_blank" rel="noreferrer">
                        {i18n.t(link.label)}
                      </a>
                    )}
                  </span>
                </div>
              </div>
            )}

            {takesKey && (
              <label className={styles.field}>
                <span className={styles.label}>{i18n.t('options.engine.model')}</span>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  spellCheck={false}
                  maxLength={CUSTOM_PROVIDER_LIMITS.model}
                  placeholder={
                    engine === 'gemini'
                      ? i18n.t('options.engine.modelPlaceholderGemini')
                      : i18n.t('options.engine.modelPlaceholder')
                  }
                  {...field('model')}
                />
              </label>
            )}

            {fields?.thinking !== undefined && (
              <ThinkingRow thinking={fields.thinking} change={apply} />
            )}

            {pattern && granted === false && (
              <div className={styles.field}>
                <span className={styles.label}>{i18n.t('options.engine.access')}</span>
                <div className={styles.inline}>
                  <span className={styles.grantText}>
                    {grantBefore}
                    <span className={styles.mono}>{hostOf(saved.baseURL)}</span>
                    {grantAfter}
                  </span>
                  <button type="button" className={styles.ghostStrong} onClick={() => void grant()}>
                    {i18n.t('options.engine.grantButton')}
                  </button>
                </div>
              </div>
            )}

            {expanded && (
              <TestStrip
                autoRun={fresh}
                blocked={blocked}
                resetKey={testedWith}
                run={() =>
                  admin.test({
                    engine,
                    baseURL: draft.baseURL,
                    model: draft.model.trim(),
                    apiKey: keyDraft.trim() || undefined,
                    thinking: fields?.thinking,
                  })
                }
              />
            )}

            <div className={styles.itemFooter}>
              {isDefault ? (
                <span className={styles.hint}>{i18n.t('options.engine.isDefaultHint')}</span>
              ) : (
                <button type="button" className={styles.textButton} onClick={props.onMakeDefault}>
                  {i18n.t('options.engine.makeDefault')}
                </button>
              )}
              <span className={styles.spacer} />
              {!builtin && !confirmDelete && (
                <button
                  type="button"
                  className={styles.dangerText}
                  onClick={() => setConfirmDelete(true)}
                >
                  {i18n.t('options.engine.deleteService')}
                </button>
              )}
              {!builtin && confirmDelete && (
                <span className={`${styles.appear} ${styles.inline}`}>
                  <span className={styles.hint}>
                    {isDefault
                      ? i18n.t('options.engine.deleteNoteDefault', [builtinName('google')])
                      : i18n.t('options.engine.deleteNote')}
                  </span>
                  <button
                    type="button"
                    className={styles.ghostSmall}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {i18n.t('options.engine.cancel')}
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => void props.onDelete()}
                  >
                    {i18n.t('options.engine.delete')}
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** DeepSeek's thinking mode (`providers.deepseek.thinking`), with what turning it on costs. */
export function ThinkingRow({
  thinking,
  change,
}: {
  thinking: boolean;
  change: (next: ConfigChange) => unknown;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <span id={`${id}-label`} className={styles.label}>
        {i18n.t('options.engine.thinking')}
      </span>
      <div className={styles.fieldStack}>
        <div className={styles.inline}>
          <fieldset
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            className={styles.segmented}
            style={{ '--index': thinking ? 0 : 1 } as React.CSSProperties}
          >
            <span aria-hidden="true" className={styles.segmentThumb} />
            {THINKING_OPTIONS.map((item) => (
              <label key={item.label} className={styles.segment} data-label={i18n.t(item.label)}>
                <input
                  type="radio"
                  name={`${id}-thinking`}
                  className={styles.radioInput}
                  checked={thinking === item.value}
                  onChange={() =>
                    void change({ path: 'providers.deepseek.thinking', value: item.value })
                  }
                />
                {i18n.t(item.label)}
              </label>
            ))}
          </fieldset>
        </div>
        <span id={`${id}-hint`} className={styles.hint}>
          {i18n.t('options.engine.thinkingHint')}
        </span>
      </div>
    </div>
  );
}

function keyPlaceholder(builtin: boolean, secret: SecretStatusInfo | undefined): string {
  if (secret?.configured) {
    return secret.last4
      ? i18n.t('options.engine.keyPlaceholderSavedLast4', [secret.last4])
      : i18n.t('options.engine.keyPlaceholderSaved');
  }
  return builtin
    ? i18n.t('options.engine.keyPlaceholderBuiltin')
    : i18n.t('options.engine.keyPlaceholderOptional');
}

function rowSubtitle(engine: EngineEntry['id'], saved: Record<TextField, string>): string {
  switch (engine) {
    case 'google':
      return i18n.t('options.engine.subFree');
    case 'openai': {
      const host = hostOf(saved.baseURL);
      const model = saved.model || i18n.t('options.engine.subNoModel');
      return host && host !== 'api.openai.com' ? `${host} · ${model}` : model;
    }
    case 'deepseek':
      return saved.model || i18n.t('options.engine.subNoModel');
    case 'gemini':
      return saved.model || i18n.t('options.engine.subNeedsModelId');
    default:
      return `${hostOf(saved.baseURL)} · ${saved.model || i18n.t('options.engine.subNoModel')}`;
  }
}
