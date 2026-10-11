import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui';
import { dayEndIso, dayStartIso, today } from '@/lib/hooks';

export type PeriodId = 'today' | 'week' | 'month' | 'custom';

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthStart = (): string => `${today().slice(0, 7)}-01`;

/** Period chips: Today, Last 7 days, This month, Custom range. Gives ISO instants for the queries. */
export function usePeriod(initial: PeriodId = 'month') {
  const [id, setId] = useState<PeriodId>(initial);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const days: [string, string] = id === 'today' ? [today(), today()] : id === 'week' ? [daysAgo(6), today()] : id === 'month' ? [monthStart(), today()] : [from <= to ? from : to, to];
  return { id, setId, from, to, setFrom, setTo, period: { from: dayStartIso(days[0]), to: dayEndIso(days[1]) }, days };
}

export function PeriodChips({ state }: { state: ReturnType<typeof usePeriod> }) {
  const { t } = useTranslation();
  const chips: PeriodId[] = ['today', 'week', 'month', 'custom'];
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => state.setId(c)}
          aria-pressed={state.id === c}
          className={`rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition ${state.id === c ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink'}`}
        >
          {t(`analytics.period.${c}`)}
        </button>
      ))}
      {state.id === 'custom' && (
        <>
          <Input type="date" dir="ltr" className="w-auto" value={state.from} max={today()} onChange={(e) => state.setFrom(e.target.value || today())} aria-label={t('stock.purchases.from')} />
          <span className="text-muted">→</span>
          <Input type="date" dir="ltr" className="w-auto" value={state.to} max={today()} onChange={(e) => state.setTo(e.target.value || today())} aria-label={t('stock.purchases.to')} />
        </>
      )}
    </div>
  );
}
