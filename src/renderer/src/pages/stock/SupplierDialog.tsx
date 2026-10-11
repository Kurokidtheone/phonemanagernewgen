import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Field, Input } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useAction } from '@/lib/hooks';

type Supplier = ApiResult<'suppliers.list'>[number];
type Kind = 'COMPANY' | 'INDIVIDUAL';

/** Create or edit a supplier. A private seller (INDIVIDUAL) must be identifiable. */
export function SupplierDialog({ supplier, onClose, onSaved }: { supplier?: Supplier; onClose: () => void; onSaved?: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [address, setAddress] = useState(supplier?.address ?? '');
  const [kind, setKind] = useState<Kind>(supplier?.kind ?? 'COMPANY');
  const [idNumber, setIdNumber] = useState(supplier?.idDocumentNumber ?? '');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const individual = kind === 'INDIVIDUAL';
  const valid = !!name.trim() && (!individual || (!!phone.trim() && !!idNumber.trim()));

  const save = useAction(
    async () => {
      const fields = { name, phone, address, kind, idDocumentNumber: idNumber || null, notes };
      if (supplier) {
        await api('suppliers.update', { id: supplier.id, ...fields });
        return supplier.id;
      }
      return (await api('suppliers.create', fields)).id;
    },
    {
      success: supplier ? t('stock.supplier.updated') : t('stock.supplier.saved'),
      invalidate: [['suppliers']],
      onDone: (id) => {
        onSaved?.(id);
        onClose();
      },
    },
  );

  return (
    <Dialog title={supplier ? t('stock.supplier.editTitle') : t('stock.supplier.title')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !valid}>
      <Field label={t('stock.supplier.kind')}>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="COMPANY">{t('stock.supplier.COMPANY')}</option>
          <option value="INDIVIDUAL">{t('stock.supplier.INDIVIDUAL')}</option>
        </select>
      </Field>
      {individual && <p className="rounded-lg bg-paper p-3 text-sm text-muted">{t('stock.supplier.individualHint')}</p>}
      <Field label={t('stock.supplier.name')} required>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('stock.supplier.phone')} required={individual}>
        <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      {individual && (
        <Field label={t('stock.supplier.idNumber')} required>
          <Input dir="ltr" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
        </Field>
      )}
      <Field label={t('stock.supplier.address')}>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <Field label={t('stock.supplier.notes')}>
        <textarea className="input min-h-[64px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Dialog>
  );
}
