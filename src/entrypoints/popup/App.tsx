import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { i18n } from '#i18n';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Select, type SelectOption } from '@/components/Select';
import { engineFields, hasEditableBaseURL } from '@/lib/config/engine-fields';
import type { ConfigV1, Engine, PageMode } from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import {
  builtinName,
  customShort,
  type EngineReadiness,
  engineEntries,
  engineReadiness,
  permissionPattern,
} from '@/lib/engine-view';
import { describeError } from '@/lib/error-messages';
import { appError, fail } from '@/lib/errors';
import { useHostPermission, useHostPermissions } from '@/lib/host-permission';
import { LANGUAGES, type LanguageCode, languageName } from '@/lib/languages';
import { call } from '@/lib/messaging/handle';
import {
  type PageState,
  type SecretProviderId,
  type SecretStatusInfo,
  sendMessage,
} from '@/lib/messaging/protocol';
import { providerIconFor } from '@/lib/provider-icons';
import { useTheme } from '@/styles/theme';
import { type ActivePage, inspectActivePage } from './inspect-page';
import {
  failedText,
  pageActive,
  pausedReason,
  skippedText,
  usePageSession,
  useShortcut,
  useSiteAlways,
} from './page-session';
import { panelState } from './panel-state';
import styles from './popup.module.css';

const TARGET_OPTIONS: SelectOption<LanguageCode>[] = LANGUAGES.map((language) => ({
  value: language.code,
  label: language.name,
  lang: language.code,
}));

type Statuses = Partial<Record<SecretProviderId, SecretStatusInfo>>;

