// Take in a repair: customer, device, IMEI by scan, fault, state on arrival, accessories left, money, due date, photos.
import { useQueryClient } from '@tanstack/react-query';
import { Check, Printer, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCESSORY_ITEMS, ARRIVAL_FLAGS, SALE_METHODS } from '@shared/schemas';
import { Button, Field, inputClass, Row } from '@/components/ui';
import { MoneyField, ScreenHeader } from '@/components/common';
import { PhotoCapture } from '@/components/PhotoStrip';
import { api, errorText } from '@/lib/api';
import { useConnection } from '@/lib/connection';
import { scanCode, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';
import { CustomerPicker, type CustomerChoice } from '../sell/CustomerPicker';

type Flag = (typeof ARRIVAL_FLAGS)[number];
type Accessory = (typeof ACCESSORY_ITEMS)[number];

export function NewRepair({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const employeeId = useConnection().employeeId;
  const [customer, setCustomer] = useState<CustomerChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [imei, setImei] = useState('');
  const [fault, setFault] = useState('');
  const [flags, setFlags] = useState<Flag[]>([]);
  const [accessories, setAccessories] = useState<Accessory[]>([]);
  const [accessoryNote, setAccessoryNote] = useState('');
  const [estimate, setEstimate] = useState<number | null>(null);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof SALE_METHODS)[number]>('CASH');
  const [due, setDue] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ id: string; ticketNumber: string } | null>(null);

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const scanImei = async (): Promise<void> => {
    try {
      const code = await scanCode({ imei: true, title: 'IMEI' });
      if (code) setImei(code);
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
  };

  const save = async (): Promise<void> => {
    if (!customer) return setError(t('m.sell.chooseCustomer'));
    setBusy(true);
    setError('');
    try {
      const r = await api('repairs.create', {
        customerId: customer.id,
        brand,
        model,
        imei: imei || null,
        fault,
        arrival: { flags, note: '' },
        accessories: { items: accessories, note: accessoryNote },
        estimatedPrice: estimate ?? 0,
        deposit: deposit ?? 0,
        depositMethod: method,
        employeeId,
        dueAt: due ? new Date(`${due}T18:00:00`).toISOString() : null,
        photos,
      });
      await client.invalidateQueries({ queryKey: ['repairs'] });
      toast(t('repairs.saved'));
      setMade({ id: r.id, ticketNumber: r.ticketNumber });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (made) return <Created ticket={made.ticketNumber} id={made.id} onOpen={() => onOpen(made.id)} onBack={onBack} />;

  return (
    <div className="flex h-full flex-col" data-accent="orange">
      <ScreenHeader title={t('m.rep.new')} onBack={onBack} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Row title={t('sell.customer')} right={customer?.name ?? t('m.sell.chooseCustomer')} onClick={() => setPicking(true)} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('repairs.form.brand')}>
            <input className={inputClass} value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label={t('repairs.form.model')}>
            <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        </div>
        <Field label={t('m.rep.imei')}>
          <div className="flex gap-2">
            <input dir="ltr" className={inputClass} inputMode="numeric" value={imei} onChange={(e) => setImei(e.target.value.replace(/\D/g, ''))} />
            <Button icon={ScanLine} onClick={() => void scanImei()} aria-label="scan" />
          </div>
        </Field>
        <Field label={t('customers.fault')}>
          <input className={inputClass} value={fault} onChange={(e) => setFault(e.target.value)} />
        </Field>

        <div>
          <div className="pb-1 text-sm text-muted">{t('repairs.form.arrival')}</div>
          <div className="flex flex-wrap gap-2">
            {ARRIVAL_FLAGS.map((f) => (
              <Chip key={f} on={flags.includes(f)} onClick={() => setFlags(toggle(flags, f))}>
                {t(`repairs.arrival.${f}`)}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div className="pb-1 text-sm text-muted">{t('repairs.form.accessories')}</div>
          <div className="flex flex-wrap gap-2">
            {ACCESSORY_ITEMS.map((a) => (
              <Chip key={a} on={accessories.includes(a)} onClick={() => setAccessories(toggle(accessories, a))}>
                {t(`repairs.accessory.${a}`)}
              </Chip>
            ))}
          </div>
          <input className={`${inputClass} mt-2`} placeholder={t('repairs.form.otherNote')} value={accessoryNote} onChange={(e) => setAccessoryNote(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label={t('repairs.form.estimate')}>
            <MoneyField value={estimate} onChange={setEstimate} />
          </Field>
          <Field label={t('repairs.form.deposit')}>
            <MoneyField value={deposit} onChange={setDeposit} />
          </Field>
        </div>
        {!!deposit && (
          <Field label={t('sell.method')}>
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {SALE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`sell.methods.${m}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('repairs.form.dueDate')}>
          <input type="date" dir="ltr" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>

        <div>
          <div className="pb-1 text-sm text-muted">{t('m.rep.photos')}</div>
          <PhotoCapture names={photos} onAdd={(n) => setPhotos((p) => [...p, n])} onRemove={(n) => setPhotos((p) => p.filter((x) => x !== n))} />
        </div>
        {error && <div className="rounded-xl bg-danger/15 p-3 text-danger">{error}</div>}
      </div>
      <div className="border-t border-line bg-card p-3">
        <Button variant="primary" className="w-full" busy={busy} disabled={!customer || !fault.trim()} onClick={() => void save()}>
          {t('m.rep.save')}
        </Button>
      </div>
      {picking && (
        <CustomerPicker
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setCustomer(c);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button className={`min-h-touch rounded-xl border px-3 text-base ${on ? 'border-accent bg-accent-soft font-semibold' : 'border-line bg-card'}`} onClick={onClick}>
    {on && <Check className="me-1 inline h-4 w-4" />}
    {children}
  </button>
);

function Created({ ticket, id, onOpen, onBack }: { ticket: string; id: string; onOpen: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const print = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('repairs.printSlip', { id });
      toast(t('m.rep.slipSent'));
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" data-accent="orange">
      <Check className="h-16 w-16 text-ok" />
      <h2 className="text-2xl font-bold">{t('m.rep.created', { ticket })}</h2>
      <Button variant="primary" icon={Printer} className="w-full max-w-sm" busy={busy} onClick={() => void print()}>
        {t('m.rep.printSlip')}
      </Button>
      <Button className="w-full max-w-sm" onClick={onOpen}>
        {t('m.rep.openTicket')}
      </Button>
      <Button className="w-full max-w-sm" onClick={onBack}>
        {t('m.stock.back')}
      </Button>
    </div>
  );
}
