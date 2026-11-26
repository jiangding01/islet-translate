import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Result } from '@/lib/errors';
import { call } from '@/lib/messaging/handle';
import {
  type CacheStatsInfo,
  type ProviderTestDraft,
  type ProviderTestResult,
  type SecretProviderId,
  type SecretStatusInfo,
  sendMessage,
} from '@/lib/messaging/protocol';

// Background calls of the settings page. Every reply is a Result; nothing throws.

export const admin = {
  setSecret: (provider: SecretProviderId, key: string | null) =>
    call(() => sendMessage('secrets.set', { provider, key })),
  secretStatus: () => call(() => sendMessage('secrets.status', undefined)),
  test: (draft: ProviderTestDraft): Promise<Result<ProviderTestResult>> =>
    call(() => sendMessage('provider.test', draft)),
  cacheStats: (): Promise<Result<CacheStatsInfo>> =>
    call(() => sendMessage('cache.stats', undefined)),
  clearCache: () => call(() => sendMessage('cache.clear', undefined)),
};

export type SecretStatuses = Partial<Record<SecretProviderId, SecretStatusInfo>>;

/** Key status of every provider; `refresh` after any secrets.set. */
export function useSecretStatuses(): { statuses: SecretStatuses | undefined; refresh: () => void } {
  const [statuses, setStatuses] = useState<SecretStatuses>();
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++latest.current;
    const attempt = (retries: number) => {
      void admin.secretStatus().then((result) => {
        if (sequence !== latest.current) return;
        if (result.ok) setStatuses(result.data);
        // A failed latest read (SW waking up) would leave stale statuses: retry once.
        else if (retries > 0) setTimeout(() => attempt(retries - 1), 500);
      });
    };
    attempt(1);
  }, []);
  useEffect(() => refresh(), [refresh]);
  return { statuses, refresh };
}

/**
 * Where the focus goes once a dialog closes or a row goes away (M4 settings redesign): back
 * on the given element (the button that opened the dialog, the add button after a delete)
 * when it is still on the page and enabled, else on `fallback` (the section, tabIndex -1).
 * Applied after the render that made the change. The add button can also turn disabled a
 * moment later, when the storage update that fills the list arrives: pass `addDisabled` and
 * the focus moves on to the fallback before the browser drops it.
 */
export function useRefocus(
  fallback: RefObject<HTMLElement | null>,
  addButton: RefObject<HTMLButtonElement | null>,
  addDisabled: boolean,
): (element: HTMLElement | null) => void {
  const [target, setTarget] = useState<{ element: HTMLElement | null }>();
  useEffect(() => {
    if (!target) return;
    setTarget(undefined);
    const { element } = target;
    const disabled = element instanceof HTMLButtonElement && element.disabled;
    if (element?.isConnected && !disabled) element.focus();
    else fallback.current?.focus();
  }, [target, fallback]);
  useLayoutEffect(() => {
    if (addDisabled && document.activeElement === addButton.current) fallback.current?.focus();
  }, [addDisabled, addButton, fallback]);
  return useCallback((element: HTMLElement | null) => setTarget({ element }), []);
}
