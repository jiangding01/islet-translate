import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { i18n } from '#i18n';
import { useConfig } from '@/lib/config/use-config';
import { describeError } from '@/lib/error-messages';
import { useTheme } from '@/styles/theme';
import { GeneralPage } from './GeneralPage';
import { GlossaryPage } from './GlossaryPage';
import { NoticeLine, NoticeProvider, useNoticeState } from './notice';
import styles from './options.module.css';
import { ServicesPage } from './ServicesPage';
import { StylesPage } from './StylesPage';

type Page = 'general' | 'services' | 'styles' | 'glossary';

// Key table only: the copy is looked up at render (tests switch the UI language per case).
const PAGES = [
  { id: 'general', title: 'options.nav.general', sub: 'options.nav.generalSub' },
  { id: 'services', title: 'options.nav.services', sub: 'options.nav.servicesSub' },
  { id: 'styles', title: 'options.nav.styles', sub: 'options.nav.stylesSub' },
  { id: 'glossary', title: 'options.nav.glossary', sub: 'options.nav.glossarySub' },
] as const satisfies { id: Page; title: string; sub: string }[];

/**
 * Opens on the general page; `#services` when the caller came for the engines (the popup's
 * "去设置" next to an engine problem), `#styles` for the translation styles, `#glossary` for the
 * glossary (the sidebar links switch pages through the hash too). Exported for tests.
 */
export function pageFromHash(hash = location.hash): Page {
  if (hash === '#services') return 'services';
  if (hash === '#styles') return 'styles';
  if (hash === '#glossary') return 'glossary';
  return 'general';
}

const NAV_ICONS = {
  general: GearIcon,
  services: TranslateIcon,
  styles: PaletteIcon,
  glossary: BookIcon,
} as const satisfies Record<Page, () => React.JSX.Element>;

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
            {PAGES.map(({ id, ...item }) => {
              const Icon = NAV_ICONS[id];
              return (
                <a
                  key={id}
                  href={`#${id}`}
                  className={styles.navItem}
                  aria-current={id === page ? 'page' : undefined}
                >
                  <Icon />
                  {i18n.t(item.title)}
                </a>
              );
            })}
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
            {state.status === 'ready' && page === 'general' && (
              <GeneralPage config={state.snapshot.data} />
            )}
            {state.status === 'ready' && page === 'services' && (
              <ServicesPage config={state.snapshot.data} />
            )}
            {state.status === 'ready' && page === 'styles' && (
              <StylesPage config={state.snapshot.data} />
            )}
            {state.status === 'ready' && page === 'glossary' && (
              <GlossaryPage config={state.snapshot.data} />
            )}
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

function PaletteIcon() {
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
      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.5-.6 1.5-1.3 0-.9-.8-1.2-.8-2 0-.8.6-1.3 1.5-1.3h1.6c1.7 0 2.4-1.2 2.4-2.6C14.2 4.3 11.4 1.8 8 1.8z" />
      <circle cx="4.9" cy="7.4" r=".8" />
      <circle cx="7" cy="4.7" r=".8" />
      <circle cx="10.3" cy="5" r=".8" />
    </svg>
  );
}

function BookIcon() {
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
      <path d="M2.5 3.2c1.9-.7 3.8-.6 5.5.6v9.6c-1.7-1.2-3.6-1.3-5.5-.6z" />
      <path d="M13.5 3.2c-1.9-.7-3.8-.6-5.5.6v9.6c1.7-1.2 3.6-1.3 5.5-.6z" />
    </svg>
  );
}
