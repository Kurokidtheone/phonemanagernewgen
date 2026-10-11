import { useQuery } from '@tanstack/react-query';
import { Plus, ScanLine, ShoppingBag, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { isValidImei } from '@shared/imei';
import { PageBody, PageHeader } from '@/components/Page';
import { Badge, Button, Card, Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { dayToIso, today, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printBuyBackSlip } from '@/lib/slips';
import { toast } from '@/lib/toast';
import { EMPTY_PICK, ModelPicker, pickInput, pickValid, type ModelPick } from './ModelPicker';
import { CONDITIONS } from './shared';
import { SupplierDialog } from './SupplierDialog';
import { FilePicker } from '@/components/FilePicker';
import { DOCUMENT_EXTENSIONS } from '@/lib/files';

type Condition = (typeof CONDITIONS)[number];
interface ItemLine { productId: string; name: string; quantity: number; unitCost: number }
interface PhoneLine { key: string; pick: ModelPick; label: string; imei1: string; condition: Condition; batteryHealth: number | null; cost: number; salePrice: number }

/**
 * Receive stock from a supplier. One search box does it all: scan or type an item to add it,
 * scan IMEIs one after another to add phones of the model chosen in "Phones", Enter adds.
 */
export function NewPurchasePage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const settings = useSettings().data;
  const searchRef = useRef<HTMLInputElement>(null);

  const [supplierId, setSupplierId] = useState('');
  const [newSupplier, setNewSupplier] = useState(false);
  const [day, setDay] = useState(today());
  const [note, setNote] = useState('');
  const [invoicePath, setInvoicePath] = useState<string | null>(null);
  const [paid, setPaid] = useState<number | null>(null);
  const [paidRound, setPaidRound] = useState(0);
  const [items, setItems] = useState<ItemLine[]>([]);
  const [phones, setPhones] = useState<PhoneLine[]>([]);
  const [text, setText] = useState('');
  // Defaults used for every IMEI scanned next.
  const [pick, setPick] = useState<ModelPick>(EMPTY_PICK);
  const [condition, setCondition] = useState<Condition>('NEW');
  const [battery, setBattery] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [defaultsRound, setDefaultsRound] = useState(0);

  const suppliers = useQuery({ queryKey: ['suppliers', 'list'], queryFn: () => api('suppliers.list') });
  const catalogItems = useQuery({ queryKey: ['items', 'list', '', false, false], queryFn: () => api('items.list', {}) });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api('models.list') });
  const supplier = suppliers.data?.find((s) => s.id === supplierId);
  const individual = supplier?.kind === 'INDIVIDUAL';

  const total = items.reduce((s, l) => s + l.quantity * l.unitCost, 0) + phones.reduce((s, l) => s + l.cost, 0);
  const effectivePaid = individual ? total : (paid ?? 0);
  const lineCount = items.length + phones.length;
  const valid = !!supplier && lineCount > 0 && effectivePaid <= total && items.every((l) => l.quantity > 0);

  const q = text.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q || /^\d{15}$/.test(q)) return { items: [], models: [] };
    return {
      items: (catalogItems.data ?? []).filter((i) => i.name.toLowerCase().includes(q) || (i.barcode ?? '').includes(q)).slice(0, 6),
      models: (models.data ?? []).filter((m) => `${m.name} ${m.storage} ${m.color}`.toLowerCase().includes(q)).slice(0, 4),
    };
  }, [q, catalogItems.data, models.data]);

  const addItem = (item: { id: string; name: string; avgCost: number | null }): void => {
    setItems((list) => {
      const at = list.findIndex((l) => l.productId === item.id);
      if (at >= 0) return list.map((l, i) => (i === at ? { ...l, quantity: l.quantity + 1 } : l));
      return [...list, { productId: item.id, name: item.name, quantity: 1, unitCost: item.avgCost ?? 0 }];
    });
    setText('');
    searchRef.current?.focus();
  };
  const chooseModel = (m: NonNullable<typeof models.data>[number]): void => {
    setPick({ ...EMPTY_PICK, modelId: m.id });
    setCost(m.avgCost || null);
    setPrice(m.salePrice || null);
    setDefaultsRound((r) => r + 1);
    setText('');
    searchRef.current?.focus();
  };

  const addImei = async (imei: string): Promise<void> => {
    if (!isValidImei(imei)) return void toast.error(t('stock.phoneForm.imeiBad'));
    if (!pickValid(pick) || !cost || !price) return void toast.error(t('stock.purchaseNew.needDefaults'));
    if (phones.some((p) => p.imei1 === imei)) return void toast.error(t('stock.purchaseNew.imeiTwice'));
    const status = await api('units.imeiStatus', { imei });
    if (status.duplicate) return void toast.error(t('stock.phoneForm.imeiTaken', { model: status.duplicate.model }));
    const picked = models.data?.find((m) => m.id === pick.modelId);
    const brand = picked ? picked.name : `${pick.name} ${pick.storage}`.trim();
    setPhones((list) => [
      ...list,
      { key: imei, pick, label: [brand, picked?.storage, picked?.color].filter(Boolean).join(' '), imei1: imei, condition, batteryHealth: condition !== 'NEW' && battery ? Number(battery) : null, cost, salePrice: price },
    ]);
    setText('');
  };

  const onEnter = (): void => {
    const value = text.trim();
    if (!value) return;
    if (/^\d{15}$/.test(value)) return void addImei(value).catch(() => toast.error(t('errors.unexpected')));
    const exact = (catalogItems.data ?? []).find((i) => i.barcode === value);
    if (exact) return addItem(exact);
    if (matches.items[0]) return addItem(matches.items[0]);
    if (matches.models[0]) return chooseModel(matches.models[0]);
    toast.error(t('stock.purchaseNew.notFound', { code: value }));
  };

  const save = useAction(
    async () => {
      const result = await api('purchases.create', {
        supplierId,
        date: dayToIso(day),
        paid: effectivePaid,
        note,
        invoicePath,
        itemLines: items.map(({ productId, quantity, unitCost }) => ({ productId, quantity, unitCost })),
        phoneLines: phones.map((p) => ({ imei1: p.imei1, imei2: null, condition: p.condition, batteryHealth: p.batteryHealth, grade: null, cost: p.cost, salePrice: p.salePrice, minPrice: 0, ...pickInput(p.pick) })),
      });
      return result.id;
    },
    {
      success: t('stock.purchaseNew.saved'),
      invalidate: [['purchases'], ['suppliers'], ['items'], ['units'], ['models'], ['brands']],
      onDone: (id) => {
        navigate('/stock?tab=purchases');
        if (individual && settings) void api('purchases.get', { id }).then((p) => printBuyBackSlip(t, i18n.language, p, settings, money));
      },
    },
  );

  return (
    <PageBody>
      <PageHeader icon={ShoppingBag} title={t('stock.purchaseNew.title')} subtitle={t('stock.purchaseNew.subtitle')} back={{ to: '/stock?tab=purchases', label: t('stock.purchaseNew.back') }} />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('stock.purchases.supplier')} required>
                <div className="flex gap-2">
                  <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">{t('stock.purchaseNew.pickSupplier')}</option>
                    {suppliers.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <Button icon={Plus} onClick={() => setNewSupplier(true)} aria-label={t('stock.supplier.add')} />
                </div>
              </Field>
              <Field label={t('stock.purchases.date')}>
                <Input type="date" dir="ltr" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} />
              </Field>
              <Field label={t('stock.purchaseNew.invoice')}>
                <FilePicker value={invoicePath} onChange={setInvoicePath} extensions={DOCUMENT_EXTENSIONS} />
              </Field>
            </div>
            {individual && <p className="mt-3 rounded-lg bg-paper p-3 text-sm text-muted">{t('stock.purchaseNew.individualNote')}</p>}
          </Card>

          <Card title={t('stock.purchaseNew.phonesTitle')} hint={t('stock.purchaseNew.phonesHint')}>
            <ModelPicker value={pick} onChange={setPick} />
            <div className="mt-3 grid grid-cols-4 gap-3">
              <Field label={t('stock.phoneForm.condition')}>
                <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {t(`stock.condition.${c}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {condition !== 'NEW' ? (
                <Field label={t('stock.phoneForm.battery')}>
                  <Input type="number" min={0} max={100} dir="ltr" value={battery} onChange={(e) => setBattery(e.target.value)} />
                </Field>
              ) : (
                <div />
              )}
              <Field label={t('stock.phoneForm.cost')} required>
                <MoneyInput key={`c${defaultsRound}`} value={cost} onChange={setCost} />
              </Field>
              <Field label={t('stock.phoneForm.salePrice')} required>
                <MoneyInput key={`p${defaultsRound}`} value={price} onChange={setPrice} />
              </Field>
            </div>
          </Card>

          <Card>
            <div className="relative mb-4">
              <ScanLine size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input
                ref={searchRef}
                autoFocus
                className="input ps-9"
                dir="ltr"
                value={text}
                placeholder={t('stock.purchaseNew.search')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onEnter();
                  }
                }}
              />
              {(matches.items.length > 0 || matches.models.length > 0) && (
                <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-xl">
                  {matches.items.map((i) => (
                    <li key={i.id}>
                      <button type="button" className="flex w-full justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-paper" onClick={() => addItem(i)}>
                        <span className="font-semibold">{i.name}</span>
                        <span className="mono text-xs text-muted">{i.barcode}</span>
                      </button>
                    </li>
                  ))}
                  {matches.models.map((m) => (
                    <li key={m.id}>
                      <button type="button" className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-paper" onClick={() => chooseModel(m)}>
                        <span className="font-semibold">{[m.name, m.storage, m.color].filter(Boolean).join(' · ')}</span>
                        <Badge tone="accent">{t('stock.purchaseNew.phoneModel')}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {lineCount === 0 ? (
              <p className="py-8 text-center text-sm text-muted">{t('stock.purchaseNew.empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-paper text-muted">
                      <th className="px-3 py-2 text-start">{t('stock.items.name')}</th>
                      <th className="w-24 px-3 py-2 text-end">{t('stock.items.quantity')}</th>
                      <th className="w-36 px-3 py-2 text-end">{t('stock.items.cost')}</th>
                      <th className="w-32 px-3 py-2 text-end">{t('stock.purchases.total')}</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((l) => (
                      <tr key={l.productId} className="border-t border-line">
                        <td className="px-3 py-2 font-semibold">{l.name}</td>
                        <td className="px-3 py-2">
                          <Input type="number" min={1} dir="ltr" value={l.quantity} onChange={(e) => setItems((list) => list.map((x) => (x.productId === l.productId ? { ...x, quantity: Math.max(0, Math.floor(Number(e.target.value)) || 0) } : x)))} />
                        </td>
                        <td className="px-3 py-2">
                          <MoneyInput value={l.unitCost || null} onChange={(v) => setItems((list) => list.map((x) => (x.productId === l.productId ? { ...x, unitCost: v ?? 0 } : x)))} />
                        </td>
                        <td className="px-3 py-2 text-end font-semibold">{money(l.quantity * l.unitCost)}</td>
                        <td>
                          <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" aria-label={t('common.remove')} onClick={() => setItems((list) => list.filter((x) => x.productId !== l.productId))}>
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {phones.map((l) => (
                      <tr key={l.key} className="border-t border-line">
                        <td className="px-3 py-2">
                          <span className="font-semibold">{l.label}</span> <Badge>{t(`stock.condition.${l.condition}`)}</Badge>
                          <span className="mono block text-xs text-muted" dir="ltr">{l.imei1}</span>
                        </td>
                        <td className="px-3 py-2 text-end">1</td>
                        <td className="px-3 py-2">
                          <MoneyInput value={l.cost} onChange={(v) => setPhones((list) => list.map((x) => (x.key === l.key ? { ...x, cost: v ?? 0 } : x)))} />
                        </td>
                        <td className="px-3 py-2 text-end font-semibold">{money(l.cost)}</td>
                        <td>
                          <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" aria-label={t('common.remove')} onClick={() => setPhones((list) => list.filter((x) => x.key !== l.key))}>
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <aside className="h-fit space-y-4 rounded-2xl border border-line bg-card p-5 lg:sticky lg:top-4">
          <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
            <dt className="text-muted">{t('stock.purchases.lines')}</dt>
            <dd className="text-end font-semibold">{lineCount}</dd>
            <dt className="text-muted">{t('stock.purchases.total')}</dt>
            <dd className="text-end text-xl font-bold text-accent">{money(total)}</dd>
          </dl>
          <Field label={t('stock.purchaseNew.paidNow')}>
            {individual ? (
              <p className="input mono bg-paper">{money(total)}</p>
            ) : (
              <div className="flex gap-2">
                <MoneyInput key={`paid${paidRound}`} value={paid} onChange={setPaid} />
                <Button onClick={() => { setPaid(total); setPaidRound((r) => r + 1); }}>{t('stock.purchaseNew.payFull')}</Button>
              </div>
            )}
          </Field>
          <p className="flex justify-between text-sm">
            <span className="text-muted">{t('stock.purchases.remaining')}</span>
            <b className={total - effectivePaid > 0 ? 'text-danger' : ''}>{money(Math.max(0, total - effectivePaid))}</b>
          </p>
          {effectivePaid > total && <p className="text-sm text-danger">{t('errors.paid_exceeds_total')}</p>}
          <Field label={t('stock.purchaseNew.note')}>
            <textarea className="input min-h-[64px]" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" disabled={!valid || save.isPending} onClick={() => save.mutate(undefined)}>
            {t('stock.purchaseNew.confirm')}
          </Button>
        </aside>
      </div>
      {newSupplier && <SupplierDialog onClose={() => setNewSupplier(false)} onSaved={setSupplierId} />}
    </PageBody>
  );
}
