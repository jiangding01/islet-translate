import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { i18n } from '#i18n';
import { useConfig } from '@/lib/config/use-config';
import { describeError } from '@/lib/error-messages';
import { useTheme } from '@/styles/theme';
import { GeneralPage } from './GeneralPage';
import { NoticeLine, NoticeProvider, useNoticeState } from './notice';
import styles from './options.module.css';
import { ServicesPage } from './ServicesPage';

type Page = 'general' | 'services';

// Key table only: the copy is looked up at render (tests switch the UI language per case).
const PAGES = [
  { id: 'general', title: 'options.nav.general', sub: 'options.nav.generalSub' },
  { id: 'services', title: 'options.nav.services', sub: 'options.nav.servicesSub' },
] as const satisfies { id: Page; title: string; sub: string }[];

/**
 * Opens on the general page; `#services` only when the caller came for the engines (the
 * popup's "去设置" next to an engine problem). Exported for tests.
 */
export function pageFromHash(hash = location.hash): Page {
  return hash === '#services' ? 'services' : 'general';
}

export function App() {
  const { state } = useConfig();
  const { api, notice } = useNoticeState();
  const [page, setPage] = useState<Page>(() => pageFromHash());
  useTheme(state.status === 'ready' ? state.snapshot.data.ui.theme : undefined);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const index = PAGES.findIndex((item) => item.id === page);
  const current = PAGES[index] ?? PAGES[0];

  return (
    <NoticeProvider api={api}>
      <div className={styles.shell}>
        <nav aria-label={i18n.t('options.nav.label')} className={styles.nav}>
          <div className={styles.brand}>
            <img alt="" className={styles.brandIcon} src="/icon/48.png" />
            <span>{i18n.t('manifest.name')}</span>
          </div>
          <div className={styles.navList} style={{ '--index': index } as React.CSSProperties}>
            <span aria-hidden="true" className={styles.navThumb} />
            {PAGES.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={styles.navItem}
                aria-current={item.id === page ? 'page' : undefined}
              >
                {item.id === 'general' ? <GearIcon /> : <TranslateIcon />}
                {i18n.t(item.title)}
              </a>
            ))}
          </div>
          <div className={styles.navFooter}>
            <span>v{browser.runtime.getManifest().version}</span>
          </div>
        </nav>

        <main className={styles.main}>
          <div className={styles.column}>
            <header className={styles.pageHeader}>
              <div>
                <h1 className={styles.pageTitle}>{i18n.t(current.title)}</h1>
                <p className={styles.pageSub}>{i18n.t(current.sub)}</p>
              </div>
              <NoticeLine notice={notice} />
            </header>

            {state.status === 'loading' && (
              <p className={styles.pageSub}>{i18n.t('options.nav.loading')}</p>
            )}
            {state.status === 'error' && (
              <p className={styles.fieldError} role="alert">
                {describeError(state.error, i18n.t('errors.config.readFailed'))}
              </p>
            )}
            {state.status === 'ready' &&
              (page === 'general' ? (
                <GeneralPage config={state.snapshot.data} />
              ) : (
                <ServicesPage config={state.snapshot.data} />
              ))}
          </div>
        </main>
      </div>
    </NoticeProvider>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}

function TranslateIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M2 3.5h6M5 2v1.5M3.2 3.5c.6 2.4 2.2 4.2 4.3 5.2M6.8 3.5c-.5 2.2-2 4.2-4.3 5.4" />
      <path d="M8.5 14l2.8-6.5L14 14M9.4 12h3.8" />
    </svg>
  );
}
