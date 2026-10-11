import { useQuery } from '@tanstack/react-query';
import { Banknote, Pencil, Plus, ShoppingBag, Trash2, Truck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { PageBody, PageHeader } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Field, Input, MoneyInput, Skeleton, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { dayToIso, formatDate, today, useAction, useMoney } from '@/lib/hooks';
import { PurchaseDialog } from './PurchaseDialog';
import { SupplierDialog } from './SupplierDialog';

type Detail = ApiResult<'suppliers.get'>;
const METHODS = ['CASH', 'BANK', 'OTHER'] as const;

export function SupplierPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'delete' | null>(null);
  const [openPurchase, setOpenPurchase] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['suppliers', 'get', id], queryFn: () => api('suppliers.get', { id }), retry: false });
  const remove = useAction(() => api('suppliers.delete', { id }), { success: t('stock.supplier.deleted'), invalidate: [['suppliers']], onDone: () => navigate('/stock?tab=suppliers') });

  const back = { to: '/stock?tab=suppliers', label: t('stock.supplier.back') };
  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={Truck} title={t('stock.supplier.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  const data = query.data;
  if (!data) return <Skeleton className="m-8 h-64" />;
  const { supplier, totals } = data;

  const purchaseColumns: Column<Detail['purchases'][number]>[] = [
    { header: t('stock.purchases.date'), cell: (r) => formatDate(r.date, i18n.language) },
    { header: t('stock.purchases.lines'), cell: (r) => r.lineCount },
    { header: t('stock.purchases.total'), align: 'end', cell: (r) => money(r.total) },
    { header: t('stock.purchases.paid'), align: 'end', cell: (r) => money(r.paid) },
    { header: t('stock.purchases.status'), cell: (r) => (r.cancelledAt ? <Badge tone="danger">{t('stock.purchases.cancelled')}</Badge> : null) },
  ];
  const paymentColumns: Column<Detail['payments'][number]>[] = [
    { header: t('stock.purchases.date'), cell: (r) => formatDate(r.date, i18n.language) },
    { header: t('stock.payment.method'), cell: (r) => t(`stock.payment.${r.method}`) },
    { header: t('stock.supplier.notes'), cell: (r) => <span className="text-muted">{r.note || '—'}</span> },
    { header: t('stock.payment.amount'), align: 'end', cell: (r) => <b>{money(r.amount)}</b> },
  ];

  return (
    <PageBody>
      <PageHeader
        icon={Truck}
        title={supplier.name}
        subtitle={[supplier.kind === 'INDIVIDUAL' ? t('stock.supplier.INDIVIDUAL') : null, supplier.phone].filter(Boolean).join(' · ')}
        back={back}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={Plus} onClick={() => setDialog('pay')}>{t('stock.payment.add')}</Button>
            <Button icon={Pencil} onClick={() => setDialog('edit')}>{t('common.edit')}</Button>
            <Button icon={Trash2} className="text-danger" onClick={() => setDialog('delete')}>{t('common.delete')}</Button>
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard icon={ShoppingBag} label={t('stock.supplier.totalPurchased')} value={money(totals.purchased)} />
        <StatCard icon={Banknote} label={t('stock.supplier.totalPaid')} value={money(totals.paid)} />
        <StatCard icon={Wallet} label={t('stock.supplier.balance')} value={<span className={totals.balance > 0 ? 'text-danger' : ''}>{money(totals.balance)}</span>} />
      </div>
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-lg font-bold">{t('stock.supplier.purchases')}</h2>
          <DataTable rows={data.purchases} columns={purchaseColumns} rowKey={(r) => r.id} onRowClick={(r) => setOpenPurchase(r.id)} emptyTitle={t('stock.purchases.empty')} />
        </section>
        <section>
          <h2 className="mb-2 text-lg font-bold">{t('stock.supplier.payments')}</h2>
          <DataTable rows={data.payments} columns={paymentColumns} rowKey={(r) => r.id} emptyTitle={t('stock.payment.empty')} />
        </section>
      </div>

      {dialog === 'edit' && <SupplierDialog supplier={{ ...supplier, ...totals }} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <PaymentDialog supplierId={id} balance={totals.balance} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog title={t('stock.supplier.deleteTitle')} body={t('stock.supplier.deleteBody')} confirmLabel={t('common.delete')} busy={remove.isPending} onConfirm={() => remove.mutate(undefined)} onClose={() => setDialog(null)} />
      )}
      {openPurchase && <PurchaseDialog id={openPurchase} onClose={() => setOpenPurchase(null)} />}
    </PageBody>
  );
}

function PaymentDialog({ supplierId, balance, onClose }: { supplierId: string; balance: number; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const [amount, setAmount] = useState<number | null>(balance > 0 ? balance : null);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [note, setNote] = useState('');
  const save = useAction(() => api('suppliers.addPayment', { supplierId, amount: amount ?? 0, date: dayToIso(date), method, note }), {
    success: t('stock.payment.saved'),
    invalidate: [['suppliers']],
    onDone: onClose,
  });
  return (
    <Dialog title={t('stock.payment.add')} hint={t('stock.payment.owed', { amount: money(balance) })} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !amount}>
      <Field label={t('stock.payment.amount')} required>
        <MoneyInput autoFocus value={amount} onChange={setAmount} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('stock.purchases.date')}>
          <Input type="date" dir="ltr" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
        </Field>
        <Field label={t('stock.payment.method')}>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`stock.payment.${m}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('stock.supplier.notes')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}
