// Small pieces the stand-alone screens share.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

/** A tinted panel, like a card on the home screen. */
export function Panel({ title, children, hint }: { title?: string; children: ReactNode; hint?: string }) {
  return (
    <section className="mx-4 my-3 rounded-3xl bg-card p-4">
      {title && <h3 className="mb-1 font-semibold">{title}</h3>}
      {hint && <p className="mb-2 text-sm text-muted">{hint}</p>}
      {children}
    </section>
  );
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/** The start and end of a period, as ISO times in UTC (what the PC's period channels take). */
export function periodRange(kind: 'today' | 'week' | 'month'): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (kind === 'week') start.setDate(start.getDate() - 6);
  if (kind === 'month') start.setDate(1);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Runs a change, shows a success message or the error in words, and refreshes what the screens show. */
export function useDo<TInput, TOut>(fn: (input: TInput) => Promise<TOut>, options: { success?: string; onDone?: (out: TOut) => void } = {}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => {
      if (options.success) toast(options.success);
      void client.invalidateQueries();
      options.onDone?.(out);
    },
    onError: (err) => toast(errorText(t, err)),
  });
}

export { api };
