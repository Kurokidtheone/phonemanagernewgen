import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { operatorOf } from '@shared/operators';
import { Button, Card, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useFinanceVisible, useMoney } from '@/lib/hooks';
import { useEnsureDay } from './EnsureDay';

/**
 * Sell a flexy top-up (or another small service) in a few keystrokes: choose the operator, type the
 * amount, Enter. The cash goes into the drawer. Used on the Services tab and pinned on the New sale screen.
 */
export function QuickSale({ withOthers, onSaved }: { withOthers?: boolean; onSaved?: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const day = useEnsureDay();
  const showMargin = useFinanceVisible();
  const services = useQuery({ queryKey: ['services', 'active'], queryFn: () => api('services.active') }).data ?? [];
  const list = services.filter((s) => withOthers || s.kind === 'FLEXY');
  const [serviceId, setServiceId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [phone, setPhone] = useState('');
  const [round, setRound] = useState(0); // remounts the money fields after a sale
  const current = list.find((s) => s.id === serviceId) ?? list[0];
  const other = current?.kind === 'OTHER';

  const save = useAction(
    () => api('services.sell', { serviceId: current!.id, amount: amount ?? 0, cost: other ? cost : null, phoneNumber: phone || null, employeeId: null }),
    {
      success: t('services.saved'),
      invalidate: [['services'], ['cash']],
      onDone: () => {
        setAmount(null);
        setCost(null);
        setPhone('');
        setRound((r) => r + 1);
        onSaved?.();
      },
    },
  );
  const submit = (): void => {
    if (current && amount) day.ensure(() => save.mutate(undefined));
  };

  if (list.length === 0) return null;
  return (
    // Clicks stay inside: the till must not steal focus from these fields while typing.
    <div onClick={(e) => e.stopPropagation()}>
      <Card title={t('services.quickTitle')} icon={Zap}>
        <div className="mb-3 flex flex-wrap gap-2">
          {list.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setServiceId(s.id);
                setAmount(s.defaultPrice || null);
                setRound((r) => r + 1);
              }}
              className={clsx('rounded-lg border px-3 py-1.5 text-sm font-semibold', current?.id === s.id ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink')}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div
          className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        >
          <label className="block text-xs text-muted">
            {t('services.amount')}
            <MoneyInput key={`a${round}${current?.id}`} value={amount} onChange={setAmount} />
          </label>
          <label className="block text-xs text-muted">
            {t('services.phone')}
            <Input
              dir="ltr"
              inputMode="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                // The number tells the operator: pick it without a click.
                const operator = operatorOf(e.target.value);
                const match = operator && list.find((s) => s.kind === 'FLEXY' && s.name.toLowerCase().includes(operator));
                if (match && match.id !== current?.id) {
                  setServiceId(match.id);
                  setRound((r) => r + 1);
                }
              }}
            />
          </label>
          <Button variant="primary" disabled={!amount || save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
          {other && (
            <label className="col-span-2 block text-xs text-muted">
              {t('services.cost')}
              <MoneyInput key={`c${round}${current?.id}`} value={cost} onChange={setCost} />
            </label>
          )}
        </div>
        {showMargin && current?.kind === 'FLEXY' && amount ? (
          <p className="mt-2 text-xs text-muted">{t('services.marginHint', { amount: money(Math.round(current.marginType === 'FIXED' ? Math.min(current.marginValue, amount) : (amount * current.marginValue) / 10_000)) })}</p>
        ) : null}
      </Card>
      {day.dialog}
    </div>
  );
}
