import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ACCESSORY_ITEMS, ARRIVAL_FLAGS } from '@shared/schemas';
import { isValidImei } from '@shared/imei';
import { CustomerPicker } from '@/components/CustomerPicker';
import { Dialog } from '@/components/Dialog';
import { Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { dayEndIso, today, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printIntakeSlip } from '@/lib/repairSlips';
import { toast } from '@/lib/toast';

type Flag = (typeof ARRIVAL_FLAGS)[number];
type Accessory = (typeof ACCESSORY_ITEMS)[number];
const METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

/** Take a device in. Saving prints the intake slip (customer and shop copy). */
export function NewRepairDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const settings = useSettings().data;
  const suggestions = useQuery({ queryKey: ['repairs', 'suggestions'], queryFn: () => api('repairs.suggestions') }).data;
  const technicians = useQuery({ queryKey: ['employees'], queryFn: () => api('employees.list') }).data;

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [imei, setImei] = useState('');
  const [fault, setFault] = useState('');
  const [flags, setFlags] = useState<Flag[]>([]);
  const [arrivalNote, setArrivalNote] = useState('');
  const [items, setItems] = useState<Accessory[]>([]);
  const [accessoryNote, setAccessoryNote] = useState('');
  const [unlockNote, setUnlockNote] = useState('');
  const [estimate, setEstimate] = useState<number | null>(null);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [employeeId, setEmployeeId] = useState('');
  const [due, setDue] = useState('');

  const imeiError = imei && !isValidImei(imei) ? t('stock.phoneForm.imeiBad') : undefined;
  const valid = !!customerId && !!fault.trim() && !imeiError;

  const save = useAction(
    async () => {
      const made = await api('repairs.create', {
        customerId: customerId!,
        brand,
        model,
        imei: imei || null,
        fault,
        arrival: { flags, note: arrivalNote },
        accessories: { items, note: accessoryNote },
        unlockNote,
        estimatedPrice: estimate ?? 0,
        deposit: deposit ?? 0,
        depositMethod: method,
        employeeId: employeeId || null,
        dueAt: due ? dayEndIso(due) : null,
      });
      // The slip is printed right away; cancelling the print dialog is fine.
      if (settings) {
        void api('repairs.get', { id: made.id }).then((r) => printIntakeSlip(t, i18n.language, r, settings, money)).catch(() => toast.error(t('errors.unexpected')));
      }
      return made.id;
    },
    {
      success: t('repairs.saved'),
      invalidate: [['repairs'], ['customer'], ['customers']],
      onDone: (id) => {
        onClose();
        navigate(`/repairs/${id}`);
      },
    },
  );

  return (
    <Dialog wide title={t('repairs.form.title')} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('repairs.form.save')} busy={save.isPending || !valid}>
      <Field label={t('sell.customer')} required>
        <CustomerPicker value={customerId} onChange={setCustomerId} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('repairs.form.brand')}>
          <Input list="repair-brands" value={brand} onChange={(e) => setBrand(e.target.value)} />
          <datalist id="repair-brands">{suggestions?.brands.map((b) => <option key={b} value={b} />)}</datalist>
        </Field>
        <Field label={t('repairs.form.model')}>
          <Input list="repair-models" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="repair-models">{suggestions?.models.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
        <Field label={`IMEI (${t('common.optional')})`} error={imeiError}>
          <Input className="mono" dir="ltr" inputMode="numeric" maxLength={15} value={imei} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} onChange={(e) => setImei(e.target.value.trim())} />
        </Field>
      </div>
      <Field label={t('customers.fault')} required>
        <textarea className="input min-h-[64px]" maxLength={300} value={fault} onChange={(e) => setFault(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <fieldset className="rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-semibold">{t('repairs.form.arrival')}</legend>
          <div className="grid grid-cols-2 gap-1.5 text-sm">
            {ARRIVAL_FLAGS.map((f) => (
              <label key={f} className="flex items-center gap-2">
                <input type="checkbox" checked={flags.includes(f)} onChange={() => setFlags(toggle(flags, f))} />
                {t(`repairs.arrival.${f}`)}
              </label>
            ))}
          </div>
          <Input className="mt-2" value={arrivalNote} placeholder={t('repairs.form.otherNote')} onChange={(e) => setArrivalNote(e.target.value)} />
        </fieldset>
        <fieldset className="rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-semibold">{t('repairs.form.accessories')}</legend>
          <div className="grid grid-cols-2 gap-1.5 text-sm">
            {ACCESSORY_ITEMS.map((a) => (
              <label key={a} className="flex items-center gap-2">
                <input type="checkbox" checked={items.includes(a)} onChange={() => setItems(toggle(items, a))} />
                {t(`repairs.accessory.${a}`)}
              </label>
            ))}
          </div>
          <Input className="mt-2" value={accessoryNote} placeholder={t('repairs.form.otherNote')} onChange={(e) => setAccessoryNote(e.target.value)} />
        </fieldset>
      </div>
      <Field label={t('repairs.form.unlockNote')}>
        <Input value={unlockNote} onChange={(e) => setUnlockNote(e.target.value)} />
      </Field>
      <div className="grid grid-cols-4 gap-3">
        <Field label={t('repairs.form.estimate')}>
          <MoneyInput value={estimate} onChange={setEstimate} />
        </Field>
        <Field label={t('repairs.form.deposit')}>
          <MoneyInput value={deposit} onChange={setDeposit} />
        </Field>
        <Field label={t('sell.method')}>
          <select className="input" disabled={!deposit} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`sell.methods.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('repairs.form.dueDate')}>
          <Input type="date" dir="ltr" min={today()} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <Field label={t('repairs.form.technician')}>
        <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">{t('repairs.form.noTechnician')}</option>
          {technicians?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
    </Dialog>
  );
}
