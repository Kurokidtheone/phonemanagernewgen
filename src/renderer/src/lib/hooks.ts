import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Language } from '@shared/app.config';
import { formatMoney } from '@shared/money';
import { api, errorText } from './api';
import { toast } from './toast';

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api('settings.get') });
export const useAuth = () => useQuery({ queryKey: ['auth'], queryFn: () => api('auth.status') });
export const useLicense = () => useQuery({ queryKey: ['license'], queryFn: () => api('license.status') });

/**
 * True when costs and profit may be shown: the Finance section is not locked right now.
 * (The main process already leaves the figures out of what it sends; this keeps the empty columns away too.)
 */
export function useFinanceVisible(): boolean {
  const auth = useAuth().data;
  const settings = useSettings().data;
  if (!auth || !settings) return false;
  const locked = auth.hasPassword && !auth.unlocked && auth.protectedSections.includes('finance');
  return !(settings.hideCostWhenLocked && locked);
}

/** A mutation that toasts success or the translated error, then refreshes the given queries. */
export function useAction<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  options: { success?: string; invalidate?: QueryKey[]; onDone?: (result: TResult) => void } = {},
) {
  const { t } = useTranslation();
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      if (options.success) toast.ok(options.success);
      for (const key of options.invalidate ?? []) void client.invalidateQueries({ queryKey: key });
      options.onDone?.(result);
    },
    onError: (err) => {
      toast.error(errorText(t, err));
      void client.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

export function useMoney(): (centimes: number, opts?: { decimals?: boolean }) => string {
  const { i18n } = useTranslation();
  return (centimes, opts) => formatMoney(centimes, i18n.language as Language, opts);
}

export function formatDate(iso: string, lang: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang === 'fr' ? 'fr-FR' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * USB barcode and QR scanners type very fast and end with Enter.
 * Calls onScan with the code, wherever the focus is. Normal typing is ignored.
 */
export function useScanner(onScan: (code: string) => void, minLength = 6): void {
  const handler = useRef(onScan);
  handler.current = onScan;
  useEffect(() => {
    let buffer = '';
    let last = 0;
    const onKey = (e: KeyboardEvent): void => {
      const nowMs = performance.now();
      if (nowMs - last > 50) buffer = '';
      last = nowMs;
      if (e.key === 'Enter') {
        if (buffer.length >= minLength) {
          e.preventDefault();
          handler.current(buffer);
        }
        buffer = '';
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [minLength]);
}

/** A picked day (YYYY-MM-DD) as an ISO instant: now if it is today, otherwise local noon of that day. */
export const dayToIso = (day: string): string => (day === today() ? new Date().toISOString() : new Date(`${day}T12:00:00`).toISOString());
export const dayStartIso = (day: string): string => new Date(`${day}T00:00:00`).toISOString();
export const dayEndIso = (day: string): string => new Date(`${day}T23:59:59.999`).toISOString();
/** An ISO instant as the local YYYY-MM-DD, for date inputs. */
export const isoToDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
