import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MANUAL_REASONS } from '@shared/schemas';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useMoney, useSettings } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { printZReport } from '@/lib/zReport';

/** Put money in or take it out by hand. */
export function ManualDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState<(typeof MANUAL_REASONS)[number]>('OWNER_WITHDRAWAL');
  const [note, setNote] = useState('');
  const save = useAction(() => api('cash.manual', { direction, amount: amount ?? 0, reason, note }), { success: t('cash.manualSaved'), invalidate: [['cash']], onDone: onClose });
  return (
    <Dialog title={t('cash.manualTitle')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !amount}>
      <div className="flex gap-2">
        {(['OUT', 'IN'] as const).map((d) => (
          <Button key={d} variant={direction === d ? 'primary' : 'quiet'} onClick={() => setDirection(d)}>
            {t(d === 'IN' ? 'cash.moneyIn' : 'cash.moneyOut')}
          </Button>
        ))}
      </div>
      <Field label={t('stock.payment.amount')} required>
        <MoneyInput autoFocus value={amount} onChange={setAmount} />
      </Field>
      <Field label={t('cash.reason')}>
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          {MANUAL_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`cash.reasons.${r}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('stock.supplier.notes')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}

const NOTES = [2000, 1000, 500, 200] as const; // banknotes, in DA

/** Count the drawer (by banknote if you like), compare with the expected cash, close, and print the Z report. */
export function CloseDialog({ expected, onClose }: { expected: number; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [coins, setCoins] = useState<number | null>(null);
  const [typed, setTyped] = useState<number | null | undefined>(undefined); // set when the total is typed by hand
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null); // the closed session id

  const byNotes = NOTES.reduce((s, n) => s + n * 100 * (Math.max(0, Math.floor(Number(counts[n])) || 0)), 0) + (coins ?? 0);
  const counted = typed === undefined ? byNotes : (typed ?? 0);
  const difference = counted - expected;

  const save = useAction(() => api('cash.close', { counted, note }), {
    success: t('cash.closed'),
    invalidate: [['cash']],
    onDone: (r) => setDone(r.id),
  });
  const print = async (): Promise<void> => {
    if (!done || !settings) return;
    try {
      await printZReport(t, i18n.language, await api('cash.report', { id: done }), settings, money);
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };

  if (done) {
    return (
      <Dialog title={t('cash.closed')} onClose={onClose} onSubmit={onClose} submitLabel={t('common.close')}>
        <Button icon={Printer} onClick={() => void print()}>
          {t('cash.z.print')}
        </Button>
      </Dialog>
    );
  }
  return (
    <Dialog wide title={t('cash.closeTitle')} hint={t('cash.closeHint')} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('cash.closeConfirm')} busy={save.isPending}>
      <div className="grid grid-cols-5 gap-2">
        {NOTES.map((n) => (
          <label key={n} className="block text-xs text-muted">
            {n} {t('cash.note')}
            <Input type="number" min={0} dir="ltr" value={counts[n] ?? ''} onChange={(e) => (setTyped(undefined), setCounts({ ...counts, [n]: e.target.value }))} />
          </label>
        ))}
        <label className="block text-xs text-muted">
          {t('cash.coins')}
          <MoneyInput value={coins} onChange={(v) => (setTyped(undefined), setCoins(v))} />
        </label>
      </div>
      <Field label={t('cash.counted')} required>
        <MoneyInput key={byNotes} value={counted || null} onChange={setTyped} />
      </Field>
      <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-xl bg-paper p-3 text-sm">
        <dt className="text-muted">{t('cash.expected')}</dt>
        <dd className="text-end">{money(expected)}</dd>
        <dt className="text-muted">{t('cash.counted')}</dt>
        <dd className="text-end">{money(counted)}</dd>
        <dt className="font-bold">{t('cash.difference')}</dt>
        <dd className={`text-end font-bold ${difference === 0 ? 'text-ok' : 'text-danger'}`}>{money(difference)}</dd>
      </dl>
      <Field label={t('cash.closeNote')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}
