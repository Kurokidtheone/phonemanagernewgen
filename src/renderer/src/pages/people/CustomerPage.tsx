import { useQuery } from '@tanstack/react-query';
import { Banknote, MessageCircle, Pencil, Plus, Printer, ShoppingBag, Trash2, UserRound, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Dialog';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Skeleton, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDate, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printPaymentSlip } from '@/lib/paymentSlip';
import { whatsappNumber } from '@/lib/receipt';
import { toast } from '@/lib/toast';
import { CustomerDialog } from './CustomerDialog';
import { PaymentDialog } from './PaymentDialog';

type Detail = ApiResult<'customer.get'>;
type Tab = 'purchases' | 'repairs' | 'payments';
const WARRANTY_TONE = { ACTIVE: 'ok', EXPIRED: 'danger', NONE: 'neutral' } as const;

export function CustomerPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [tab, setTab] = useState<Tab>('purchases');
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'delete' | null>(null);
  const query = useQuery({ queryKey: ['customer', 'get', id], queryFn: () => api('customer.get', { id }), retry: false });
  const remove = useAction(() => api('customer.delete', { id }), { success: t('customers.deleted'), invalidate: [['customer'], ['customers']], onDone: () => navigate('/people') });

  const back = { to: '/people', label: t('customers.back') };
  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={UserRound} title={t('customers.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  const data = query.data;
  if (!data) return <Skeleton className="m-8 h-64" />;
  const { customer, stats } = data;

  const remind = (): void => {
    const number = whatsappNumber(customer.whatsapp || customer.phone);
    const text = t('customers.reminder', { name: customer.name, amount: money(stats.balance), store: settings?.storeName ?? '' });
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank');
  };
  const reprint = async (groupId: string): Promise<void> => {
    if (!settings) return;
    try {
      await printPaymentSlip(t, i18n.language, await api('customer.payment', { groupId }), settings, money);
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };

  const salesColumns: Column<Detail['sales'][number]>[] = [
    { header: t('sell.receipt.number'), cell: (r) => <span className="mono font-semibold" dir="ltr">{r.receiptNumber}</span> },
    { header: t('sell.receipt.date'), cell: (r) => formatDate(r.date, i18n.language) },
    { header: t('sell.history.items'), cell: (r) => <span className="line-clamp-1 max-w-[280px]">{r.itemsSummary ?? '—'}</span> },
    { header: t('sell.total'), align: 'end', cell: (r) => money(r.total) },
    { header: t('sell.remaining'), align: 'end', cell: (r) => <span className={r.remaining > 0 ? 'font-bold text-danger' : ''}>{money(r.remaining)}</span> },
  ];
  const repairColumns: Column<Detail['repairs'][number]>[] = [
    { header: t('customers.ticket'), cell: (r) => <span className="mono font-semibold" dir="ltr">{r.ticket}</span> },
    { header: t('customers.device'), cell: (r) => [r.brand, r.model].filter(Boolean).join(' ') },
    { header: t('customers.fault'), cell: (r) => <span className="text-muted">{r.fault}</span> },
    { header: t('sell.history.status'), cell: (r) => <Badge>{t(`customers.repairStatus.${r.status}`, { defaultValue: r.status })}</Badge> },
    { header: t('sell.price'), align: 'end', cell: (r) => money(r.price) },
  ];
  const paymentColumns: Column<Detail['payments'][number]>[] = [
    { header: t('sell.receipt.date'), cell: (r) => formatDate(r.date, i18n.language) },
    { header: t('sell.method'), cell: (r) => t(`sell.methods.${r.method}`, { defaultValue: r.method }) },
    { header: t('customers.balanceChange'), cell: (r) => (r.balanceBefore !== null && r.balanceAfter !== null ? `${money(r.balanceBefore)} → ${money(r.balanceAfter)}` : '—') },
    { header: t('stock.payment.amount'), align: 'end', cell: (r) => <b>{money(r.amount)}</b> },
    {
      header: '',
      width: '60px',
      align: 'end',
      cell: (r) => (
        <button type="button" className="rounded-md p-1.5 text-muted hover:bg-paper" aria-label={t('customers.slip.print')} onClick={() => void reprint(r.id)}>
          <Printer size={16} />
        </button>
      ),
    },
  ];

  return (
    <PageBody>
      <PageHeader
        icon={UserRound}
        title={customer.name}
        subtitle={[customer.phone, customer.address].filter(Boolean).join(' · ')}
        back={back}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={Plus} onClick={() => setDialog('pay')}>{t('customers.receivePayment')}</Button>
            <Button icon={MessageCircle} disabled={stats.balance <= 0 || !(customer.whatsapp || customer.phone)} onClick={remind}>{t('customers.remind')}</Button>
            <Button icon={Pencil} onClick={() => setDialog('edit')}>{t('common.edit')}</Button>
            <Button icon={Trash2} className="text-danger" onClick={() => setDialog('delete')}>{t('common.delete')}</Button>
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard icon={ShoppingBag} label={t('customers.totalPurchases')} value={money(stats.totalBought)} />
        <StatCard icon={Banknote} label={t('customers.totalPaid')} value={money(stats.totalPaid)} />
        <StatCard icon={Wallet} label={t('customers.debt')} value={<span className={stats.balance > 0 ? 'text-danger' : ''}>{money(stats.balance)}</span>} />
      </div>

      <SubTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'purchases', label: t('customers.tabPurchases') },
          { id: 'repairs', label: t('customers.tabRepairs') },
          { id: 'payments', label: t('customers.tabPayments') },
        ]}
      />
      {tab === 'purchases' && <DataTable rows={data.sales} columns={salesColumns} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/sell/sales/${r.id}`)} emptyTitle={t('sell.history.empty')} />}
      {tab === 'repairs' && <DataTable rows={data.repairs} columns={repairColumns} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/repairs/${r.id}`)} emptyTitle={t('customers.noRepairs')} />}
      {tab === 'payments' && <DataTable rows={data.payments} columns={paymentColumns} rowKey={(r) => r.id} emptyTitle={t('stock.payment.empty')} />}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-bold">{t('customers.phones')}</h2>
        {data.phones.length === 0 ? (
          <Card>
            <EmptyState title={t('customers.noPhones')} />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.phones.map((p) => (
              <button key={p.unitId} type="button" onClick={() => navigate(`/stock/phones/${p.unitId}`)} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 text-start hover:border-accent">
                <span>
                  <span className="block font-semibold">{[p.name, p.storage].filter(Boolean).join(' ')}</span>
                  <span className="mono block text-xs text-muted" dir="ltr">{p.imei1}</span>
                  <span className="block text-xs text-muted">{p.receipt} · {formatDate(p.date, i18n.language)}</span>
                </span>
                <Badge tone={WARRANTY_TONE[p.warranty]}>
                  {p.warranty === 'NONE' ? t('customers.warranty.NONE') : t(`customers.warranty.${p.warranty}`, { date: p.warrantyEnd ? formatDate(p.warrantyEnd, i18n.language) : '' })}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </section>

      {dialog === 'edit' && <CustomerDialog customer={customer} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <PaymentDialog customerId={id} name={customer.name} balance={stats.balance} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog title={t('customers.deleteTitle')} body={t('customers.deleteBody')} confirmLabel={t('common.delete')} busy={remove.isPending} onConfirm={() => remove.mutate(undefined)} onClose={() => setDialog(null)} />
      )}
    </PageBody>
  );
}
