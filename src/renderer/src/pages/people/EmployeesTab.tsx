import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Button } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useMoney } from '@/lib/hooks';
import { EmployeeDialog } from './EmployeeDialog';

type Row = ApiResult<'employee.list'>[number];

export function EmployeesTab() {
  const { t } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['employee', 'list'], queryFn: () => api('employee.list') });

  const columns: Column<Row>[] = [
    { header: t('sell.customerName'), cell: (r) => <span className="font-semibold">{r.name}</span> },
    { header: t('employees.role'), cell: (r) => <Badge>{t(`employees.roles.${r.role}`, { defaultValue: r.role })}</Badge> },
    { header: t('sell.customerPhone'), cell: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { header: t('employees.monthlySalary'), align: 'end', cell: (r) => money(r.monthlySalary) },
    { header: t('employees.advances'), align: 'end', cell: (r) => <span className={r.advanceBalance > 0 ? 'font-bold text-danger' : ''}>{money(r.advanceBalance)}</span> },
  ];

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/people/employees/${r.id}`)}
        searchText={(r) => `${r.name} ${r.phone}`}
        searchPlaceholder={t('customers.search')}
        summary={(rows) => `${t('employees.totalAdvances')}: ${money(rows.reduce((s, r) => s + Math.max(0, r.advanceBalance), 0))}`}
        emptyTitle={t('employees.empty')}
        emptyHint={t('employees.emptyHint')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {t('employees.add')}
          </Button>
        }
      />
      {adding && <EmployeeDialog onClose={() => setAdding(false)} />}
    </>
  );
}
