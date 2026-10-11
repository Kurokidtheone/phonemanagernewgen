// Receive stock: supplier, then phones (model and prices once, IMEIs scanned one after another) and accessories,
// then review and save in ONE request. The draft is kept on the phone until the PC has saved it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Plus, ScanLine, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Field, inputClass, Row } from '@/components/ui';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { api, errorText, uploadImage } from '@/lib/api';
import { getDraft, setDraft, useDraft } from '@/lib/draftStore';
import { prepareImage } from '@/lib/photo';
import { addGroup, addImei, addItem, draftTotal, hasImei, isEmpty, phoneCount, removeImei, removeItem, toPurchaseInput, withoutEmptyGroups, type Condition, type Draft } from '@/lib/receive';
import { openScanner, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';
import { ItemPicker, ModelPicker, type ItemChoice, type ModelChoice } from './pickers';

type Step = 'supplier' | 'lines' | 'review';

export function Receive({ onExit }: { onExit: () => void }) {
  const { t } = useTranslation();
  const draft = useDraft();
  const [step, setStep] = useState<Step>(() => (draft?.supplierId ? 'lines' : 'supplier'));
  if (!draft) return null;

  const discard = (): void => {
    setDraft(null);
    onExit();
  };
  const back = step === 'supplier' ? onExit : step === 'lines' ? () => setStep('supplier') : () => setStep('lines');
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader
        title={t('m.receive.title')}
        onBack={back}
        right={
          !isEmpty(draft) || draft.supplierId ? (
            <button className="min-h-touch px-3 text-sm text-danger" onClick={discard}>
              {t('m.stock.discard')}
            </button>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === 'supplier' && <SupplierStep draft={draft} onDone={() => setStep('lines')} />}
        {step === 'lines' && <LinesStep draft={draft} onReview={() => setStep('review')} />}
        {step === 'review' && <ReviewStep draft={draft} onSaved={onExit} />}
      </div>
    </div>
  );
}

function SupplierStep({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api('suppliers.list') });
  const needle = q.trim().toLowerCase();
  const rows = (suppliers.data ?? []).filter((s) => s.kind === 'COMPANY' && (!needle || s.name.toLowerCase().includes(needle)));
  const pick = (id: string, label: string): void => {
    setDraft({ ...draft, supplierId: id, supplierName: label });
    onDone();
  };
  const create = async (): Promise<void> => {
    try {
      const s = await api('suppliers.create', { name, phone, kind: 'COMPANY' });
      await client.invalidateQueries({ queryKey: ['suppliers'] });
      pick(s.id, name.trim());
    } catch (err) {
      toast(errorText(t, err));
    }
  };
  return (
    <div className="p-3">
      <h3 className="pb-2 font-semibold">{t('m.receive.chooseSupplier')}</h3>
      <input className={inputClass} placeholder={t('m.receive.searchSupplier')} value={q} onChange={(e) => setQ(e.target.value)} />
      <Button className="mt-2 w-full" icon={Plus} onClick={() => setCreating(true)}>
        {t('m.receive.newSupplier')}
      </Button>
      <div className="mt-2">
        {rows.map((s) => (
          <Row key={s.id} title={s.name} subtitle={s.phone} right={draft.supplierId === s.id ? '✓' : undefined} onClick={() => pick(s.id, s.name)} />
        ))}
      </div>
      {creating && (
        <Sheet title={t('m.receive.newSupplier')} onClose={() => setCreating(false)} closeLabel={t('common.cancel')}>
          <div className="space-y-3">
            <Field label={t('m.receive.supplierName')}>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label={t('m.receive.supplierPhone')}>
              <input dir="ltr" className={inputClass} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Button variant="primary" className="w-full" disabled={!name.trim()} onClick={() => void create()}>
              {t('m.receive.create')}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

const CONDITIONS: Condition[] = ['NEW', 'USED', 'REFURBISHED'];

function LinesStep({ draft, onReview }: { draft: Draft; onReview: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const [addingPhones, setAddingPhones] = useState(false);
  const [addingItem, setAddingItem] = useState(false);

  /** Scan IMEIs one after another: each valid new one becomes a line, an IMEI already in stock is refused with the reason. */
  const scanInto = async (groupId: string): Promise<void> => {
    try {
      await openScanner({
        title: t('m.receive.scanImeis'),
        imei: true,
        onRead: async (imei) => {
          const current = getDraft()!;
          if (hasImei(current, imei)) return { ok: false, message: t('m.receive.alreadyScanned') };
          const status = await api('units.imeiStatus', { imei });
          if (status.duplicate) return { ok: false, message: t('errors.imei_duplicate', { model: status.duplicate.model }) };
          setDraft(addImei(current, groupId, imei));
          return { ok: true, message: t('m.receive.added', { name: current.phones.find((g) => g.id === groupId)?.label ?? '' }) };
        },
      });
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
  };

  const total = draftTotal(draft);
  return (
    <div>
      <Row title={t('m.receive.supplier')} right={draft.supplierName} />
      <div className="grid grid-cols-2 gap-2 p-3">
        <Button variant="primary" icon={ScanLine} onClick={() => setAddingPhones(true)}>
          {t('m.receive.addPhones')}
        </Button>
        <Button icon={Plus} onClick={() => setAddingItem(true)}>
          {t('m.receive.addAccessory')}
        </Button>
      </div>

      {isEmpty(draft) && <Empty>{t('m.receive.nothingYet')}</Empty>}
      {draft.phones.map((g) => (
        <div key={g.id} className="border-b border-line">
          <div className="flex items-center justify-between px-4 pt-3">
            <div className="font-semibold">{g.label}</div>
            <div className="text-sm text-muted">{money(g.cost)}</div>
          </div>
          <div className="px-4 pb-1 text-sm text-muted">{t('m.receive.imeis', { n: g.imeis.length })}</div>
          {g.imeis.map((imei) => (
            <div key={imei} className="flex items-center justify-between px-4">
              <span dir="ltr" className="mono">
                {imei}
              </span>
              <button className="flex h-12 w-12 items-center justify-center text-danger" aria-label={t('m.receive.remove')} onClick={() => setDraft(removeImei(draft, imei))}>
                <Trash2 className="h-5 w-5" />
              </button>
            </div>
          ))}
          <div className="p-3">
            <Button icon={ScanLine} className="w-full" onClick={() => void scanInto(g.id)}>
              {t('m.receive.scanMore')}
            </Button>
          </div>
        </div>
      ))}
      {draft.items.map((l, i) => (
        <Row
          key={`${l.productId}-${i}`}
          title={l.name}
          subtitle={`${l.quantity} × ${money(l.unitCost)}`}
          right={
            <button className="flex h-12 w-12 items-center justify-center text-danger" aria-label={t('m.receive.remove')} onClick={() => setDraft(removeItem(draft, i))}>
              <Trash2 className="h-5 w-5" />
            </button>
          }
        />
      ))}

      <div className="sticky bottom-0 border-t border-line bg-card p-3">
        <Button variant="primary" className="w-full" disabled={isEmpty(withoutEmptyGroups(draft))} onClick={onReview}>
          {t('m.receive.review')} · {money(total)}
        </Button>
      </div>

      {addingPhones && (
        <PhoneGroupSheet
          onClose={() => setAddingPhones(false)}
          onCreate={(g) => {
            const { draft: next, id } = addGroup(draft, g);
            setDraft(next);
            setAddingPhones(false);
            void scanInto(id);
          }}
        />
      )}
      {addingItem && (
        <ItemSheet
          onClose={() => setAddingItem(false)}
          onAdd={(line) => {
            setDraft(addItem(draft, line));
            setAddingItem(false);
          }}
        />
      )}
    </div>
  );
}

/** Model, condition and the two prices, typed once for the whole run of IMEIs. */
function PhoneGroupSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (g: { productId: string; label: string; condition: Condition; cost: number; salePrice: number }) => void }) {
  const { t } = useTranslation();
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [condition, setCondition] = useState<Condition>('NEW');
  const [cost, setCost] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  return (
    <Sheet title={t('m.receive.addPhones')} onClose={onClose}>
      {!model ? (
        <ModelPicker
          onPick={(m) => {
            setModel(m);
            setPrice(m.salePrice);
          }}
        />
      ) : (
        <div className="space-y-3">
          <div className="font-semibold">{model.label}</div>
          <Field label={t('m.receive.condition')}>
            <select className={inputClass} value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`stock.condition.${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('m.receive.cost')}>
            <MoneyField value={cost} onChange={setCost} />
          </Field>
          <Field label={t('m.receive.salePrice')}>
            <MoneyField value={price} onChange={setPrice} />
          </Field>
          <Button variant="primary" icon={ScanLine} className="w-full" disabled={cost === null || !price} onClick={() => onCreate({ productId: model.id, label: model.label, condition, cost: cost!, salePrice: price! })}>
            {t('m.receive.scanImeis')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function ItemSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (line: { productId: string; name: string; quantity: number; unitCost: number }) => void }) {
  const { t } = useTranslation();
  const [item, setItem] = useState<ItemChoice | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState<number | null>(null);
  const qty = Number.parseInt(quantity, 10);
  return (
    <Sheet title={t('m.receive.addAccessory')} onClose={onClose}>
      {!item ? (
        <ItemPicker onPick={setItem} />
      ) : (
        <div className="space-y-3">
          <div className="font-semibold">{item.name}</div>
          <Field label={t('m.receive.quantity')}>
            <input dir="ltr" className={inputClass} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>
          <Field label={t('m.receive.unitCost')}>
            <MoneyField value={cost} onChange={setCost} />
          </Field>
          <Button variant="primary" className="w-full" disabled={!(qty > 0) || cost === null} onClick={() => onAdd({ productId: item.id, name: item.name, quantity: qty, unitCost: cost! })}>
            {t('m.receive.addLine')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function ReviewStep({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const total = draftTotal(draft);
  const clean = withoutEmptyGroups(draft);

  const photo = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setBusy(true);
    try {
      const { base64, contentType } = await prepareImage(f);
      setDraft({ ...draft, invoiceFile: await uploadImage(base64, contentType) });
      toast(t('m.receive.photoAdded'));
    } catch (err) {
      toast(errorText(t, err) === t('errors.unexpected') ? t('m.receive.uploadFailed') : errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  /** One request. If it fails, nothing is lost: the draft stays, with the same request id for the retry. */
  const save = async (): Promise<void> => {
    if (!draft.supplierId) return setError(t('m.receive.noSupplier'));
    setBusy(true);
    setError('');
    try {
      await api('purchases.create', toPurchaseInput(clean));
      setDraft(null);
      void client.invalidateQueries();
      toast(t('m.receive.saved'));
      onSaved();
    } catch (err) {
      setError(`${t('m.receive.saveFailed')} (${errorText(t, err)})`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-3 pb-8">
      <Row title={t('m.receive.supplier')} right={draft.supplierName} />
      <Row title={t('m.receive.phones')} right={phoneCount(clean)} />
      <Row title={t('m.receive.accessories')} right={clean.items.length} />
      <Row title={t('m.receive.total')} right={<span className="text-lg font-bold">{money(total)}</span>} />
      <Field label={t('m.receive.paidNow')}>
        <MoneyField value={draft.paid} onChange={(v) => setDraft({ ...draft, paid: Math.min(v ?? 0, total) })} />
      </Field>
      <Row title={t('m.receive.remaining')} right={money(Math.max(0, total - draft.paid))} />
      <Field label={t('m.receive.note')}>
        <input className={inputClass} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      </Field>
      <div>
        <input ref={file} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void photo(e.target.files?.[0])} />
        <div className="flex gap-2">
          <Button icon={Camera} className="flex-1" disabled={busy} onClick={() => file.current?.click()}>
            {draft.invoiceFile ? t('m.receive.photoAdded') : t('m.receive.takePhoto')}
          </Button>
          {draft.invoiceFile && (
            <Button onClick={() => setDraft({ ...draft, invoiceFile: null })} aria-label={t('m.receive.removePhoto')}>
              <Trash2 className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>
      {error && <div className="rounded-xl bg-danger/15 p-3 text-danger">{error}</div>}
      <Button variant="primary" className="w-full" busy={busy} disabled={isEmpty(clean)} onClick={() => void save()}>
        {busy ? t('m.receive.saving') : t('m.receive.save')}
      </Button>
    </div>
  );
}
