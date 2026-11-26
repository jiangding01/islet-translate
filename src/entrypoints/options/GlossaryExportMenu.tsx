import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { i18n } from '#i18n';
import { exportCsv, exportFileName, exportJson } from '@/lib/glossary/transfer';
import type { GlossaryEntry } from '@/lib/glossary/types';
import { ExportIcon } from './icons';
import styles from './options.module.css';

// The glossary export (M4-D): a small menu of two formats, saved as a download. The file holds
// the four fields of each entry and nothing else (transfer.ts).

/** Long enough for the download to have read the blob before its URL goes away. */
const REVOKE_DELAY_MS = 1000;

interface Props {
  entries: readonly GlossaryEntry[];
  disabled: boolean;
  /** Why it is disabled, when the reason is not obvious (a glossary from a newer build). */
  title?: string;
  onExported(): void;
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
}

function download(text: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** The menu button: Esc and an outside press close it, arrow keys move between the items. */
export function GlossaryExportMenu({ entries, disabled, title, onExported }: Props) {
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function save(format: 'csv' | 'json') {
    if (format === 'csv') {
      download(exportCsv(entries), 'text/csv;charset=utf-8', exportFileName('csv'));
    } else {
      download(exportJson(entries), 'application/json', exportFileName('json'));
    }
    close();
    onExported();
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const list = menuItems(menu.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') setOpen(false);
  }

  return (
    <div ref={wrap} className={styles.menuWrap}>
      <button
        ref={trigger}
        type="button"
        className={styles.addButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ExportIcon />
        {i18n.t('options.glossary.export')}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={i18n.t('options.glossary.export')}
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={styles.menuItem}
            onClick={() => save('csv')}
          >
            {i18n.t('options.glossary.exportCsv')}
            <span className={styles.menuSub}>{i18n.t('options.glossary.exportCsvSub')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={styles.menuItem}
            onClick={() => save('json')}
          >
            {i18n.t('options.glossary.exportJson')}
            <span className={styles.menuSub}>{i18n.t('options.glossary.exportJsonSub')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
