import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { dayToIso, today, useAction, useMoney } from '@/lib/hooks';

const METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;
const MethodSelect = ({ value, onChange }: { value: (typeof METHODS)[number]; onChange: (m: (typeof METHODS)[number]) => void }) => {
  const { t } = useTranslation();
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as (typeof METHODS)[number])}>
      {METHODS.map((m) => (
        <option key={m} value={m}>
          {t(`sell.methods.${m}`)}
        </option>
      ))}
    </select>
  );
};

/** Pay a salary (or a bonus, or a commission). Offers to deduct the advance still outstanding. */
export function PaySalaryDialog({ employeeId, name, monthlySalary, advanceBalance, onClose }: { employeeId: string; name: string; monthlySalary: number; advanceBalance: number; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const month = new Date().toLocaleString(i18n.language === 'ar' ? 'ar-DZ-u-nu-latn' : i18n.language, { month: 'long' });
  const [amount, setAmount] = useState<number | null>(monthlySalary || null);
  const [note, setNote] = useState(t('employees.salaryNote', { month }));
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [date, setDate] = useState(today());
  const [deduct, setDeduct] = useState(advanceBalance > 0);
  const [deductAmount, setDeductAmount] = useState<number | null | undefined>(undefined); // undefined: as much as possible

  const gross = amount ?? 0;
  const maxDeduct = Math.min(advanceBalance, gross);
  const taken = deduct ? Math.min(deductAmount === undefined ? maxDeduct : (deductAmount ?? 0), maxDeduct) : 0;
  const net = gross - taken;

  const save = useAction(() => api('employee.paySalary', { employeeId, amount: gross, deduct: taken, note, method, date: dayToIso(date) }), {
    success: t('employees.paymentSaved'),
    invalidate: [['employee'], ['cash']],
    onDone: onClose,
  });

  return (
    <Dialog title={t('employees.paySalary')} hint={name} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !amount}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('employees.salaryAmount')} required>
          <MoneyInput autoFocus value={amount} onChange={setAmount} />
        </Field>
        <Field label={t('stock.purchases.date')}>
          <Input type="date" dir="ltr" max={today()} value={date} onChange={(e) => setDate(e.target.value || today())} />
        </Field>
      </div>
      <Field label={t('employees.paymentNote')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {advanceBalance > 0 && (
        <div className="space-y-2 rounded-xl border border-line p-3 text-sm">
          <p className="font-semibold text-danger">{t('employees.advanceOutstanding', { amount: money(advanceBalance) })}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
            {t('employees.deductAdvance')}
          </label>
          {deduct && (
            <MoneyInput key={maxDeduct} value={maxDeduct || null} onChange={(v) => setDeductAmount(v ?? 0)} />
          )}
        </div>
      )}
      <Field label={t('sell.method')}>
        <MethodSelect value={method} onChange={setMethod} />
      </Field>
      <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-xl bg-paper p-3 text-sm">
        <dt className="text-muted">{t('employees.salaryAmount')}</dt>
        <dd className="text-end">{money(gross)}</dd>
        {taken > 0 && (
          <>
            <dt className="text-muted">{t('employees.deducted')}</dt>
            <dd className="text-end">-{money(taken)}</dd>
          </>
        )}
        <dt className="font-bold">{t('employees.netPaid')}</dt>
        <dd className="text-end font-bold text-accent">{money(net)}</dd>
      </dl>
    </Dialog>
  );
}

/** Give an advance, or record that the employee paid one back. */
export function AdvanceDialog({ employeeId, name, balance, onClose }: { employeeId: string; name: string; balance: number; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const [kind, setKind] = useState<'GIVE' | 'REPAY'>('GIVE');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [date, setDate] = useState(today());
  const tooMuch = kind === 'REPAY' && (amount ?? 0) > balance;

  const save = useAction(() => api('employee.advance', { employeeId, kind, amount: amount ?? 0, note, method, date: dayToIso(date) }), {
    success: t('employees.advanceSaved'),
    invalidate: [['employee'], ['cash']],
    onDone: onClose,
  });
  return (
    <Dialog title={t('employees.addAdvance')} hint={`${name} · ${t('employees.advanceOutstanding', { amount: money(balance) })}`} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !amount || tooMuch}>
      <div className="flex gap-2">
        {(['GIVE', 'REPAY'] as const).map((k) => (
          <Button key={k} variant={kind === k ? 'primary' : 'quiet'} onClick={() => setKind(k)}>
            {t(`employees.advanceKind.${k}`)}
          </Button>
        ))}
      </div>
      <Field label={t('stock.payment.amount')} required error={tooMuch ? t('errors.repay_too_large') : undefined}>
        <MoneyInput autoFocus value={amount} onChange={setAmount} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('stock.purchases.date')}>
          <Input type="date" dir="ltr" max={today()} value={date} onChange={(e) => setDate(e.target.value || today())} />
        </Field>
        <Field label={t('sell.method')}>
          <MethodSelect value={method} onChange={setMethod} />
        </Field>
      </div>
      <Field label={t('employees.paymentNote')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}
