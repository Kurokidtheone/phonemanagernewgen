import { useQuery } from '@tanstack/react-query';
import { Percent, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Dialog';
import { QuickSale } from '@/components/QuickSale';
import { Input, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayEndIso, dayStartIso, today, useAction, useMoney } from '@/lib/hooks';

type Row = ApiResult<'services.sales'>['rows'][number];

/** Quick sale, and the services sold on a day with their totals and margin. */
export function ServicesTab() {
  const { t } = useTranslation();
  const money = useMoney();
  const [day, setDay] = useState(today());
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['services', 'sales', day], queryFn: () => api('services.sales', { from: dayStartIso(day), to: dayEndIso(day) }) });
  const remove = useAction((id: string) => api('services.deleteSale', { id }), { success: t('services.deleted'), invalidate: [['services'], ['cash']], onDone: () => setDeleting(null) });
  const data = list.data;

  const columns: Column<Row>[] = [
    { header: t('cash.time'), width: '90px', cell: (r) => new Date(r.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
    { header: t('services.service'), cell: (r) => <span className="font-semibold">{r.serviceName}</span> },
    { header: t('services.phone'), cell: (r) => <span dir="ltr">{r.phoneNumber ?? '—'}</span> },
    { header: t('services.amount'), align: 'end', cell: (r) => <b>{money(r.amount)}</b> },
    { header: t('services.margin'), align: 'end', cell: (r) => <span className="text-ok">{money(r.margin)}</span> },
    {
      header: '',
      width: '60px',
      align: 'end',
      cell: (r) => (
        <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" aria-label={t('common.delete')} onClick={() => setDeleting(r.id)}>
          <Trash2 size={16} />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <QuickSale withOthers />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          {t('services.day')}
          <Input type="date" dir="ltr" className="w-auto" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard icon={Zap} label={t('services.count')} value={data?.rows.length ?? 0} />
        <StatCard icon={Zap} label={t('services.amount')} value={money(data?.totalAmount ?? 0)} />
        <StatCard icon={Percent} label={t('services.margin')} value={<span className="text-ok">{money(data?.totalMargin ?? 0)}</span>} />
      </div>
      <DataTable rows={data?.rows} loading={list.isLoading} columns={columns} rowKey={(r) => r.id} emptyTitle={t('services.empty')} emptyHint={t('services.emptyHint')} />
      {deleting && (
        <ConfirmDialog title={t('services.deleteTitle')} body={t('services.deleteBody')} confirmLabel={t('common.delete')} busy={remove.isPending} onConfirm={() => remove.mutate(deleting)} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}
