import { useTranslation } from 'react-i18next';
import type { Language } from '@shared/app.config';
import { formatMoney } from '@shared/money';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { getState, useConnection } from './connection';

/** The shop's name: from the pairing on a connected phone, from Settings on a phone alone. */
export function useStoreName(): string {
  const { session, mode } = useConnection();
  const own = useQuery({ queryKey: ['settings'], queryFn: () => api('settings.get'), enabled: mode === 'standalone' }).data?.storeName;
  return (mode === 'standalone' ? own : session?.storeName) ?? '';
}

export function useMoney(): (centimes: number) => string {
  const { i18n } = useTranslation();
  return (centimes) => formatMoney(centimes, i18n.language as Language);
}

const locale = (lang: string): string => (lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang === 'fr' ? 'fr-FR' : 'en-GB');
export const formatDateTime = (iso: string, lang: string): string =>
  new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const formatDate = (iso: string, lang: string): string => new Date(iso).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' });

/** Lists refresh when the app comes back to the front and every 10 seconds while shown, in the shop. */
export const LIST_REFRESH_MS = 10_000;

/**
 * refetchInterval for a list screen. Outside the shop there is no timer at all, to spare mobile data and the free plan:
 * lists load when a screen opens, on pull to refresh and after the phone's own changes.
 */
export const listRefresh = (): number | false => (getState().route === 'remote' ? false : LIST_REFRESH_MS);
/** The same for the live stock count, which two phones watch together in the shop. */
export const countRefresh = (): number | false => (getState().route === 'remote' ? false : 5000);

/** Outside the shop the owner may have switched changes off: then the actions that write are hidden, not left to fail. */
export const useCanWrite = (): boolean => {
  const { route, remoteWrites } = useConnection();
  return route !== 'remote' || remoteWrites;
};
