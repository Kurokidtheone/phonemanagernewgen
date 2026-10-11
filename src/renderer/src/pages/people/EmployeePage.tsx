import { useQuery } from '@tanstack/react-query';
import { Banknote, HandCoins, Pencil, Plus, Trash2, UserRound, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Dialog';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Input, Skeleton, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayEndIso, dayStartIso, formatDate, formatDateTime, today, useAction, useMoney } from '@/lib/hooks';
import { EmployeeDialog } from './EmployeeDialog';
import { AdvanceDialog, PaySalaryDialog } from './EmployeeDialogs';

type Detail = ApiResult<'employee.get'>;
type Tab = 'payments' | 'advances' | 'activity';

const monthStart = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

export function EmployeePage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [tab, setTab] = useState<Tab>('payments');
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'advance' | 'delete' | null>(null);
  const query = useQuery({ queryKey: ['employee', 'get', id], queryFn: () => api('employee.get', { id }), retry: false });
  const remove = useAction(() => api('employee.delete', { id }), { success: t('employees.deleted'), invalidate: [['employee'], ['employees']], onDone: () => navigate('/people') });

  const back = { to: '/people', label: t('employees.back') };
  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={UserRound} title={t('employees.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  const data = query.data;
  if (!data) return <Skeleton className="m-8 h-64" />;
  const { employee, stats } = data;

  const salaryColumns: Column<Detail['salaries'][number]>[] = [
    { header: t('stock.purchases.date'), cell: (r) => (r.date ? formatDate(r.date, i18n.language) : '—') },
    { header: t('employees.paymentNote'), cell: (r) => r.note || '—' },
    { header: t('sell.method'), cell: (r) => t(`sell.methods.${r.method}`, { defaultValue: r.method }) },
    { header: t('employees.salaryAmount'), align: 'end', cell: (r) => money(r.amount) },
    { header: t('employees.deducted'), align: 'end', cell: (r) => (r.deducted ? `-${money(r.deducted)}` : '—') },
    { header: t('employees.netPaid'), align: 'end', cell: (r) => <b>{money(r.amount - r.deducted)}</b> },
  ];
  const advanceColumns: Column<Detail['advances'][number]>[] = [
    { header: t('stock.purchases.date'), cell: (r) => (r.date ? formatDate(r.date, i18n.language) : '—') },
    { header: t('employees.paymentNote'), cell: (r) => r.note || '—' },
    { header: t('employees.advanceType'), cell: (r) => <Badge tone={r.type === 'ADVANCE' ? 'danger' : 'ok'}>{t(`employees.advanceKind.${r.type === 'ADVANCE' ? 'GIVE' : 'REPAY'}`)}</Badge> },
    { header: t('stock.payment.amount'), align: 'end', cell: (r) => <b>{r.type === 'ADVANCE' ? '+' : '-'}{money(r.amount)}</b> },
  ];

  return (
    <PageBody>
      <PageHeader
        icon={UserRound}
        title={employee.name}
        subtitle={[t(`employees.roles.${employee.role}`, { defaultValue: employee.role }), employee.phone].filter(Boolean).join(' · ')}
        back={back}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={Plus} onClick={() => setDialog('pay')}>{t('employees.paySalary')}</Button>
            <Button icon={HandCoins} onClick={() => setDialog('advance')}>{t('employees.addAdvance')}</Button>
            <Button icon={Pencil} onClick={() => setDialog('edit')}>{t('common.edit')}</Button>
            <Button icon={Trash2} className="text-danger" onClick={() => setDialog('delete')}>{t('common.delete')}</Button>
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard icon={Wallet} label={t('employees.monthlySalary')} value={money(employee.monthlySalary)} />
        <StatCard icon={HandCoins} label={t('employees.advances')} value={<span className={stats.advanceBalance > 0 ? 'text-danger' : ''}>{money(stats.advanceBalance)}</span>} />
        <StatCard icon={Banknote} label={t('employees.paidThisYear')} value={money(stats.totalPaidThisYear)} />
      </div>
      <SubTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'payments', label: t('employees.tabPayments') },
          { id: 'advances', label: t('employees.tabAdvances') },
          { id: 'activity', label: t('employees.tabActivity') },
        ]}
      />
      {tab === 'payments' && <DataTable rows={data.salaries} columns={salaryColumns} rowKey={(r) => r.id} emptyTitle={t('employees.noPayments')} />}
      {tab === 'advances' && <DataTable rows={data.advances} columns={advanceColumns} rowKey={(r) => r.id} emptyTitle={t('employees.noAdvances')} />}
      {tab === 'activity' && <Activity employeeId={id} />}

      {dialog === 'edit' && <EmployeeDialog employee={employee} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <PaySalaryDialog employeeId={id} name={employee.name} monthlySalary={employee.monthlySalary} advanceBalance={stats.advanceBalance} onClose={() => setDialog(null)} />}
      {dialog === 'advance' && <AdvanceDialog employeeId={id} name={employee.name} balance={stats.advanceBalance} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog title={t('employees.deleteTitle')} body={t('employees.deleteBody')} confirmLabel={t('common.delete')} busy={remove.isPending} onConfirm={() => remove.mutate(undefined)} onClose={() => setDialog(null)} />
      )}
    </PageBody>
  );
}

