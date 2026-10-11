import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Input } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayEndIso, dayStartIso, formatDateTime, today, useMoney } from '@/lib/hooks';

type Sale = ApiResult<'sales.list'>[number];
const STATUS_TONE = { COMPLETED: 'ok', PARTIALLY_RETURNED: 'accent', RETURNED: 'danger' } as const;

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function SalesHistoryTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const todayOnly = params.get('today') === '1'; // from the Overview
  // Opens on the last 90 days: a shop with years of sales does not load them all to look at today's. Clear the date to see everything.
  const [from, setFrom] = useState(todayOnly ? today() : daysAgo(90));
  const [to, setTo] = useState(todayOnly ? today() : '');
  const [employeeId, setEmployeeId] = useState('');
  const [unpaidOnly, setUnpaidOnly] = useState(false);

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api('employees.list') });
  const list = useQuery({
    queryKey: ['sales', 'list', from, to, employeeId, unpaidOnly],
    queryFn: () => api('sales.list', { from: from ? dayStartIso(from) : undefined, to: to ? dayEndIso(to) : undefined, employeeId: employeeId || undefined, unpaidOnly: unpaidOnly || undefined }),
  });

  const columns: Column<Sale>[] = [
    { header: t('sell.receipt.number'), cell: (r) => <span className="mono font-semibold" dir="ltr">{r.receiptNumber}</span> },
    { header: t('sell.receipt.date'), cell: (r) => formatDateTime(r.date, i18n.language) },
    { header: t('sell.customer'), cell: (r) => r.customerName ?? <span className="text-muted">—</span> },
    { header: t('sell.history.items'), cell: (r) => <span className="line-clamp-1 max-w-[260px]">{r.itemsSummary ?? '—'}</span> },
    { header: t('sell.total'), align: 'end', cell: (r) => <b>{money(r.total)}</b> },
    { header: t('sell.paid'), align: 'end', cell: (r) => money(r.paid) },
    { header: t('sell.remaining'), align: 'end', cell: (r) => <span className={r.remaining > 0 ? 'font-bold text-danger' : ''}>{money(r.remaining)}</span> },
    { header: t('sell.seller'), cell: (r) => r.employeeName ?? '—' },
    { header: t('sell.history.status'), cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{t(`sell.status.${r.status}`)}</Badge> },
  ];

  return (
    <DataTable
      rows={list.data}
      loading={list.isLoading}
      columns={columns}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/sell/sales/${r.id}`)}
      searchText={(r) => `${r.receiptNumber} ${r.customerName ?? ''} ${r.imeis ?? ''} ${r.itemsSummary ?? ''}`}
      searchPlaceholder={t('sell.history.search')}
      summary={(rows) => `${t('sell.total')}: ${money(rows.reduce((s, r) => s + r.total, 0))}`}
      emptyTitle={t('sell.history.empty')}
      note={(list.data?.length ?? 0) >= 5000 ? t('sell.history.limited') : undefined}
      emptyHint={t('sell.history.emptyHint')}
      filters={
        <>
          <label className="flex items-center gap-2 text-sm text-muted">
            {t('stock.purchases.from')}
            <Input type="date" dir="ltr" className="w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            {t('stock.purchases.to')}
            <Input type="date" dir="ltr" className="w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <select className="input w-auto" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label={t('sell.seller')}>
            <option value="">{t('sell.history.allSellers')}</option>
            {employees.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
            {t('sell.history.unpaidOnly')}
          </label>
        </>
      }
    />
  );
}
