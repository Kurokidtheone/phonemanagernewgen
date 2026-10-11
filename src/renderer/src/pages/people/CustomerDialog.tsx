import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';

interface Editable {
  id: string;
  name: string;
  phone: string;
  whatsapp: string;
  address: string;
  notes: string;
}

export function CustomerDialog({ customer, onClose, onSaved }: { customer?: Editable; onClose: () => void; onSaved?: (id: string) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: customer?.name ?? '', phone: customer?.phone ?? '', whatsapp: customer?.whatsapp ?? '', address: customer?.address ?? '', notes: customer?.notes ?? '' });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = useAction(
    async () => {
      if (customer) {
        await api('customer.update', { id: customer.id, ...form });
        return customer.id;
      }
      return (await api('customer.create', form)).id;
    },
    {
      success: customer ? t('customers.updated') : t('customers.saved'),
      invalidate: [['customer'], ['customers']],
      onDone: (id) => {
        onSaved?.(id);
        onClose();
      },
    },
  );
  return (
    <Dialog title={customer ? t('customers.editTitle') : t('customers.addTitle')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !form.name.trim()}>
      <Field label={t('sell.customerName')} required>
        <Input autoFocus value={form.name} onChange={set('name')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('sell.customerPhone')}>
          <Input dir="ltr" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label={t('customers.whatsapp')}>
          <Input dir="ltr" value={form.whatsapp} onChange={set('whatsapp')} />
        </Field>
      </div>
      <Field label={t('stock.supplier.address')}>
        <Input value={form.address} onChange={set('address')} />
      </Field>
      <Field label={t('stock.supplier.notes')}>
        <textarea className="input min-h-[64px]" value={form.notes} onChange={set('notes')} />
      </Field>
    </Dialog>
  );
}
