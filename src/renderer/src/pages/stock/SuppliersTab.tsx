import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Button } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useMoney } from '@/lib/hooks';
import { SupplierDialog } from './SupplierDialog';

type Supplier = ApiResult<'suppliers.list'>[number];

export function SuppliersTab() {
  const { t } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['suppliers', 'list'], queryFn: () => api('suppliers.list') });

  const columns: Column<Supplier>[] = [
    {
      header: t('stock.supplier.name'),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-semibold">{r.name}</span>
          {r.kind === 'INDIVIDUAL' && <Badge>{t('stock.supplier.INDIVIDUAL')}</Badge>}
        </span>
      ),
    },
    { header: t('stock.supplier.phone'), cell: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { header: t('stock.supplier.balance'), align: 'end', cell: (r) => <span className={r.balance > 0 ? 'font-bold text-danger' : 'font-semibold'}>{money(r.balance)}</span> },
  ];

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/stock/suppliers/${r.id}`)}
        searchText={(r) => `${r.name} ${r.phone}`}
        summary={(rows) => `${t('stock.supplier.totalOwed')}: ${money(rows.reduce((s, r) => s + Math.max(0, r.balance), 0))}`}
        emptyTitle={t('stock.supplier.empty')}
        emptyHint={t('stock.supplier.emptyHint')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {t('stock.supplier.add')}
          </Button>
        }
      />
      {adding && <SupplierDialog onClose={() => setAdding(false)} />}
    </>
  );
}
