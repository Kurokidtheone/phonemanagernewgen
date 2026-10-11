// A repair ticket: details, photos, history, and the actions of the desk.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, NotebookPen, PackagePlus, Printer, Send, Truck, Workflow } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OPEN_REPAIR_STATUSES, SALE_METHODS } from '@shared/schemas';
import { Button, Field, inputClass, Pill, Refreshable, Row } from '@/components/ui';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { PhotoCapture, Photo } from '@/components/PhotoStrip';
import { api, errorText, type ApiResult } from '@/lib/api';
import { getState } from '@/lib/connection';
import { PrintButton } from '@/components/PrintButton';
import { minimalSettings, printRepairSlip, shareRepairSlip } from '@/lib/documents';
import { formatDateTime, listRefresh, useCanWrite, useStoreName } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { openWhatsapp } from '@/lib/whatsapp';
import { ViewOnlyNote } from '@/components/ViewOnly';
import { ItemPicker, type ItemChoice } from '../stock/pickers';

type Repair = ApiResult<'repairs.get'>;
type Dialog = 'status' | 'part' | 'note' | 'deliver' | null;

export function Ticket({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const store = useStoreName();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [printing, setPrinting] = useState(false);
  const canWrite = useCanWrite();
  const view = useQuery({ queryKey: ['repair', id], queryFn: () => api('repairs.get', { id }), refetchInterval: listRefresh });
  const r = view.data;
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['repair', id] }).then(() => client.invalidateQueries({ queryKey: ['repairs'] }));
  const device = r ? [r.brand, r.model].filter(Boolean).join(' ') || '—' : '';

  const notify = (): void => {
    if (!r) return;
    const text = t('repairs.notify.message', { name: r.customer.name, device, ticket: r.ticketNumber, store, amount: money(Math.max(0, r.remaining)) });
    void openWhatsapp(r.customer.whatsapp || r.customer.phone, text).catch((err) => toast(errorText(t, err)));
  };
  const printSlip = async (): Promise<void> => {
    setPrinting(true);
    try {
      if (getState().route === 'local' && r) {
        // No counter printer on a phone alone: the slip goes out as a picture.
        await shareRepairSlip(t, i18n.language, r, await api('settings.get'), money, r.customer.whatsapp || r.customer.phone || undefined);
        return;
      }
      await api('repairs.printSlip', { id });
      toast(t('m.rep.slipSent'));
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setPrinting(false);
    }
  };
  const printOnPhone = async (): Promise<void> => {
    if (!r) return;
    const alone = getState().route === 'local';
    await printRepairSlip(t, i18n.language, r, alone ? await api('settings.get') : minimalSettings(store), money);
  };
  const addPhoto = async (fileName: string): Promise<void> => {
    await api('repairs.addPhoto', { repairId: id, fileName });
    await refresh();
  };

  return (
    <div className="flex h-full flex-col" data-accent="orange">
      <ScreenHeader title={r?.ticketNumber ?? ''} onBack={onBack} right={r && <Pill tone="accent">{t(`customers.repairStatus.${r.status}`)}</Pill>} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={refresh}>
          {r && (
            <div className="pb-6">
              <Row title={t('sell.customer')} subtitle={<span dir="ltr">{r.customer.phone}</span>} right={r.customer.name} />
              <Row title={t('customers.device')} right={device} />
              {r.imei && <Row title="IMEI" right={<span dir="ltr">{r.imei}</span>} />}
              <Row title={t('customers.fault')} right={r.fault} />
              {r.arrival.flags.length > 0 && <Row title={t('repairs.form.arrival')} right={r.arrival.flags.map((f) => t(`repairs.arrival.${f}`)).join(', ')} />}
              {r.dueAt && <Row title={t('repairs.form.dueDate')} right={<span className={r.overdue ? 'text-danger' : ''}>{formatDateTime(r.dueAt, i18n.language)}</span>} />}
              <Row title={r.closed ? t('repairs.delivery.finalPrice') : t('repairs.form.estimate')} right={money(r.closed ? (r.finalPrice ?? 0) : r.estimatedPrice)} />
              <Row title={t('sell.paid')} right={money(r.paid)} />
              {r.remaining > 0 && <Row title={t('sell.remaining')} right={<b className="text-danger">{money(r.remaining)}</b>} />}

              {!canWrite && <ViewOnlyNote />}
              {!r.closed && (
                <div className="grid grid-cols-2 gap-2 p-3">
                  {canWrite && (
                    <>
                      <Button icon={Workflow} onClick={() => setDialog('status')}>
                        {t('m.rep.status')}
                      </Button>
                      <Button icon={PackagePlus} onClick={() => setDialog('part')}>
                        {t('m.rep.addPart')}
                      </Button>
                      <Button icon={NotebookPen} onClick={() => setDialog('note')}>
                        {t('m.rep.note')}
                      </Button>
                    </>
                  )}
                  <Button icon={Send} onClick={notify} className={canWrite ? '' : 'col-span-2'}>
                    {t('repairs.notify.button')}
                  </Button>
                  {canWrite && (
                    <Button variant="primary" icon={Truck} className="col-span-2" onClick={() => setDialog('deliver')}>
                      {t('repairs.delivery.button')}
                    </Button>
                  )}
                </div>
              )}
              <div className="space-y-2 px-3 pb-2">
                <PrintButton always={getState().route === 'local'} make={printOnPhone} />
              </div>
              {canWrite && (
                <div className="px-3 pb-2">
                  <Button icon={Printer} className="w-full" busy={printing} onClick={() => void printSlip()}>
                    {t('m.rep.printSlip')}
                  </Button>
                </div>
              )}

              <h3 className="px-4 pb-1 pt-3 font-semibold">{t('repairs.partsUsed')}</h3>
              {r.parts.length === 0 && <p className="px-4 text-muted">{t('m.rep.noParts')}</p>}
              {r.parts.map((p) => (
                <Row key={p.id} title={p.name} right={`× ${p.quantity}`} />
              ))}

              <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.rep.photos')}</h3>
              <div className="px-3">
                {r.closed || !canWrite ? (
                  <div className="grid grid-cols-3 gap-2">
                    {r.photos.map((p) => (
                      <Photo key={p.id} name={p.fileName} className="aspect-square w-full rounded-xl object-cover" />
                    ))}
                  </div>
                ) : (
                  <PhotoCapture names={r.photos.map((p) => p.fileName)} onAdd={addPhoto} />
                )}
              </div>

              {r.notes && (
                <>
                  <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.rep.notesLabel')}</h3>
                  <p className="whitespace-pre-wrap px-4 text-muted">{r.notes}</p>
                </>
              )}

              <h3 className="px-4 pb-1 pt-4 font-semibold">{t('repairs.timeline')}</h3>
              {[...r.history].reverse().map((h, i) => (
                <Row key={i} title={`${t(`customers.repairStatus.${h.status}`)}${h.note ? ` — ${h.note}` : ''}`} subtitle={formatDateTime(h.at, i18n.language)} />
              ))}
            </div>
          )}
        </Refreshable>
      </div>

      {dialog === 'status' && r && <StatusSheet repair={r} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'part' && <PartSheet repairId={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'note' && r && <NoteSheet repair={r} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'deliver' && r && <DeliverSheet repair={r} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

/** Runs a channel call from a sheet: toast the error, refresh and close on success. */
function useRun(onDone: () => Promise<void>, onClose: () => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(true);
    try {
      await job();
      if (success) toast(success);
      await onDone();
      onClose();
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function StatusSheet({ repair, onClose, onDone }: { repair: Repair; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const { busy, run } = useRun(onDone, onClose);
  return (
    <Sheet title={t('m.rep.status')} onClose={onClose} closeLabel={t('common.cancel')}>
      <div className="space-y-2">
        {OPEN_REPAIR_STATUSES.map((s) => (
          <Button key={s} className="w-full" variant={repair.status === s ? 'primary' : 'default'} disabled={busy || repair.status === s} icon={repair.status === s ? Check : undefined} onClick={() => void run(() => api('repairs.setStatus', { id: repair.id, status: s, note: '' }), t('repairs.statusChanged'))}>
            {t(`customers.repairStatus.${s}`)}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}

/** A part leaves the stock through the same service as on the desktop. */
function PartSheet({ repairId, onClose, onDone }: { repairId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const { busy, run } = useRun(onDone, onClose);
  const [item, setItem] = useState<ItemChoice | null>(null);
  const [qty, setQty] = useState('1');
  return (
    <Sheet title={t('m.rep.addPart')} onClose={onClose}>
      {!item ? (
        <ItemPicker onPick={setItem} />
      ) : (
        <div className="space-y-3">
          <div className="font-semibold">{item.name}</div>
          <Field label={t('m.receive.quantity')}>
            <input dir="ltr" className={inputClass} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>
          <Button variant="primary" className="w-full" busy={busy} disabled={!(Number.parseInt(qty, 10) > 0)} onClick={() => void run(() => api('repairs.addPart', { repairId, productId: item.id, quantity: Number.parseInt(qty, 10) }), t('m.rep.partAdded', { name: item.name }))}>
            {t('m.receive.addLine')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function NoteSheet({ repair, onClose, onDone }: { repair: Repair; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const { busy, run } = useRun(onDone, onClose);
  const [text, setText] = useState('');
  // repairs.update takes the whole editable set: send the current values with the note added.
  const save = (): Promise<void> =>
    run(
      () =>
        api('repairs.update', {
          id: repair.id,
          fault: repair.fault,
          unlockNote: repair.unlockNote,
          estimatedPrice: repair.estimatedPrice,
          employeeId: repair.employeeId,
          dueAt: repair.dueAt,
          notes: [repair.notes, text.trim()].filter(Boolean).join('\n'),
        }),
      t('m.rep.noteSaved'),
    );
  return (
    <Sheet title={t('m.rep.note')} onClose={onClose}>
      <div className="space-y-3">
        <textarea className={`${inputClass} min-h-[96px]`} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <Button variant="primary" className="w-full" busy={busy} disabled={!text.trim()} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}

function DeliverSheet({ repair, onClose, onDone }: { repair: Repair; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const { busy, run } = useRun(onDone, onClose);
  const [price, setPrice] = useState<number | null>(repair.estimatedPrice);
  const [paid, setPaid] = useState<number | null>(Math.max(0, repair.estimatedPrice - repair.paid));
  const [method, setMethod] = useState<(typeof SALE_METHODS)[number]>('CASH');
  const [warranty, setWarranty] = useState('0');
  const left = Math.max(0, (price ?? 0) - repair.paid - (paid ?? 0));
  return (
    <Sheet title={t('repairs.delivery.title')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('repairs.delivery.finalPrice')}>
          <MoneyField
            value={price}
            onChange={(v) => {
              setPrice(v);
              setPaid(Math.max(0, (v ?? 0) - repair.paid));
            }}
          />
        </Field>
        <Row title={t('repairs.delivery.alreadyPaid')} right={money(repair.paid)} />
        <Field label={t('repairs.delivery.paidNow')}>
          <MoneyField value={paid} onChange={setPaid} />
        </Field>
        <Field label={t('sell.method')}>
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {SALE_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`sell.methods.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('repairs.delivery.warrantyDays')}>
          <input dir="ltr" className={inputClass} inputMode="numeric" value={warranty} onChange={(e) => setWarranty(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Row title={t('sell.remaining')} right={<b className={left > 0 ? 'text-danger' : ''}>{money(left)}</b>} />
        {left > 0 && <p className="text-sm text-muted">{t('repairs.delivery.debtNote')}</p>}
        <Button variant="primary" className="w-full" busy={busy} disabled={price === null} onClick={() => void run(() => api('repairs.deliver', { id: repair.id, finalPrice: price ?? 0, paid: paid ?? 0, method, warrantyDays: Number.parseInt(warranty, 10) || 0, note: '' }), t('repairs.delivery.saved'))}>
          {t('repairs.delivery.confirm')}
        </Button>
      </div>
    </Sheet>
  );
}
