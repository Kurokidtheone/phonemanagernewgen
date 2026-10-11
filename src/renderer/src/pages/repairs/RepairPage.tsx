import { useQuery } from '@tanstack/react-query';
import { Ban, MessageCircle, Pencil, Printer, ScanLine, Trash2, Truck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Dialog } from '@/components/Dialog';
import { PageBody, PageHeader } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Field, Input, MoneyInput, Skeleton } from '@/components/ui';
import { api, fileUrl, type ApiResult } from '@/lib/api';
import { dayEndIso, formatDate, formatDateTime, isoToDay, useAction, useMoney, useSettings } from '@/lib/hooks';
import { notifyUrl, printIntakeSlip } from '@/lib/repairSlips';
import { whatsappNumber } from '@/lib/receipt';
import { toast } from '@/lib/toast';
import { CancelDialog } from './CancelDialog';
import { DeliverDialog } from './DeliverDialog';
import { OPEN_REPAIR_STATUSES, STATUS_TONE } from './shared';

type Repair = ApiResult<'repairs.get'>;

export function RepairPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const { id = '' } = useParams();
  const [dialog, setDialog] = useState<'deliver' | 'cancel' | 'edit' | null>(null);
  const query = useQuery({ queryKey: ['repairs', 'get', id], queryFn: () => api('repairs.get', { id }), retry: false });
  const r = query.data;
  const setStatus = useAction((status: (typeof OPEN_REPAIR_STATUSES)[number]) => api('repairs.setStatus', { id, status, note: '' }), { success: t('repairs.statusChanged'), invalidate: [['repairs']] });

  const back = { to: '/repairs?tab=tickets', label: t('repairs.back') };
  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={Wrench} title={t('repairs.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  if (!r || !settings) return <Skeleton className="m-8 h-64" />;

  const device = [r.brand, r.model].filter(Boolean).join(' ') || '—';
  const notify = (): void => void window.open(notifyUrl(t, r, settings, money, whatsappNumber(r.customer.whatsapp || r.customer.phone)), '_blank');
  const printSlip = (): void => void printIntakeSlip(t, i18n.language, r, settings, money).catch(() => toast.error(t('errors.unexpected')));

  return (
    <PageBody>
      <PageHeader
        icon={Wrench}
        title={r.ticketNumber}
        subtitle={`${device} · ${r.customer.name}`}
        back={back}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[r.status]}>{t(`customers.repairStatus.${r.status}`)}</Badge>
            {!r.closed && (
              <select className="input w-auto" value={r.status} onChange={(e) => setStatus.mutate(e.target.value as (typeof OPEN_REPAIR_STATUSES)[number])} aria-label={t('repairs.changeStatus')}>
                {OPEN_REPAIR_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`customers.repairStatus.${s}`)}
                  </option>
                ))}
              </select>
            )}
            <Button icon={MessageCircle} disabled={!(r.customer.whatsapp || r.customer.phone)} onClick={notify}>{t('repairs.notify.button')}</Button>
            <Button icon={Printer} onClick={printSlip}>{t('repairs.slip.print')}</Button>
            {!r.closed && <Button variant="primary" icon={Truck} onClick={() => setDialog('deliver')}>{t('repairs.delivery.button')}</Button>}
            {!r.closed && <Button icon={Ban} className="text-danger" onClick={() => setDialog('cancel')}>{t('repairs.cancel.button')}</Button>}
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('repairs.details')} actions={<Button icon={Pencil} onClick={() => setDialog('edit')}>{t('common.edit')}</Button>}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-sm">
            <dt className="text-muted">{t('sell.customer')}</dt>
            <dd className="font-semibold"><Link className="text-accent underline" to={`/people/customers/${r.customer.id}`}>{r.customer.name}</Link> <span className="text-muted" dir="ltr">{r.customer.phone}</span></dd>
            <dt className="text-muted">{t('customers.device')}</dt>
            <dd className="font-semibold">{device}</dd>
            {r.imei && (<><dt className="text-muted">IMEI</dt><dd className="mono" dir="ltr">{r.imei}</dd></>)}
            <dt className="text-muted">{t('customers.fault')}</dt>
            <dd>{r.fault}</dd>
            <dt className="text-muted">{t('repairs.form.arrival')}</dt>
            <dd>{[...r.arrival.flags.map((f) => t(`repairs.arrival.${f}`)), r.arrival.note].filter(Boolean).join(', ') || '—'}</dd>
            <dt className="text-muted">{t('repairs.form.accessories')}</dt>
            <dd>{[...r.accessories.items.map((a) => t(`repairs.accessory.${a}`)), r.accessories.note].filter(Boolean).join(', ') || '—'}</dd>
            <dt className="text-muted">{t('repairs.form.unlockNote')}</dt>
            <dd>{r.unlockNote || '—'}</dd>
            <dt className="text-muted">{t('repairs.form.technician')}</dt>
            <dd>{r.technicianName ?? '—'}</dd>
            <dt className="text-muted">{t('repairs.form.receivedOn')}</dt>
            <dd>{formatDateTime(r.receivedAt, i18n.language)}</dd>
            <dt className="text-muted">{t('repairs.form.dueDate')}</dt>
            <dd className={r.overdue ? 'font-bold text-danger' : ''}>{r.dueAt ? formatDate(r.dueAt, i18n.language) : '—'}</dd>
            {r.deliveredAt && (<><dt className="text-muted">{t('repairs.deliveredOn')}</dt><dd>{formatDateTime(r.deliveredAt, i18n.language)}</dd></>)}
            {r.warrantyEnd && (<><dt className="text-muted">{t('sell.warranty')}</dt><dd>{t('sell.receipt.warrantyUntil', { date: formatDate(r.warrantyEnd, i18n.language) })}</dd></>)}
          </dl>
        </Card>

        <div className="space-y-5">
          <Card title={t('repairs.money')}>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
              <dt className="text-muted">{r.closed ? t('repairs.delivery.finalPrice') : t('repairs.form.estimate')}</dt>
              <dd className="text-end font-bold">{money(r.closed ? (r.finalPrice ?? 0) : r.estimatedPrice)}</dd>
              <dt className="text-muted">{t('sell.paid')}</dt>
              <dd className="text-end">{money(r.paid)}</dd>
              <dt className="font-bold">{t('sell.remaining')}</dt>
              <dd className={`text-end font-bold ${r.remaining > 0 ? 'text-danger' : ''}`}>{money(r.remaining)}</dd>
              {r.profit !== null && (<><dt className="text-muted">{t('sell.history.profit')}</dt><dd className="text-end font-bold text-ok">{money(r.profit)}</dd></>)}
            </dl>
            {r.payments.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line pt-1 text-sm">
                {r.payments.map((p) => (
                  <li key={p.id} className="flex justify-between py-1.5">
                    <span>{formatDate(p.date, i18n.language)} · {t(`sell.methods.${p.method}`, { defaultValue: p.method })}{p.note === 'DEPOSIT' ? ` · ${t('repairs.form.deposit')}` : p.note === 'REFUND' ? ` · ${t('repairs.refund')}` : ''}</span>
                    <b>{money(p.amount)}</b>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <PartsCard repair={r} />
        </div>

        <NotesCard repair={r} />
        {r.photos.length > 0 && (
          <Card title={t('repairs.photos', { count: r.photos.length })}>
            <div className="grid grid-cols-3 gap-3">
              {r.photos.map((p) => (
                <a key={p.id} href={fileUrl(p.fileName)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
                  <img src={fileUrl(p.fileName)} alt="" className="aspect-square w-full object-cover" />
                </a>
              ))}
            </div>
          </Card>
        )}
        <Card title={t('repairs.timeline')}>
          <ol className="space-y-3 border-s-2 border-line ps-4">
            {[...r.history].reverse().map((h, i) => (
              <li key={i} className="relative">
                <span className="absolute -start-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
                <p className="text-sm font-semibold">{t(`customers.repairStatus.${h.status}`)}{h.note ? ` — ${h.note}` : ''}</p>
                <p className="text-xs text-muted">{formatDateTime(h.at, i18n.language)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {dialog === 'deliver' && <DeliverDialog id={id} onClose={() => setDialog(null)} onCancelInstead={() => setDialog('cancel')} />}
      {dialog === 'cancel' && <CancelDialog id={id} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditDialog repair={r} onClose={() => setDialog(null)} />}
    </PageBody>
  );
}

/** Parts used: scan or search among repair parts, Enter adds one. Parts only change while the ticket is open. */
function PartsCard({ repair }: { repair: Repair }) {
  const { t } = useTranslation();
  const money = useMoney();
  const [text, setText] = useState('');
  const parts = useQuery({ queryKey: ['repairs', 'parts'], queryFn: () => api('repairs.parts') }).data ?? [];
  const add = useAction((productId: string) => api('repairs.addPart', { repairId: repair.id, productId, quantity: 1 }), { invalidate: [['repairs'], ['items']], onDone: () => setText('') });
  const remove = useAction((id: string) => api('repairs.removePart', { id }), { invalidate: [['repairs'], ['items']] });
  const q = text.trim().toLowerCase();
  const found = q ? parts.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? '').includes(q)).slice(0, 6) : [];

  return (
    <Card title={t('repairs.partsUsed')}>
      {!repair.closed && (
        <div className="relative mb-3">
          <ScanLine size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            className="input ps-9"
            dir="auto"
            value={text}
            placeholder={t('repairs.partSearch')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const exact = parts.find((p) => p.barcode === text.trim());
              const pick = exact ?? found[0];
              if (pick) add.mutate(pick.id);
              else if (text.trim()) toast.error(t('repairs.noPart', { code: text.trim() }));
            }}
          />
          {found.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-xl border border-line bg-card p-1 shadow-xl">
              {found.map((p) => (
                <li key={p.id}>
                  <button type="button" className="flex w-full justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-paper" onClick={() => add.mutate(p.id)}>
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-xs text-muted">{t('stock.items.quantity')}: {p.quantity}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {repair.parts.length === 0 ? (
        <p className="text-sm text-muted">{t('repairs.noParts')}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {repair.parts.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="font-semibold">{p.name}</span> × {p.quantity}
                {p.unitCost !== null && <span className="ms-2 text-muted">{money(p.unitCost)}</span>}
              </span>
              {!repair.closed && (
                <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" aria-label={t('common.remove')} onClick={() => remove.mutate(p.id)}>
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NotesCard({ repair }: { repair: Repair }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState(repair.notes);
  const save = useAction(
    () => api('repairs.update', { id: repair.id, fault: repair.fault, unlockNote: repair.unlockNote, estimatedPrice: repair.estimatedPrice, employeeId: repair.employeeId, dueAt: repair.dueAt, notes }),
    { success: t('common.saved'), invalidate: [['repairs']] },
  );
  return (
    <Card title={t('repairs.notes')} hint={t('repairs.notesHint')}>
      <textarea className="input min-h-[96px]" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Button className="mt-3" disabled={notes === repair.notes || save.isPending} onClick={() => save.mutate(undefined)}>
        {t('common.save')}
      </Button>
    </Card>
  );
}

function EditDialog({ repair, onClose }: { repair: Repair; onClose: () => void }) {
  const { t } = useTranslation();
  const technicians = useQuery({ queryKey: ['employees'], queryFn: () => api('employees.list') }).data;
  const [fault, setFault] = useState(repair.fault);
  const [unlockNote, setUnlockNote] = useState(repair.unlockNote);
  const [estimate, setEstimate] = useState<number | null>(repair.estimatedPrice);
  const [employeeId, setEmployeeId] = useState(repair.employeeId ?? '');
  const [due, setDue] = useState(repair.dueAt ? isoToDay(repair.dueAt) : '');
  const save = useAction(
    () => api('repairs.update', { id: repair.id, fault, unlockNote, estimatedPrice: estimate ?? 0, employeeId: employeeId || null, dueAt: due ? dayEndIso(due) : null, notes: repair.notes }),
    { success: t('repairs.updated'), invalidate: [['repairs']], onDone: onClose },
  );
  const open = !repair.closed;
  return (
    <Dialog title={t('repairs.edit')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !fault.trim() || !open}>
      {!open && <p className="text-sm text-muted">{t('errors.repair_closed')}</p>}
      <Field label={t('customers.fault')} required>
        <textarea className="input min-h-[64px]" disabled={!open} value={fault} onChange={(e) => setFault(e.target.value)} />
      </Field>
      <Field label={t('repairs.form.unlockNote')}>
        <Input disabled={!open} value={unlockNote} onChange={(e) => setUnlockNote(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('repairs.form.estimate')}>
          <MoneyInput value={estimate} onChange={setEstimate} />
        </Field>
        <Field label={t('repairs.form.dueDate')}>
          <Input type="date" dir="ltr" disabled={!open} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <Field label={t('repairs.form.technician')}>
        <select className="input" disabled={!open} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
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
