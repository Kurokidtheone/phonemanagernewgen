import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Field, Input, MoneyInput, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useMoney } from '@/lib/hooks';

/** Cancel a ticket, or mark it unrepairable: parts go back to stock, an optional diagnosis fee, and the deposit refunded or kept. */
export function CancelDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const repair = useQuery({ queryKey: ['repairs', 'get', id], queryFn: () => api('repairs.get', { id }) }).data;
  const [status, setStatus] = useState<'CANCELLED' | 'UNREPAIRABLE'>('CANCELLED');
  const [fee, setFee] = useState<number | null>(null);
  const [refund, setRefund] = useState(true);
  const [note, setNote] = useState('');
  const paid = repair?.paid ?? 0;
  const feeValue = fee ?? 0;

  const save = useAction(() => api('repairs.cancel', { id, status, fee: feeValue, refundDeposit: refund, note }), {
    success: t('repairs.cancel.saved'),
    invalidate: [['repairs'], ['customer'], ['customers'], ['items']],
    onDone: onClose,
  });

  return (
    <Dialog title={t('repairs.cancel.title')} hint={t('repairs.cancel.hint')} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('repairs.cancel.confirm')} submitVariant="danger" busy={save.isPending || !repair}>
      {!repair ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          <Field label={t('repairs.cancel.outcome')}>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="CANCELLED">{t('customers.repairStatus.CANCELLED')}</option>
              <option value="UNREPAIRABLE">{t('customers.repairStatus.UNREPAIRABLE')}</option>
            </select>
          </Field>
          <Field label={t('repairs.cancel.fee')}>
            <MoneyInput value={fee} onChange={setFee} />
          </Field>
          {paid > 0 && (
            <fieldset className="rounded-xl border border-line p-3 text-sm">
              <legend className="px-1 font-semibold">{t('repairs.cancel.deposit', { amount: money(paid) })}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={refund} onChange={() => setRefund(true)} /> {t('repairs.cancel.refund', { amount: money(Math.max(0, paid - feeValue)) })}
              </label>
              <label className="mt-1 flex items-center gap-2">
                <input type="radio" checked={!refund} onChange={() => setRefund(false)} /> {t('repairs.cancel.keep')}
              </label>
            </fieldset>
          )}
          {repair.parts.length > 0 && <p className="text-sm text-muted">{t('repairs.cancel.partsBack')}</p>}
          <Field label={t('repairs.delivery.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </>
      )}
    </Dialog>
  );
}
