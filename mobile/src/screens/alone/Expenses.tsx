import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/hooks';
import { today, useDo } from './kit';

export function ExpensesScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const [adding, setAdding] = useState(false);
  const monthStart = `${today().slice(0, 8)}01`;
  const list = useQuery({ queryKey: ['expenses', 'month'], queryFn: () => api('expenses.list', { from: monthStart, to: today() }) });
  const total = (list.data ?? []).reduce((s, e) => s + e.amount, 0);
  return (
    <div className="flex h-full flex-col" data-accent="pink">
      <ScreenHeader title={t('m.alone.expenses')} onBack={onBack} right={<Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>{t('common.add')}</Button>} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => list.refetch()}>
          <div className="px-5 py-3 text-sm text-muted">
            {t('m.alone.thisMonth')} · <b className="text-ink">{money(total)}</b>
          </div>
          {(list.data ?? []).length === 0 && <Empty>{t('m.alone.noExpenses')}</Empty>}
          {(list.data ?? []).map((e) => (
            <Row key={e.id} title={e.categoryName} subtitle={`${formatDate(e.date, i18n.language)} · ${e.buyer}${e.note ? ` · ${e.note}` : ''}`} right={<b>{money(e.amount)}</b>} />
          ))}
        </Refreshable>
      </div>
      {adding && <AddExpense onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddExpense({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const categories = useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api('expenses.categories') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('settings.get') });
  const [amount, setAmount] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [buyer, setBuyer] = useState('');
  const [note, setNote] = useState('');
  const [fromCash, setFromCash] = useState(true);
  const save = useDo(() => api('expenses.create', { buyer: buyer || settings.data?.ownerName || t('m.alone.me'), categoryId: categoryId || categories.data?.[0]?.id || '', date: today(), amount: amount ?? 0, note, receiptPath: null, fromCash }), {
    success: t('common.saved'),
    onDone: onClose,
  });
  return (
    <Sheet title={t('m.alone.addExpense')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('stock.payment.amount')}>
          <MoneyField value={amount} onChange={setAmount} />
        </Field>
        <Field label={t('m.alone.category')}>
          <select className={inputClass} value={categoryId || categories.data?.[0]?.id || ''} onChange={(e) => setCategoryId(e.target.value)}>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('m.alone.paidBy')}>
          <input className={inputClass} value={buyer} placeholder={settings.data?.ownerName ?? ''} onChange={(e) => setBuyer(e.target.value)} />
        </Field>
        <Field label={t('stock.supplier.notes')}>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={fromCash} onChange={(e) => setFromCash(e.target.checked)} /> {t('m.alone.fromCash')}
        </label>
        <Button variant="primary" className="w-full" busy={save.isPending} disabled={!amount} onClick={() => save.mutate(undefined)}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}
