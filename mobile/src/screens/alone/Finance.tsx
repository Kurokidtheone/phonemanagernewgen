// Finance on a phone: the numbers of a period as cards, and one simple chart for the metric you pick.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FINANCE_METRICS } from '@shared/schemas';
import { ScreenHeader, useFormatMoney } from '@/components/common';
import { Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { Panel, periodRange } from './kit';

type Period = 'today' | 'week' | 'month';
type Metric = (typeof FINANCE_METRICS)[number];

/** One bar per day. Negative days hang below the line. */
function Bars({ data, money }: { data: { day: string; value: number }[]; money: (c: number) => string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const w = 320;
  const h = 120;
  const slot = w / Math.max(1, data.length);
  const mid = data.some((d) => d.value < 0) ? h / 2 : h;
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} className="w-full" role="img">
      <line x1="0" x2={w} y1={mid} y2={mid} stroke="currentColor" strokeOpacity="0.2" />
      {data.map((d, i) => {
        const bar = (Math.abs(d.value) / max) * (data.some((x) => x.value < 0) ? h / 2 - 4 : h - 4);
        const x = i * slot + slot * 0.15;
        return (
          <g key={d.day}>
            <rect x={x} y={d.value >= 0 ? mid - bar : mid} width={slot * 0.7} height={Math.max(bar, d.value === 0 ? 0 : 1)} rx="3" fill="var(--accent)" opacity={d.value < 0 ? 0.5 : 1}>
              <title>{`${d.day}: ${money(d.value)}`}</title>
            </rect>
            {data.length <= 10 && (
              <text x={x + slot * 0.35} y={h + 14} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.6">
                {d.day.slice(8, 10)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function FinanceScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const [period, setPeriod] = useState<Period>('month');
  const [metric, setMetric] = useState<Metric>('netProfit');
  const range = periodRange(period);
  const summary = useQuery({ queryKey: ['finance', 'summary', period], queryFn: () => api('finance.summary', range) });
  const series = useQuery({ queryKey: ['finance', 'series', period, metric], queryFn: () => api('finance.series', { ...range, metric }) });
  const s = summary.data;
  const chip = (active: boolean): string => `rounded-full px-4 py-2 text-sm ${active ? 'bg-accent text-[color:var(--on-action)]' : 'bg-accent-soft'}`;

  return (
    <div className="flex h-full flex-col" data-accent="pink">
      <ScreenHeader title={t('m.alone.finance')} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => Promise.all([summary.refetch(), series.refetch()])}>
          <div className="flex gap-2 px-4 py-3">
            {(['today', 'week', 'month'] as const).map((p) => (
              <button key={p} className={chip(period === p)} onClick={() => setPeriod(p)}>
                {t(`analytics.period.${p}`)}
              </button>
            ))}
          </div>
          {s && (
            <>
              <div className="mx-4 rounded-3xl bg-accent-soft p-4">
                <div className="text-sm text-muted">{t('analytics.metrics.netProfit')}</div>
                <div className={`text-3xl font-semibold tabular-nums ${s.netProfit < 0 ? 'text-danger' : ''}`}>{money(s.netProfit)}</div>
              </div>
              <Panel>
                {FINANCE_METRICS.filter((m) => m !== 'netProfit').map((m) => (
                  <Row key={m} title={t(`analytics.metrics.${m}`)} right={money(s[m])} onClick={() => setMetric(m)} />
                ))}
              </Panel>
              <Panel title={t('analytics.current')}>
                <Row title={t('analytics.customerDebts')} right={money(s.customerDebts)} />
                <Row title={t('analytics.supplierDebts')} right={money(s.supplierDebts)} />
                <Row title={t('analytics.stockCost')} right={money(s.stockValueCost)} />
                <Row title={t('analytics.stockSale')} right={money(s.stockValueSale)} />
              </Panel>
              <Panel title={t(`analytics.metrics.${metric}`)} hint={t('analytics.chartHint')}>
                <div className="mb-2 flex flex-wrap gap-2">
                  {FINANCE_METRICS.map((m) => (
                    <button key={m} className={chip(metric === m)} onClick={() => setMetric(m)}>
                      {t(`analytics.metrics.${m}`)}
                    </button>
                  ))}
                </div>
                {series.data && series.data.days.length > 0 ? <Bars data={series.data.days} money={money} /> : <div className="py-6 text-center text-muted">{t('analytics.empty')}</div>}
              </Panel>
            </>
          )}
        </Refreshable>
      </div>
    </div>
  );
}
