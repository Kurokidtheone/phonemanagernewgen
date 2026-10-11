import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Input } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayEndIso, dayStartIso, formatDate, useMoney } from '@/lib/hooks';
import { REPAIR_STATUSES, STATUS_TONE, type RepairStatus } from './shared';

type Ticket = ApiResult<'repairs.list'>[number];

export function TicketsTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [params] = useSearchParams(); // filters coming from the Overview
  const urlStatus = params.get('status');
  const [status, setStatus] = useState<RepairStatus | ''>((REPAIR_STATUSES as readonly string[]).includes(urlStatus ?? '') ? (urlStatus as RepairStatus) : '');
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');

  const technicians = useQuery({ queryKey: ['employees'], queryFn: () => api('employees.list') }).data;
  const list = useQuery({
    queryKey: ['repairs', 'list', status, employeeId, from, to, overdue],
    queryFn: () =>
      api('repairs.list', {
        status: status || undefined,
        employeeId: employeeId || undefined,
        from: from ? dayStartIso(from) : undefined,
        to: to ? dayEndIso(to) : undefined,
        overdue: overdue || undefined,
      }),
  });

  const columns: Column<Ticket>[] = [
    { header: t('customers.ticket'), cell: (r) => <span className="mono font-semibold" dir="ltr">{r.ticketNumber}</span> },
    {
      header: t('sell.customer'),
      cell: (r) => (
        <span>
          <span className="font-semibold">{r.customerName}</span>
          <span className="block text-xs text-muted" dir="ltr">{r.customerPhone}</span>
        </span>
      ),
    },
    { header: t('customers.device'), cell: (r) => [r.brand, r.model].filter(Boolean).join(' ') || '—' },
    { header: t('customers.fault'), cell: (r) => <span className="line-clamp-1 max-w-[220px] text-muted">{r.fault}</span> },
    { header: t('sell.history.status'), cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{t(`customers.repairStatus.${r.status}`)}</Badge> },
    { header: t('repairs.form.receivedOn'), cell: (r) => formatDate(r.receivedAt, i18n.language) },
    {
      header: t('repairs.form.dueDate'),
      cell: (r) => (r.dueAt ? <span className={r.overdue ? 'font-bold text-danger' : ''}>{formatDate(r.dueAt, i18n.language)}</span> : '—'),
    },
    { header: t('sell.price'), align: 'end', cell: (r) => money(r.finalPrice ?? r.estimatedPrice) },
  ];

  return (
    <DataTable
      rows={list.data}
      loading={list.isLoading}
      columns={columns}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/repairs/${r.id}`)}
      searchText={(r) => `${r.ticketNumber} ${r.customerName} ${r.customerPhone} ${r.imei ?? ''} ${r.brand} ${r.model}`}
      searchPlaceholder={t('repairs.search')}
      emptyTitle={t('repairs.empty')}
      emptyHint={t('repairs.emptyHint')}
      filters={
        <>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as RepairStatus | '')} aria-label={t('sell.history.status')}>
            <option value="">{t('repairs.allStatuses')}</option>
            {REPAIR_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`customers.repairStatus.${s}`)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label={t('repairs.form.technician')}>
            <option value="">{t('repairs.allTechnicians')}</option>
            {technicians?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-muted">
            {t('stock.purchases.from')}
            <Input type="date" dir="ltr" className="w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            {t('stock.purchases.to')}
            <Input type="date" dir="ltr" className="w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
            {t('repairs.overdueOnly')}
          </label>
        </>
      }
    />
  );
}