export function App() {
  const { state, patch } = useConfig();
  const [page, setPage] = useState<ActivePage>();
  const [statuses, setStatuses] = useState<Statuses>();
  const [error, setError] = useState<string>();
  const session = usePageSession(page?.tabId);
  const shortcut = useShortcut();
  const site = useSiteAlways(page?.origin);
  useTheme(state.status === 'ready' ? state.snapshot.data.ui.theme : undefined);

  useEffect(() => {
    void inspectActivePage()
      .catch(
        (): ActivePage => ({
          host: '',
          info: fail(appError('validation', 'validation/unsupported-page', 'No active page')),
        }),
      )
      .then(setPage);
    void call(() => sendMessage('secrets.status', undefined)).then((result) => {
      if (result.ok) setStatuses(result.data);
    });
  }, []);

  if (state.status !== 'ready') {
    return (
      <main className={styles.panel}>
        <p className={styles.quiet} role="status">
          {state.status === 'loading'
            ? i18n.t('popup.loading')
            : describeError(state.error, i18n.t('errors.action.panelReadFailed'))}
        </p>
      </main>
    );
  }

  const config = state.snapshot.data;
  const target = config.language.target;
  const view = panelState(page, target);

  async function save(change: Parameters<typeof patch>[0][number]) {
    const result = await patch([change]);
    setError(
      result.ok ? undefined : describeError(result.error, i18n.t('errors.config.writeFailed')),
    );
  }

  const failed = () => setError(i18n.t('errors.action.openSettingsFailed'));
  // The gear: the settings page as the browser opens it (the general page, an open one reused).
  const openSettings = () => {
    void browser.runtime.openOptionsPage().catch(failed);
  };
  // "去设置" next to an engine problem: straight to the services page. `openOptionsPage`
  // takes no hash, so this is a new tab each time (a rare path).
  const openServices = () => {
    void browser.tabs
      .create({ url: `${browser.runtime.getURL('/options.html')}#services` })
      .catch(failed);
  };

  const report = (result: { ok: boolean; error?: Parameters<typeof describeError>[0] }) => {
    setError(result.ok || !result.error ? undefined : describeError(result.error));
    return result.ok;
  };
  // Starting hands the page back to the reader: the panel gets out of the way.
  const start = async (engine?: Engine) => {
    if (report(await session.start(engine))) window.close();
  };
  const active = pageActive(session.state);
  const canAlways =
    page?.origin !== undefined && view.kind !== 'native' && (active || view.kind === 'foreign');

  return (
    <main className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.host}>
          {view.kind === 'blocked' && i18n.t('popup.browserPage')}
          {view.kind !== 'blocked' && view.kind !== 'loading' && (
            <>
              {view.host}
              {view.kind !== 'unreachable' &&
                ` · ${
                  view.language
                    ? i18n.t('popup.detected', [languageName(view.language)])
                    : i18n.t('popup.noLanguage')
                }`}
            </>
          )}
          {view.kind === 'loading' && ' '}
        </span>
        {(view.kind === 'foreign' || view.kind === 'native' || view.kind === 'loading') && (
          <div className={styles.pair}>
            <span>
              {view.kind !== 'loading' && view.language
                ? languageName(view.language)
                : i18n.t('common.autoDetect')}
            </span>
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              className={styles.faint}
            >
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
            <Select
              variant="inline"
              label={i18n.t('popup.translateTo')}
              minWidth={180}
              value={target}
              options={TARGET_OPTIONS}
              onChange={(value) => void save({ path: 'language.target', value })}
            />
          </div>
        )}
      </div>

      <div className={styles.body}>
        {active && session.state && (
          <SessionActions
            key="session"
            state={session.state}
            config={config}
            shortcut={shortcut}
            onStop={async () => report(await session.stop())}
            onMode={async (mode) => report(await session.setMode(mode))}
            onRetry={async () => report(await session.retryFailed())}
            onGoogle={() => void start('google')}
            onOpenSettings={openServices}
          />
        )}
        {!active && view.kind === 'foreign' && (
          <IdleActions
            key="idle"
            config={config}
            statuses={statuses}
            shortcut={shortcut}
            onStart={(engine) => void start(engine)}
            onOpenSettings={openServices}
          />
        )}
        {!active && view.kind === 'native' && (
          <>
            <div className={styles.message}>
              <strong>{i18n.t('popup.nativeTitle', [languageName(view.language)])}</strong>
              <span>{i18n.t('popup.nativeHint')}</span>
            </div>
            <IdleActions
              key="anyway"
              variant="anyway"
              config={config}
              statuses={statuses}
              shortcut={shortcut}
              onStart={(engine) => void start(engine)}
              onOpenSettings={openServices}
            />
          </>
        )}
        {view.kind === 'unreachable' && (
          <div className={styles.message}>
            <strong>{i18n.t('popup.reloadTitle')}</strong>
            <span>{i18n.t('popup.reloadHint')}</span>
          </div>
        )}
        {view.kind === 'blocked' && (
          <div className={styles.message}>
            <strong>{i18n.t('popup.blockedTitle')}</strong>
            <span>{i18n.t('popup.blockedHint')}</span>
          </div>
        )}
        {view.kind === 'loading' && (
          <span className={styles.quiet}>{i18n.t('popup.readingPage')}</span>
        )}
        {canAlways && (
          <button
            type="button"
            role="switch"
            aria-checked={site.always === true}
            disabled={site.always === undefined}
            className={styles.switchRow}
            onClick={() => void site.toggle().then((result) => result && report(result))}
          >
            <span className={styles.switchText}>
              <span>{i18n.t('popup.alwaysSite')}</span>
              <span className={styles.switchHint}>
                {site.always
                  ? i18n.t('popup.alwaysOn', [page?.host ?? ''])
                  : i18n.t('popup.alwaysOff')}
              </span>
            </span>
            <span aria-hidden="true" className={styles.switchTrack}>
              <span className={styles.switchKnob} />
            </span>
          </button>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        <EngineSelect
          config={config}
          statuses={statuses}
          onChange={(engine) => void save({ path: 'translation.engine', value: engine })}
        />
        <span className={styles.spacer} />
        <button type="button" className={styles.settingsButton} onClick={openSettings}>
          {/* Gear: Tabler Icons "settings" (MIT), stroke matched to the panel's 1.3px lines. */}
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {i18n.t('popup.settings')}
        </button>
      </footer>
    </main>
  );
}

function useReadiness(config: ConfigV1, statuses: Statuses | undefined) {
  const engine = config.translation.engine;
  const fields = engineFields(config, engine) ?? { baseURL: '', model: '' };
  const granted = useHostPermission(
    hasEditableBaseURL(engine) ? permissionPattern(fields.baseURL) : undefined,
  );
  return engineReadiness({
    engine,
    ...fields,
    secret: engine === 'google' ? undefined : statuses?.[engine],
    granted,
  });
}

function engineName(config: ConfigV1, engine: Engine): string {
  return engineEntries(config).find((entry) => entry.id === engine)?.name ?? engine;
}

function Kbd({ shortcut }: { shortcut: string | undefined }) {
  return shortcut ? <span className={styles.kbd}>{shortcut}</span> : null;
}

/** Not translated yet: one main action. A default engine that cannot translate is never a dead end. */
function IdleActions({
  config,
  statuses,
  shortcut,
  variant = 'main',
  onStart,
  onOpenSettings,
}: {
  config: ConfigV1;
  statuses: Statuses | undefined;
  shortcut: string | undefined;
  /** `anyway`: the page already reads as the target language; a quiet secondary button. */
  variant?: 'main' | 'anyway';
  onStart: (engine?: Engine) => void;
  onOpenSettings: () => void;
}) {
  const anyway = variant === 'anyway';
  const readiness = useReadiness(config, statuses);
  const blocked = statuses !== undefined && readiness.problem !== undefined;
  return (
    <div className={styles.stage}>
      {blocked && (
        <div className={styles.notice}>
          <span aria-hidden="true" className={styles.warnDot} />
          <span className={styles.noticeText}>
            {i18n.t('popup.engineNotReady', [
              engineName(config, config.translation.engine),
              readiness.problem ?? '',
            ])}
          </span>
          <button type="button" className={styles.textButton} onClick={onOpenSettings}>
            {i18n.t('popup.goSettings')}
          </button>
        </div>
      )}
      {blocked ? (
        <button type="button" className={styles.primary} onClick={() => onStart('google')}>
          <span className={styles.grow}>
            {i18n.t('common.useGoogleOnce', [builtinName('google')])}
          </span>
        </button>
      ) : (
        <button
          type="button"
          className={anyway ? styles.secondary : styles.primary}
          onClick={() => onStart()}
        >
          <span className={styles.grow}>
            {anyway ? i18n.t('popup.translateAnyway') : i18n.t('popup.translatePage')}
          </span>
          <Kbd shortcut={shortcut} />
        </button>
      )}
      {!anyway && shortcut === '' && (
        <span className={styles.quiet}>
          {i18n.t('popup.noShortcut')}{' '}
          <button
            type="button"
            className={styles.textButton}
            onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
          >
            {i18n.t('popup.setShortcut')}
          </button>
        </span>
      )}
    </div>
  );
}

// Key table only: the copy is looked up at render (tests switch the UI language per case).
const MODES = [
  { value: 'bilingual', label: 'common.modeBilingual' },
  { value: 'translation', label: 'common.modeTranslation' },
] as const satisfies { value: PageMode; label: string }[];

/** A session is on: progress, mode, failures, and the way back to the original. */
function SessionActions({
  state,
  config,
  shortcut,
  onStop,
  onMode,
  onRetry,
  onGoogle,
  onOpenSettings,
}: {
  state: PageState;
  config: ConfigV1;
  shortcut: string | undefined;
  onStop: () => void;
  onMode: (mode: PageMode) => void;
  onRetry: () => void;
  onGoogle: () => void;
  onOpenSettings: () => void;
}) {
  // Optimistic: the thumb moves on click, the page follows a frame later.
  const [mode, setMode] = useState(state.mode);
  useEffect(() => setMode(state.mode), [state.mode]);
  const engine = state.engine ?? config.translation.engine;
  const running = state.phase === 'running' && !state.engineError;
  const skipped = state.skipped ?? 0;

  if (state.engineError) {
    return (
      <div className={styles.stage}>
        <div className={styles.notice} title={describeError(state.engineError)}>
          <span aria-hidden="true" className={styles.warnDot} />
          <span className={styles.noticeText}>
            {i18n.t('popup.pausedNotice', [
              engineName(config, engine),
              pausedReason(state.engineError),
            ])}
          </span>
          <button type="button" className={styles.textButton} onClick={onOpenSettings}>
            {i18n.t('popup.goSettings')}
          </button>
        </div>
        {engine === 'google' ? (
          <button type="button" className={styles.primary} onClick={onRetry}>
            <span className={styles.grow}>{i18n.t('common.retry')}</span>
          </button>
        ) : (
          <button type="button" className={styles.primary} onClick={onGoogle}>
            <span className={styles.grow}>
              {i18n.t('common.useGoogleOnce', [builtinName('google')])}
            </span>
          </button>
        )}
        <button type="button" className={styles.secondary} onClick={onStop}>
          <span className={styles.grow}>{i18n.t('popup.showOriginal')}</span>
          <Kbd shortcut={shortcut} />
        </button>
      </div>
    );
  }

  const index = MODES.findIndex((item) => item.value === mode);
  return (
    <div className={styles.stage}>
      {running && (
        <div className={styles.progress} role="status">
          <span>{i18n.t('popup.progress')}</span>
          <span aria-hidden="true" className={styles.track}>
            <span className={styles.sweep} />
          </span>
        </div>
      )}
      {state.failed > 0 && (
        <div className={styles.failRow}>
          <span aria-hidden="true" className={styles.warnDot} />
          <span className={styles.grow}>{failedText(state.failed)}</span>
          <button type="button" className={styles.textButton} onClick={onRetry}>
            {i18n.t('common.retry')}
          </button>
        </div>
      )}
      {skipped > 0 && (
        <div className={styles.failRow}>
          <span aria-hidden="true" className={styles.dot} />
          <span className={styles.grow}>{skippedText(skipped)}</span>
        </div>
      )}
      {state.translated > 0 && (
        <fieldset
          aria-label={i18n.t('popup.displayMode')}
          className={styles.segmented}
          style={{ '--index': index } as React.CSSProperties}
        >
          <span aria-hidden="true" className={styles.segmentThumb} />
          {MODES.map((item) => (
            <label key={item.value} className={styles.segment}>
              <input
                type="radio"
                name="page-mode"
                className={styles.radioInput}
                checked={mode === item.value}
                onChange={() => {
                  setMode(item.value);
                  onMode(item.value);
                }}
              />
              {i18n.t(item.label)}
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" className={styles.secondary} onClick={onStop}>
        <span className={styles.grow}>
          {running ? i18n.t('popup.stopShowOriginal') : i18n.t('popup.showOriginal')}
        </span>
        <Kbd shortcut={shortcut} />
      </button>
    </div>
  );
}

/** Grey while the key status or grant is still unknown; green when ready, coral when not. */
function dotFor(state: EngineReadiness, statuses: Statuses | undefined): 'ok' | 'warn' | 'idle' {
  if (statuses === undefined || state.reason === 'checking-grant') return 'idle';
  return state.problem ? 'warn' : 'ok';
}

function EngineSelect({
  config,
  statuses,
  onChange,
}: {
  config: ConfigV1;
  statuses: Statuses | undefined;
  onChange: (engine: Engine) => void;
}) {
  const current = config.translation.engine;
  const entries = engineEntries(config).map((entry) => {
    const fields = engineFields(config, entry.id) ?? { baseURL: '', model: '' };
    const pattern = hasEditableBaseURL(entry.id) ? permissionPattern(fields.baseURL) : undefined;
    return { entry, fields, pattern };
  });
  const grants = useHostPermissions(entries.flatMap(({ pattern }) => (pattern ? [pattern] : [])));
  const options = entries.map(({ entry, fields, pattern }): SelectOption<Engine> => {
    const state = engineReadiness({
      engine: entry.id,
      ...fields,
      secret: entry.id === 'google' ? undefined : statuses?.[entry.id],
      granted: pattern ? grants?.[pattern] : undefined,
    });
    return {
      value: entry.id,
      label: entry.name,
      sub: state.status,
      dot: dotFor(state, statuses),
      icon: (
        <ProviderIcon
          icon={providerIconFor(entry.id, fields.baseURL)}
          fallback={customShort(entry.custom?.name ?? '')}
        />
      ),
    };
  });
  const selected = options.find((option) => option.value === current);
  return (
    <Select
      variant="quiet"
      label={i18n.t('popup.defaultEngine')}
      minWidth={236}
      value={current}
      options={options}
      onChange={onChange}
    >
      <span aria-hidden="true" className={`${styles.dot} ${styles[selected?.dot ?? 'idle']}`} />
      <span className={styles.engineName}>{selected?.label}</span>
    </Select>
  );
}
