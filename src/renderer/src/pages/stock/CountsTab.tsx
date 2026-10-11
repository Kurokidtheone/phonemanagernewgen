// Stock counts made with the phones, read only. The owner applies a count from a phone.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/DataTable';
import { Dialog } from '@/components/Dialog';
import { Badge } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDateTime, useMoney } from '@/lib/hooks';

type Count = ApiResult<'stockCount.list'>[number];

export function CountsTab() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<Count | null>(null);
  const list = useQuery({ queryKey: ['counts', 'list'], queryFn: () => api('stockCount.list') });
  const scope = (c: Count): string => t(`stock.counts.scopes.${c.scope}`, { name: c.categoryName ?? '' });

  const columns: Column<Count>[] = [
    { header: t('stock.counts.date'), cell: (r) => formatDateTime(r.startedAt, i18n.language) },
    { header: t('stock.counts.scope'), cell: scope },
    { header: t('stock.counts.by'), cell: (r) => r.startedBy ?? t('stock.counts.desktop') },
    {
      header: t('stock.counts.status'),
      cell: (r) => (r.status === 'OPEN' ? <Badge tone="accent">{t('stock.counts.open')}</Badge> : <Badge tone={r.applied ? 'ok' : 'neutral'}>{r.applied ? t('stock.counts.applied') : t('stock.counts.closed')}</Badge>),
    },
    { header: t('stock.counts.counted'), align: 'end', cell: (r) => r.counted },
    { header: t('stock.counts.missing'), align: 'end', cell: (r) => <span className={r.missing > 0 ? 'font-bold text-danger' : ''}>{r.missing}</span> },
    { header: t('stock.counts.unexpected'), align: 'end', cell: (r) => r.unexpected },
    { header: t('stock.counts.differences'), align: 'end', cell: (r) => r.differences },
  ];

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        searchText={(r) => `${scope(r)} ${r.startedBy ?? ''}`}
        searchPlaceholder={t('stock.counts.search')}
        emptyTitle={t('stock.counts.empty')}
        emptyHint={t('stock.counts.emptyHint')}
      />
      {open && <CountDetail count={open} title={t('stock.counts.detail', { date: formatDateTime(open.startedAt, i18n.language) })} onClose={() => setOpen(null)} />}
    </>
  );
}

function CountDetail({ count, title, onClose }: { count: Count; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const result = useQuery({ queryKey: ['counts', 'get', count.id], queryFn: () => api('stockCount.get', { id: count.id }) });
  const r = result.data;
  const unitName = (u: { name: string; storage: string; color: string; imei: string | null }): string => `${[u.name, u.storage, u.color].filter(Boolean).join(' ')} · ${u.imei ?? ''}`;
  return (
    <Dialog title={title} hint={t(`stock.counts.scopes.${count.scope}`, { name: count.categoryName ?? '' })} onClose={onClose} wide>
      {r && (
        <div className="space-y-5 text-sm">
          <section>
            <h3 className="mb-1 font-semibold">{t('stock.counts.missingPhones')}</h3>
            {r.missing.length === 0 ? (
              <p className="text-muted">{t('stock.counts.none')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {r.missing.map((u) => (
                  <li key={u.id} className="flex justify-between gap-3 py-1.5">
                    <span dir="auto">{unitName(u)}</span>
                    <span className="flex items-center gap-2">
                      {u.decision && <Badge>{t(`stock.counts.decisions.${u.decision}`)}</Badge>}
                      {u.cost !== null && money(u.cost)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {r.missingCost !== null && r.missing.length > 0 && (
              <p className="mt-1 text-end font-semibold">
                {t('stock.counts.totalCost')}: {money(r.missingCost)}
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-semibold">{t('stock.counts.unexpectedScans')}</h3>
            {r.unexpected.length === 0 ? (
              <p className="text-muted">{t('stock.counts.none')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {r.unexpected.map((u, i) => (
                  <li key={i} className="flex justify-between gap-3 py-1.5">
                    <span dir="auto">{u.unit ? unitName(u.unit) : u.code}</span>
                    <span className="text-muted">{t(`stock.counts.reasons.${u.reason}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-semibold">{t('stock.counts.itemDiffs')}</h3>
            {r.differences.length === 0 ? (
              <p className="text-muted">{t('stock.counts.none')}</p>
            ) : (
              <table className="w-full">
                <thead className="text-muted">
                  <tr>
                    <th className="text-start font-medium">{t('stock.items.name')}</th>
                    <th className="text-end font-medium">{t('stock.counts.system')}</th>
                    <th className="text-end font-medium">{t('stock.counts.countedQty')}</th>
                    <th className="text-end font-medium">{t('stock.counts.diff')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.differences.map((d) => (
                    <tr key={d.productId} className="border-t border-line">
                      <td className="py-1.5">{d.name}</td>
                      <td className="text-end">{d.system}</td>
                      <td className="text-end">{d.counted}</td>
                      <td className="text-end font-semibold text-danger">{d.difference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.differenceCost !== null && r.differences.length > 0 && (
              <p className="mt-1 text-end font-semibold">
                {t('stock.counts.diffCost')}: {money(r.differenceCost)}
              </p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
