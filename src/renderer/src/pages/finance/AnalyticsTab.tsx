import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Banknote, Boxes, HandCoins, Scale, ShoppingBag, Truck, Users, Wallet, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { FINANCE_METRICS } from '@shared/schemas';
import { DataTable, type Column } from '@/components/DataTable';
import { Card, Skeleton, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDate, formatDateTime, useMoney } from '@/lib/hooks';
import { PeriodChips, usePeriod } from './period';
import { useState } from 'react';

type Metric = (typeof FINANCE_METRICS)[number];
type Row = ApiResult<'finance.series'>['rows'][number];

const ICONS: Record<Metric, LucideIcon> = {
  salesRevenue: ShoppingBag,
  salesProfit: Scale,
  repairRevenue: Wrench,
  repairProfit: Wrench,
  serviceMargin: Zap,
  expenses: Wallet,
  salaries: Users,
  netProfit: Banknote,
};
const shortDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** KPI cards, then one chip per metric with its daily chart and the rows behind it. Everything follows the period. */
export function AnalyticsTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const state = usePeriod('month');
  const [metric, setMetric] = useState<Metric>('netProfit');
  const { period } = state;

  const summary = useQuery({ queryKey: ['finance', 'summary', period.from, period.to], queryFn: () => api('finance.summary', period) });
  const series = useQuery({ queryKey: ['finance', 'series', metric, period.from, period.to], queryFn: () => api('finance.series', { ...period, metric }) });
  const s = summary.data;

  const card = (m: Metric) => (
    <StatCard
      key={m}
      icon={ICONS[m]}
      label={t(`analytics.metrics.${m}`)}
      onClick={() => setMetric(m)}
      value={s ? <span className={m === 'netProfit' ? (s.netProfit >= 0 ? 'text-ok' : 'text-danger') : m === 'expenses' || m === 'salaries' ? 'text-danger' : ''}>{money(s[m])}</span> : '…'}
    />
  );

  const columns: Column<Row>[] =
    metric === 'netProfit'
      ? [
          { header: t('stock.purchases.date'), cell: (r) => formatDate(r.date, i18n.language) },
          { header: t('analytics.metrics.salesProfit'), align: 'end', cell: (r) => money(r.parts?.salesProfit ?? 0) },
          { header: t('analytics.metrics.repairProfit'), align: 'end', cell: (r) => money(r.parts?.repairProfit ?? 0) },
          { header: t('analytics.metrics.serviceMargin'), align: 'end', cell: (r) => money(r.parts?.serviceMargin ?? 0) },
          { header: t('analytics.metrics.expenses'), align: 'end', cell: (r) => money(-(r.parts?.expenses ?? 0)) },
          { header: t('analytics.metrics.salaries'), align: 'end', cell: (r) => money(-(r.parts?.salaries ?? 0)) },
          { header: t('analytics.metrics.netProfit'), align: 'end', cell: (r) => <b className={r.value >= 0 ? 'text-ok' : 'text-danger'}>{money(r.value)}</b> },
        ]
      : [
          { header: t('stock.purchases.date'), cell: (r) => (r.kind === 'EXPENSE' ? formatDate(r.date, i18n.language) : formatDateTime(r.date, i18n.language)) },
          { header: t('analytics.kind'), cell: (r) => t(`analytics.kinds.${r.kind}`) },
          { header: t('analytics.document'), cell: (r) => <span className="font-semibold">{r.label}</span> },
          { header: t('stock.supplier.notes'), cell: (r) => <span className="text-muted">{r.detail || '—'}</span> },
          { header: t('stock.payment.amount'), align: 'end', cell: (r) => <b className={r.value < 0 ? 'text-danger' : ''}>{money(r.value)}</b> },
        ];

  return (
    <div>
      <PeriodChips state={state} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FINANCE_METRICS.map(card)}
        <StatCard icon={Users} label={t('analytics.customerDebts')} value={s ? <span className="text-danger">{money(s.customerDebts)}</span> : '…'} onClick={() => navigate('/people?filter=debt')} />
        <StatCard icon={Truck} label={t('analytics.supplierDebts')} value={s ? <span className="text-danger">{money(s.supplierDebts)}</span> : '…'} onClick={() => navigate('/stock?tab=suppliers')} />
        <StatCard icon={Boxes} label={t('analytics.stockCost')} value={s ? money(s.stockValueCost) : '…'} hint={t('analytics.current')} onClick={() => navigate('/stock')} />
        <StatCard icon={HandCoins} label={t('analytics.stockSale')} value={s ? money(s.stockValueSale) : '…'} hint={t('analytics.current')} onClick={() => navigate('/stock')} />
      </div>

      <div role="tablist" className="mb-4 mt-6 flex flex-wrap gap-2">
        {FINANCE_METRICS.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={metric === m}
            onClick={() => setMetric(m)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${metric === m ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink'}`}
          >
            {t(`analytics.metrics.${m}`)}
          </button>
        ))}
      </div>

      <Card title={t(`analytics.metrics.${metric}`)} hint={t('analytics.chartHint')}>
        {!series.data ? (
          <Skeleton className="h-60" />
        ) : (
          <div className="h-60 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series.data.days} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke="var(--line)" />
                <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tickFormatter={(v: number) => money(v)} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={84} />
                <Tooltip
                  cursor={{ fill: 'var(--accent-soft)' }}
                  formatter={(v) => [money(Number(v)), t(`analytics.metrics.${metric}`)]}
                  labelFormatter={(day) => formatDate(String(day), i18n.language)}
                  contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--ink)' }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {series.data.days.map((d) => (
                    <Cell key={d.day} fill={metric === 'expenses' || metric === 'salaries' ? 'var(--danger)' : d.value < 0 ? 'var(--danger)' : metric === 'netProfit' ? 'var(--ok)' : 'var(--accent)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="mt-5">
        <DataTable rows={series.data?.rows} loading={series.isLoading} columns={columns} rowKey={(r) => `${r.kind}${r.id}`} onRowClick={(r) => r.link && navigate(r.link)} pageSize={15} emptyTitle={t('analytics.empty')} />
      </div>
    </div>
  );
}
