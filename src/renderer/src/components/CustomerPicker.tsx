import { useQuery } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useMoney } from '@/lib/hooks';

/** Pick a customer by name or phone, or create one on the spot. Enter picks the only match. */
export function CustomerPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api('customers.list') });
  const picked = customers.data?.find((c) => c.id === value);
  const q = search.trim().toLowerCase();
  const matches = (customers.data ?? []).filter((c) => !q || `${c.name} ${c.phone}`.toLowerCase().includes(q)).slice(0, 5);

  if (picked) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
        <span>
          <b>{picked.name}</b> <span className="text-muted" dir="ltr">{picked.phone}</span>
          {picked.balance > 0 && <span className="block text-danger">{t('sell.owes', { amount: money(picked.balance) })}</span>}
        </span>
        <button type="button" className="rounded-md p-1 text-muted hover:bg-paper" aria-label={t('common.remove')} onClick={() => onChange(null)}>
          <X size={16} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={search}
          placeholder={t('sell.customerSearch')}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search.trim()) {
              e.preventDefault();
              if (matches.length === 1) onChange(matches[0].id);
            }
          }}
        />
        <Button icon={UserPlus} onClick={() => setCreating(true)} aria-label={t('sell.newCustomer')} />
      </div>
      {q && (
        <ul className="mt-1 rounded-lg border border-line">
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" className="flex w-full justify-between px-3 py-1.5 text-start text-sm hover:bg-paper" onClick={() => onChange(c.id)}>
                <span>{c.name}</span>
                <span className="text-muted" dir="ltr">{c.phone}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="px-3 py-1.5 text-sm text-muted">{t('common.noMatch')}</li>}
        </ul>
      )}
      {creating &&
        createPortal(
          <QuickCustomer
            initialName={search}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              onChange(id);
              setCreating(false);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function QuickCustomer({ initialName, onClose, onCreated }: { initialName: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const save = useAction(() => api('customers.create', { name, phone, whatsapp: '', address: '', notes: '' }), {
    success: t('sell.customerSaved'),
    invalidate: [['customers'], ['customer']],
    onDone: (c) => onCreated(c.id),
  });
  return (
    <Dialog title={t('sell.newCustomer')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !name.trim()}>
      <Field label={t('sell.customerName')} required>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('sell.customerPhone')}>
        <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
    </Dialog>
  );
}
