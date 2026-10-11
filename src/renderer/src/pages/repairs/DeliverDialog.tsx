import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useMoney, useSettings } from '@/lib/hooks';
import { printDeliveryReceipt } from '@/lib/repairSlips';
import { toast } from '@/lib/toast';

const METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;

/** Hand the device back: final price (required), what is paid now, warranty. The rest becomes the customer's debt. */
export function DeliverDialog({ id, onClose, onCancelInstead }: { id: string; onClose: () => void; onCancelInstead?: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const repair = useQuery({ queryKey: ['repairs', 'get', id], queryFn: () => api('repairs.get', { id }) }).data;
  const [finalPrice, setFinalPrice] = useState<number | null | undefined>(undefined);
  const [paid, setPaid] = useState<number | null | undefined>(undefined);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [warranty, setWarranty] = useState('30');
  const [note, setNote] = useState('');

  const price = finalPrice === undefined ? (repair?.estimatedPrice ?? 0) : (finalPrice ?? 0);
  const before = repair?.paid ?? 0;
  const due = Math.max(0, price - before); // what is left to pay before this payment
  const now = paid === undefined ? due : (paid ?? 0);
  const remaining = price - before - now;
  const valid = !!repair && finalPrice !== null && now >= 0 && now <= due;

  const save = useAction(
    async () => {
      await api('repairs.deliver', { id, finalPrice: price, paid: now, method, warrantyDays: Math.max(0, Math.floor(Number(warranty)) || 0), note });
      if (settings) void api('repairs.get', { id }).then((r) => printDeliveryReceipt(t, i18n.language, r, settings, money)).catch(() => toast.error(t('errors.unexpected')));
    },
    { success: t('repairs.delivery.saved'), invalidate: [['repairs'], ['customer'], ['customers'], ['items']], onDone: onClose },
  );

  return (
    <Dialog wide title={t('repairs.delivery.title')} hint={repair ? `${repair.ticketNumber} · ${repair.customer.name}` : undefined} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('repairs.delivery.confirm')} busy={save.isPending || !valid}>
      {!repair ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          {repair.parts.length > 0 && (
            <p className="text-sm text-muted">
              {t('repairs.partsUsed')}: {repair.parts.map((p) => `${p.name} × ${p.quantity}`).join(', ')}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('repairs.delivery.finalPrice')} required>
              <MoneyInput autoFocus value={price || null} onChange={setFinalPrice} />
            </Field>
            <Field label={t('repairs.delivery.paidNow')}>
              <MoneyInput key={`p${price}`} value={due || null} onChange={setPaid} />
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
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('repairs.delivery.warrantyDays')}>
              <Input type="number" min={0} dir="ltr" value={warranty} onChange={(e) => setWarranty(e.target.value)} />
            </Field>
            <Field label={t('repairs.delivery.note')}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-xl bg-paper p-3 text-sm">
            <dt className="text-muted">{t('repairs.delivery.alreadyPaid')}</dt>
            <dd className="text-end">{money(before)}</dd>
            <dt className="text-muted">{t('repairs.delivery.paidNow')}</dt>
            <dd className="text-end">{money(now)}</dd>
            <dt className="font-bold">{t('sell.remaining')}</dt>
            <dd className={`text-end font-bold ${remaining > 0 ? 'text-danger' : 'text-ok'}`}>{money(remaining)}</dd>
          </dl>
          {remaining > 0 && <p className="text-sm text-danger">{t('repairs.delivery.debtNote')}</p>}
          {onCancelInstead && (
            <Button className="text-danger" onClick={onCancelInstead}>
              {t('repairs.cancel.instead')}
            </Button>
          )}
        </>
      )}
    </Dialog>
  );
}
