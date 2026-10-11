import { useQuery } from '@tanstack/react-query';
import { Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Button, Input } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayEndIso, dayStartIso, formatDate, useMoney } from '@/lib/hooks';
import { BuyBackDialog } from './BuyBackDialog';
import { PurchaseDialog } from './PurchaseDialog';

type Purchase = ApiResult<'purchases.list'>[number];

export function PurchasesTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [supplierId, setSupplierId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);

  const suppliers = useQuery({ queryKey: ['suppliers', 'list'], queryFn: () => api('suppliers.list') });
  const list = useQuery({
    queryKey: ['purchases', 'list', supplierId, from, to],
    queryFn: () => api('purchases.list', { supplierId: supplierId || undefined, from: from ? dayStartIso(from) : undefined, to: to ? dayEndIso(to) : undefined }),
  });

  const columns: Column<Purchase>[] = [
    { header: t('stock.purchases.date'), cell: (r) => formatDate(r.date, i18n.language) },
    {
      header: t('stock.purchases.supplier'),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-semibold">{r.supplierName}</span>
          {r.cancelledAt && <Badge tone="danger">{t('stock.purchases.cancelled')}</Badge>}
        </span>
      ),
    },
    { header: t('stock.purchases.lines'), align: 'end', cell: (r) => r.lineCount },
    { header: t('stock.purchases.total'), align: 'end', cell: (r) => money(r.total) },
    { header: t('stock.purchases.paid'), align: 'end', cell: (r) => money(r.paid) },
    { header: t('stock.purchases.remaining'), align: 'end', cell: (r) => <span className={r.remaining > 0 ? 'font-bold text-danger' : ''}>{money(r.remaining)}</span> },
  ];

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpen(r.id)}
        searchText={(r) => r.supplierName}
        searchPlaceholder={t('stock.purchases.search')}
        summary={(rows) => `${t('stock.purchases.total')}: ${money(rows.filter((r) => !r.cancelledAt).reduce((s, r) => s + r.total, 0))}`}
        emptyTitle={t('stock.purchases.empty')}
        emptyHint={t('stock.purchases.emptyHint')}
        filters={
          <>
            <select className="input w-auto" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label={t('stock.purchases.supplier')}>
              <option value="">{t('stock.purchases.allSuppliers')}</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
          </>
        }
        actions={
          <>
            <Button icon={UserRound} onClick={() => setBuying(true)}>
              {t('stock.buyBack.open')}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => navigate('/stock/purchases/new')}>
              {t('stock.purchases.new')}
            </Button>
          </>
        }
      />
      {open && <PurchaseDialog id={open} onClose={() => setOpen(null)} />}
      {buying && <BuyBackDialog onClose={() => setBuying(false)} />}
    </>
  );
}
