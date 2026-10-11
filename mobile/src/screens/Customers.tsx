// Customers: search, a customer's page (debt, unpaid, recent purchases), receive a payment, WhatsApp reminder.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Search, Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SALE_METHODS } from '@shared/schemas';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { api, errorText } from '@/lib/api';
import { formatDate, listRefresh, useCanWrite, useStoreName } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { openWhatsapp } from '@/lib/whatsapp';

export function Customers() {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const customers = useQuery({ queryKey: ['customers', 'overview'], queryFn: () => api('customer.list', {}), refetchInterval: listRefresh });
  if (open) return <CustomerPage id={open} onBack={() => setOpen(null)} />;

  const needle = q.trim().toLowerCase();
  const rows = (customers.data ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.phone.includes(needle));
  return (
    <div className="flex h-full flex-col" data-accent="purple">
      <div className="relative p-3">
        <Search className="pointer-events-none absolute start-6 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
        <input className={`${inputClass} ps-10`} placeholder={t('customers.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['customers'] })}>
          {rows.length === 0 ? <Empty>{t('m.lookup.none')}</Empty> : rows.slice(0, 200).map((c) => <Row key={c.id} onClick={() => setOpen(c.id)} title={c.name} subtitle={<span dir="ltr">{c.phone}</span>} right={c.balance > 0 ? <span className="font-semibold text-danger">{money(c.balance)}</span> : undefined} />)}
        </Refreshable>
      </div>
    </div>
  );
}

function CustomerPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const store = useStoreName();
  const [paying, setPaying] = useState(false);
  const canWrite = useCanWrite();
  const view = useQuery({ queryKey: ['customer', id], queryFn: () => api('customer.get', { id }), refetchInterval: listRefresh });
  const v = view.data;

  const remind = (): void => {
    if (!v) return;
    const text = t('customers.reminder', { name: v.customer.name, store, amount: money(v.stats.balance) });
    void openWhatsapp(v.customer.whatsapp || v.customer.phone, text).catch((err) => toast(errorText(t, err)));
  };

  return (
    <div className="flex h-full flex-col" data-accent="purple">
      <ScreenHeader title={v?.customer.name ?? ''} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['customer', id] })}>
          {v && (
            <div className="pb-6">
              <Row title={t('customers.debt')} right={<span className={v.stats.balance > 0 ? 'text-xl font-bold text-danger' : 'text-xl font-bold'}>{money(v.stats.balance)}</span>} />
              <Row title={t('sell.customerPhone')} right={<span dir="ltr">{v.customer.phone}</span>} />
              <Row title={t('customers.totalBought')} right={money(v.stats.totalBought)} />
              <div className="grid grid-cols-2 gap-2 p-3">
                <Button variant="primary" icon={HandCoins} disabled={!canWrite || v.stats.balance <= 0} onClick={() => setPaying(true)}>
                  {t('customers.receivePayment')}
                </Button>
                <Button icon={Send} disabled={v.stats.balance <= 0} onClick={remind}>
                  {t('customers.remind')}
                </Button>
              </div>

              <h3 className="px-4 pb-1 pt-2 font-semibold">{t('m.cust.unpaid')}</h3>
              {v.openItems.length === 0 && <Empty>{t('m.cust.noUnpaid')}</Empty>}
              {v.openItems.map((i) => (
                <Row key={`${i.kind}-${i.id}`} title={i.label} subtitle={formatDate(i.date, i18n.language)} right={<span className="text-danger">{money(i.remaining)}</span>} />
              ))}

              <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.cust.recent')}</h3>
              {v.sales.length === 0 && <Empty>{t('m.cust.noSales')}</Empty>}
              {v.sales.slice(0, 15).map((s) => (
                <Row key={s.id} title={s.itemsSummary ?? s.receiptNumber} subtitle={`${s.receiptNumber} · ${formatDate(s.date, i18n.language)}`} right={money(s.total)} />
              ))}
            </div>
          )}
        </Refreshable>
      </div>
      {paying && v && <PaymentSheet customerId={id} name={v.customer.name} balance={v.stats.balance} onClose={() => setPaying(false)} />}
    </div>
  );
}

/** The payment settles the oldest unpaid sales and repairs first: the desktop service does that. */
function PaymentSheet({ customerId, name, balance, onClose }: { customerId: string; name: string; balance: number; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const [amount, setAmount] = useState<number | null>(balance);
  const [method, setMethod] = useState<(typeof SALE_METHODS)[number]>('CASH');
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    if (!amount || amount <= 0) return;
    setBusy(true);
    try {
      await api('customer.receivePayment', { customerId, amount, date: new Date().toISOString(), method, note: '' });
      toast(t('customers.paymentSaved'));
      await client.invalidateQueries();
      onClose();
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('m.cust.payTitle')} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('customers.paymentHint', { name, amount: money(balance) })}</p>
        <Field label={t('sell.amountReceived')}>
          <MoneyField value={amount} onChange={setAmount} />
        </Field>
        <Field label={t('sell.method')}>
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {SALE_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`sell.methods.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button variant="primary" className="w-full" busy={busy} disabled={!amount} onClick={() => void save()}>
          {t('customers.receivePayment')}
        </Button>
      </div>
    </Sheet>
  );
}
