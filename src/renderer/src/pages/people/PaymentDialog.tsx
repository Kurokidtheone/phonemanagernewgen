import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { dayToIso, today, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printPaymentSlip } from '@/lib/paymentSlip';
import { toast } from '@/lib/toast';

const METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;

/** Receive a payment. It settles the oldest unpaid sales and repairs first; then the receipt can be printed. */
export function PaymentDialog({ customerId, name, balance, onClose }: { customerId: string; name: string; balance: number; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const [amount, setAmount] = useState<number | null>(balance > 0 ? balance : null);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<{ groupId: string; before: number; after: number } | null>(null);

  const save = useAction(() => api('customer.receivePayment', { customerId, amount: amount ?? 0, date: dayToIso(date), method, note }), {
    success: t('customers.paymentSaved'),
    invalidate: [['customer'], ['customers'], ['sales']],
    onDone: (r) => setDone(r),
  });
  const print = async (): Promise<void> => {
    if (!done || !settings) return;
    try {
      await printPaymentSlip(t, i18n.language, await api('customer.payment', { groupId: done.groupId }), settings, money);
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };

  if (done) {
    return (
      <Dialog title={t('customers.paymentSaved')} onClose={onClose} onSubmit={onClose} submitLabel={t('common.close')}>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="text-muted">{t('customers.slip.before')}</dt>
          <dd className="text-end">{money(done.before)}</dd>
          <dt className="text-muted">{t('customers.slip.after')}</dt>
          <dd className="text-end font-bold">{money(done.after)}</dd>
        </dl>
        <Button icon={Printer} onClick={() => void print()}>
          {t('customers.slip.print')}
        </Button>
      </Dialog>
    );
  }
  return (
    <Dialog title={t('customers.receivePayment')} hint={t('customers.paymentHint', { name, amount: money(balance) })} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !amount}>
      <Field label={t('stock.payment.amount')} required>
        <MoneyInput autoFocus value={amount} onChange={setAmount} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('stock.purchases.date')}>
          <Input type="date" dir="ltr" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
        </Field>
        <Field label={t('sell.method')}>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`sell.methods.${m}`)}
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
