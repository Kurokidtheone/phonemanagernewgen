// Search a customer by name or phone, or create one on the spot. Used by the sale and by a new repair.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Field, inputClass, Row } from '@/components/ui';
import { Sheet } from '@/components/common';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

export interface CustomerChoice {
  id: string;
  name: string;
  phone: string;
}

export function CustomerPicker({ onPick, onClose }: { onPick: (c: CustomerChoice) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const customers = useQuery({ queryKey: ['customers', 'pick'], queryFn: () => api('customers.list') });
  const needle = q.trim().toLowerCase();
  const rows = (customers.data ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.phone.includes(needle)).slice(0, 40);

  const create = async (): Promise<void> => {
    try {
      const c = await api('customers.create', { name, phone });
      await client.invalidateQueries({ queryKey: ['customers'] });
      toast(t('sell.customerSaved'));
      onPick({ id: c.id, name: name.trim(), phone: phone.trim() });
    } catch (err) {
      toast(errorText(t, err));
    }
  };

  return (
    <Sheet title={t('m.sell.chooseCustomer')} onClose={onClose} closeLabel={t('common.cancel')}>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
        <input className={`${inputClass} ps-10`} placeholder={t('sell.customerSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Button icon={Plus} className="mt-2 w-full" onClick={() => setCreating((v) => !v)}>
        {t('sell.newCustomer')}
      </Button>
      {creating && (
        <div className="mt-2 space-y-2 rounded-xl border border-line p-3">
          <Field label={t('sell.customerName')}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t('sell.customerPhone')}>
            <input dir="ltr" className={inputClass} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" disabled={!name.trim()} onClick={() => void create()}>
            {t('m.cust.create')}
          </Button>
        </div>
      )}
      <div className="mt-2">
        {rows.length === 0 && !creating && <Empty>{t('m.lookup.none')}</Empty>}
        {rows.map((c) => (
          <Row key={c.id} title={c.name} subtitle={<span dir="ltr">{c.phone}</span>} onClick={() => onPick({ id: c.id, name: c.name, phone: c.phone })} />
        ))}
      </div>
    </Sheet>
  );
}
