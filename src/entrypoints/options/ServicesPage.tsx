import { useRef, useState } from 'react';
import { i18n } from '#i18n';
import {
  type ConfigV1,
  type CustomProviderId,
  type Engine,
  MAX_CUSTOM_PROVIDERS,
} from '@/lib/config/types';
import { useConfig } from '@/lib/config/use-config';
import { builtinName, engineEntries } from '@/lib/engine-view';
import { AddServiceDialog } from './AddServiceDialog';
import { CacheSection } from './CacheSection';
import { EngineItem } from './EngineItem';
import { useSecretStatuses } from './hooks';
import { PlusIcon } from './icons';
import { useNotice } from './notice';
import styles from './options.module.css';

export function ServicesPage({ config }: { config: ConfigV1 }) {
  const { patch } = useConfig();
  const notice = useNotice();
  const { statuses, refresh } = useSecretStatuses();
  const [expanded, setExpanded] = useState<Engine | undefined>(config.translation.engine);
  const [fresh, setFresh] = useState<CustomProviderId>();
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);

  const entries = engineEntries(config);
  const customIds = Object.keys(config.customProviders);
  const full = customIds.length >= MAX_CUSTOM_PROVIDERS;
  const firstCustom = entries.find((entry) => entry.custom)?.id;

  async function makeDefault(engine: Engine) {
    if (engine === config.translation.engine) return;
    const result = await patch([{ path: 'translation.engine', value: engine }]);
    if (result.ok) notice.saved(i18n.t('options.services.madeDefault'));
    else notice.failed(result.error);
  }

  async function remove(id: CustomProviderId) {
    const wasDefault = config.translation.engine === id;
    const result = await patch([{ path: 'customProviders', key: id, remove: true }]);
    if (!result.ok) {
      notice.failed(result.error, i18n.t('errors.action.deleteFailed'));
      return;
    }
    // The background deletes the provider's key; host grants are left alone, since
    // another provider may share the origin.
    setExpanded(undefined);
    notice.saved(
      wasDefault
        ? i18n.t('options.services.deletedFallback', [builtinName('google')])
        : i18n.t('options.services.deleted'),
    );
  }

  return (
    <>
      <section aria-labelledby="engines-title" className={styles.section}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitleRow}>
            <h2 id="engines-title" className={styles.sectionTitle}>
              {i18n.t('options.services.engines')}
            </h2>
            <span className={styles.headHint}>{i18n.t('options.services.enginesHint')}</span>
          </div>
          <button
            ref={addButton}
            type="button"
            className={styles.addButton}
            onClick={() => setAdding(true)}
            disabled={full}
            title={
              full
                ? i18n.t('options.services.limitReached', [String(MAX_CUSTOM_PROVIDERS)])
                : i18n.t('options.services.addTooltip')
            }
          >
            <PlusIcon />
            {i18n.t('options.services.addService')}
          </button>
        </div>

        <div className={styles.card}>
          {entries.map((entry) => (
            <div key={entry.id}>
              {entry.id === firstCustom && (
                <div className={styles.groupHead}>
                  <span>{i18n.t('options.services.customGroup')}</span>
                  <span>
                    {customIds.length} / {MAX_CUSTOM_PROVIDERS}
                  </span>
                </div>
              )}
              <EngineItem
                entry={entry}
                config={config}
                isDefault={config.translation.engine === entry.id}
                expanded={expanded === entry.id}
                fresh={fresh === entry.id}
                secret={entry.id === 'google' ? undefined : statuses?.[entry.id]}
                onToggle={() => {
                  setExpanded(expanded === entry.id ? undefined : entry.id);
                  // The highlight and the automatic test happen once, right after adding.
                  setFresh(undefined);
                }}
                onMakeDefault={() => void makeDefault(entry.id)}
                onSecretsChanged={refresh}
                onDelete={() => remove(entry.id as CustomProviderId)}
              />
            </div>
          ))}
        </div>
      </section>

      <CacheSection />

      <AddServiceDialog
        open={adding}
        origin={addButton.current}
        existingIds={customIds}
        onClose={() => setAdding(false)}
        onAdded={(id, granted) => {
          setAdding(false);
          setExpanded(id);
          setFresh(id);
          refresh();
          notice.saved(
            granted ? i18n.t('options.services.added') : i18n.t('options.services.addedPending'),
          );
        }}
      />
    </>
  );
}
