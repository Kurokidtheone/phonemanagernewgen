import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/hooks';
import { Panel, useDo } from './kit';

export function SuppliersScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['suppliers'], queryFn: () => api('suppliers.list') });
  if (open) return <SupplierPage id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader title={t('m.alone.suppliers')} onBack={onBack} right={<Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>{t('common.add')}</Button>} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => list.refetch()}>
          {(list.data ?? []).length === 0 && <Empty>{t('m.alone.noSuppliers')}</Empty>}
          {(list.data ?? []).map((s) => (
            <Row key={s.id} title={s.name} subtitle={<span dir="ltr">{s.phone}</span>} right={s.balance > 0 ? <b className="text-danger">{money(s.balance)}</b> : undefined} onClick={() => setOpen(s.id)} />
          ))}
        </Refreshable>
      </div>
      {adding && <AddSupplier onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSupplier({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<'COMPANY' | 'INDIVIDUAL'>('COMPANY');
  const save = useDo(() => api('suppliers.create', { name, phone, address: '', kind, idDocumentNumber: null, notes: '' }), { success: t('common.saved'), onDone: onClose });
  return (
    <Sheet title={t('m.alone.addSupplier')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('m.alone.name')}>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('m.alone.phone')}>
          <input dir="ltr" inputMode="tel" className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          {(['COMPANY', 'INDIVIDUAL'] as const).map((k) => (
            <Button key={k} variant={kind === k ? 'primary' : 'default'} className="flex-1" onClick={() => setKind(k)}>
              {t(`stock.supplier.kinds.${k}`, { defaultValue: k })}
            </Button>
          ))}
        </div>
        <Button variant="primary" className="w-full" busy={save.isPending} disabled={!name.trim()} onClick={() => save.mutate(undefined)}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}

function SupplierPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const view = useQuery({ queryKey: ['supplier', id], queryFn: () => api('suppliers.get', { id }) });
  const pay = useDo(() => api('suppliers.addPayment', { supplierId: id, amount: amount ?? 0, date: new Date().toISOString(), method: 'CASH', note: '' }), { success: t('common.saved'), onDone: () => (setPaying(false), setAmount(null)) });
  const v = view.data;
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader title={v?.supplier.name ?? ''} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {v && (
          <>
            <Panel>
              <Row title={t('m.alone.purchased')} right={money(v.totals.purchased)} />
              <Row title={t('m.alone.paid')} right={money(v.totals.paid)} />
              <Row title={t('m.alone.balance')} right={<b className={v.totals.balance > 0 ? 'text-danger' : ''}>{money(v.totals.balance)}</b>} />
              <Button variant="primary" className="mt-3 w-full" onClick={() => setPaying(true)}>
                {t('m.alone.paySupplier')}
              </Button>
            </Panel>
            <h3 className="px-5 pt-2 font-semibold">{t('m.alone.purchases')}</h3>
            {v.purchases.map((p) => (
              <Row key={p.id} title={formatDate(p.date, i18n.language)} right={money(p.total)} />
            ))}
          </>
        )}
      </div>
      {paying && (
        <Sheet title={t('m.alone.paySupplier')} onClose={() => setPaying(false)}>
          <div className="space-y-3">
            <MoneyField value={amount} onChange={setAmount} />
            <Button variant="primary" className="w-full" busy={pay.isPending} disabled={!amount} onClick={() => pay.mutate(undefined)}>
              {t('common.save')}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