/** Sales and repairs done in a period, with profit and commission while Finance is open. */
function Activity({ employeeId }: { employeeId: string }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const query = useQuery({ queryKey: ['employee', 'activity', employeeId, from, to], queryFn: () => api('employee.activity', { id: employeeId, from: dayStartIso(from), to: dayEndIso(to) }) });
  const a = query.data;
  const pct = (bp: number): string => `${bp / 100}%`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          {t('stock.purchases.from')}
          <Input type="date" dir="ltr" className="w-auto" value={from} onChange={(e) => setFrom(e.target.value || monthStart())} />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          {t('stock.purchases.to')}
          <Input type="date" dir="ltr" className="w-auto" value={to} max={today()} onChange={(e) => setTo(e.target.value || today())} />
        </label>
      </div>
      {!a ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t('employees.salesDone')} value={a.totals.salesCount} hint={money(a.totals.salesTotal)} />
            <StatCard label={t('employees.repairsDone')} value={a.totals.repairsCount} hint={money(a.totals.repairsTotal)} />
            <StatCard label={t('employees.profitGenerated')} value={a.totals.salesProfit === null ? '—' : money((a.totals.salesProfit ?? 0) + (a.totals.repairsProfit ?? 0))} hint={a.totals.salesProfit === null ? t('employees.profitLocked') : `${t('tabs.sell.newSale')}: ${money(a.totals.salesProfit ?? 0)} · ${t('sections.repairs')}: ${money(a.totals.repairsProfit ?? 0)}`} />
            <StatCard
              label={t('employees.commissionDue')}
              value={a.totals.commission === null ? '—' : money(a.totals.commission)}
              hint={a.totals.commission === null ? t('employees.profitLocked') : t('employees.commissionRates', { sales: pct(a.rates.sales), repairs: pct(a.rates.repairs) })}
            />
          </div>
          <p className="text-xs text-muted">{t('employees.commissionInfo')}</p>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={t('tabs.sell.history')}>
              {a.sales.length === 0 ? (
                <p className="text-sm text-muted">{t('sell.history.empty')}</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {a.sales.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="flex w-full items-center justify-between gap-2 py-2 text-start hover:text-accent" onClick={() => navigate(`/sell/sales/${s.id}`)}>
                        <span><span className="mono font-semibold" dir="ltr">{s.receiptNumber}</span> <span className="text-xs text-muted">{formatDateTime(s.date, i18n.language)}</span></span>
                        <span><b>{money(s.total)}</b>{s.profit !== null && <span className="ms-2 text-ok">{money(s.profit)}</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={t('sections.repairs')}>
              {a.repairs.length === 0 ? (
                <p className="text-sm text-muted">{t('repairs.empty')}</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {a.repairs.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="flex w-full items-center justify-between gap-2 py-2 text-start hover:text-accent" onClick={() => navigate(`/repairs/${r.id}`)}>
                        <span><span className="mono font-semibold" dir="ltr">{r.ticket}</span> <span className="text-xs text-muted">{[r.brand, r.model].filter(Boolean).join(' ')}</span></span>
                        <span><b>{money(r.price)}</b>{r.profit !== null && <span className="ms-2 text-ok">{money(r.profit)}</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
