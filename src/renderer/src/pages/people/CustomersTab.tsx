import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Button } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDate, useMoney } from '@/lib/hooks';
import { CustomerDialog } from './CustomerDialog';

type Row = ApiResult<'customer.list'>[number];

export function CustomersTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [params] = useSearchParams(); // filters coming from the Overview and Analytics
  const filter = params.get('filter');
  const [inDebt, setInDebt] = useState(filter === 'debt');
  const [overdue, setOverdue] = useState(filter === 'overdue');
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['customer', 'list', inDebt, overdue],
    queryFn: () => api('customer.list', { inDebt: inDebt || undefined, overdue: overdue || undefined }),
  });

  const columns: Column<Row>[] = [
    { header: t('sell.customerName'), cell: (r) => <span className="font-semibold">{r.name}</span> },
    { header: t('sell.customerPhone'), cell: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { header: t('customers.totalBought'), align: 'end', cell: (r) => money(r.totalBought) },
    {
      header: t('customers.debt'),
      align: 'end',
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          {r.overdue && <Badge tone="danger">{t('customers.overdue')}</Badge>}
          <span className={r.balance > 0 ? 'font-bold text-danger' : ''}>{money(r.balance)}</span>
        </span>
      ),
    },
    { header: t('customers.lastVisit'), cell: (r) => (r.lastVisit ? formatDate(r.lastVisit, i18n.language) : '—') },
  ];

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/people/customers/${r.id}`)}
        searchText={(r) => `${r.name} ${r.phone} ${r.whatsapp}`}
        searchPlaceholder={t('customers.search')}
        summary={(rows) => `${t('customers.totalDebt')}: ${money(rows.reduce((s, r) => s + Math.max(0, r.balance), 0))}`}
        emptyTitle={t('customers.empty')}
        emptyHint={t('customers.emptyHint')}
        filters={
          <>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={inDebt} onChange={(e) => setInDebt(e.target.checked)} />
              {t('customers.inDebt')}
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
              {t('customers.overdueOnly')}
            </label>
          </>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {t('customers.add')}
          </Button>
        }
      />
      {adding && <CustomerDialog onClose={() => setAdding(false)} />}
    </>
  );
}
