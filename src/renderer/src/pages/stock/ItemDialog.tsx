import { useQuery } from '@tanstack/react-query';
import { Printer, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { SearchSelect } from '@/components/SearchSelect';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { LabelDialog } from './LabelDialog';
import { ADJUST_REASONS } from './shared';

type Item = ApiResult<'items.list'>[number];

/** Add or edit an accessory or part. Editing also offers quantity adjustment, labels and delete. */
export function ItemDialog({ item, prefillBarcode, onClose }: { item?: Item; prefillBarcode?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api('categories.list') });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api('brands.list') });
  const itemCategories = categories.data?.filter((c) => c.kind !== 'PHONE') ?? [];

  const [name, setName] = useState(item?.name ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [brandId, setBrandId] = useState(item?.brandId ?? '');
  const [barcode, setBarcode] = useState(item?.barcode ?? prefillBarcode ?? '');
  const [price, setPrice] = useState<number | null>(item?.salePrice ?? null);
  const [minPrice, setMinPrice] = useState<number | null>(item?.minPrice ?? null);
  const [cost, setCost] = useState<number | null>(item?.avgCost ?? null);
  const costHidden = !!item && item.avgCost === null; // Finance locked: leave the stored cost alone
  const [threshold, setThreshold] = useState(String(item?.lowStockThreshold ?? 0));
  const [warranty, setWarranty] = useState(String(item?.defaultWarrantyDays ?? 0));
  const [repairPart, setRepairPart] = useState(item?.isRepairPart ?? false);
  const [adjusting, setAdjusting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [labelling, setLabelling] = useState(false);

  const category = categoryId || itemCategories[0]?.id || '';
  const valid = !!name.trim() && !!category && price !== null;

  const save = useAction(
    async () => {
      const fields = {
        name,
        categoryId: category,
        brandId: brandId || null,
        barcode: barcode.trim() || null,
        salePrice: price ?? 0,
        minPrice: minPrice ?? 0,
        avgCost: costHidden ? undefined : (cost ?? 0),
        lowStockThreshold: Math.max(0, Math.floor(Number(threshold)) || 0),
        defaultWarrantyDays: Math.max(0, Math.floor(Number(warranty)) || 0),
        isRepairPart: repairPart,
      };
      if (item) await api('items.update', { id: item.id, ...fields });
      else await api('items.create', fields);
    },
    { success: item ? t('stock.itemForm.updated') : t('stock.itemForm.saved'), invalidate: [['items']], onDone: onClose },
  );
  const createBrand = useAction((name: string) => api('brands.create', { name }), { invalidate: [['brands']], onDone: (b) => setBrandId(b.id) });
  // A category typed here is saved at once, so it is offered in the list next time.
  const createCategory = useAction((name: string) => api('categories.create', { name, kind: repairPart ? 'PART' : 'ACCESSORY' }), {
    success: t('stock.itemForm.categoryAdded'),
    invalidate: [['categories']],
    onDone: (c) => setCategoryId(c.id),
  });
  const generate = useAction(() => api('items.generateBarcode'), { onDone: setBarcode });
  const remove = useAction(() => api('items.delete', { id: item!.id }), { success: t('stock.itemForm.deleted'), invalidate: [['items']], onDone: onClose });

  return (
    <>
      <Dialog
        wide
        title={item ? t('stock.itemForm.editTitle') : t('stock.itemForm.title')}
        onClose={onClose}
        onSubmit={() => save.mutate(undefined)}
        busy={save.isPending || !valid}
      >
        {itemCategories.length === 0 && categories.isSuccess && <p className="text-sm text-danger">{t('stock.itemForm.noCategory')}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('stock.itemForm.name')} required>
            <Input autoFocus={!barcode} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('stock.itemForm.category')} required>
            <SearchSelect options={itemCategories} value={category} onChange={setCategoryId} placeholder={t('stock.itemForm.pickCategory')} onCreate={(name) => createCategory.mutate(name)} />
          </Field>
          <Field label={t('stock.itemForm.brand')}>
            <SearchSelect options={brands.data ?? []} value={brandId} onChange={setBrandId} placeholder={t('stock.itemForm.noBrand')} emptyLabel={t('stock.itemForm.noBrand')} onCreate={(name) => createBrand.mutate(name)} />
          </Field>
          <Field label={t('stock.itemForm.barcode')}>
            <div className="flex gap-2">
              <Input
                className="mono"
                dir="ltr"
                autoFocus={!!barcode}
                value={barcode}
                placeholder={t('stock.itemForm.barcodeHint')}
                // A scanner ends with Enter: it must not submit the form.
                onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                onChange={(e) => setBarcode(e.target.value.trim())}
              />
              <Button icon={Sparkles} disabled={generate.isPending} onClick={() => generate.mutate(undefined)}>
                {t('stock.itemForm.generate')}
              </Button>
            </div>
          </Field>
          <Field label={t('stock.itemForm.salePrice')} required>
            <MoneyInput value={price} onChange={setPrice} />
          </Field>
          <Field label={t('stock.itemForm.minPrice')}>
            <MoneyInput value={minPrice} onChange={setMinPrice} />
          </Field>
          {!costHidden && (
            <Field label={t('stock.itemForm.cost')}>
              <MoneyInput value={cost} onChange={setCost} />
            </Field>
          )}
          <Field label={t('stock.itemForm.threshold')}>
            <Input type="number" min={0} dir="ltr" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label={t('stock.itemForm.warranty')}>
            <Input type="number" min={0} dir="ltr" value={warranty} onChange={(e) => setWarranty(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={repairPart} onChange={(e) => setRepairPart(e.target.checked)} />
          {t('stock.itemForm.repairPart')}
        </label>
        {item && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="me-auto text-sm">
              {t('stock.items.quantity')}: <b>{item.quantity}</b>
            </span>
            <Button icon={SlidersHorizontal} onClick={() => setAdjusting(true)}>
              {t('stock.itemForm.adjust')}
            </Button>
            <Button icon={Printer} onClick={() => setLabelling(true)}>
              {t('stock.labels.print')}
            </Button>
            <Button icon={Trash2} className="text-danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </div>
        )}
      </Dialog>
      {item && adjusting && <AdjustDialog item={item} onClose={() => setAdjusting(false)} onDone={onClose} />}
      {item && labelling && <LabelDialog sources={[{ name: item.name, price: item.salePrice, code: item.barcode }]} onClose={() => setLabelling(false)} />}
      {deleting && (
        <ConfirmDialog
          title={t('stock.itemForm.deleteTitle')}
          body={t('stock.itemForm.deleteBody')}
          confirmLabel={t('common.delete')}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(undefined)}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

function AdjustDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<(typeof ADJUST_REASONS)[number]>('COUNT_CORRECTION');
  const change = Math.trunc(Number(delta)) || 0;
  const after = item.quantity + change;
  const save = useAction(() => api('items.adjust', { id: item.id, delta: change, reason }), {
    success: t('stock.itemForm.adjusted'),
    invalidate: [['items']],
    onDone: () => {
      onClose();
      onDone();
    },
  });
  return (
    <Dialog title={t('stock.itemForm.adjustTitle', { name: item.name })} hint={t('stock.itemForm.adjustHint')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || change === 0 || after < 0}>
      <Field label={t('stock.itemForm.delta')} error={after < 0 ? t('errors.quantity_negative') : undefined}>
        <Input autoFocus type="number" dir="ltr" value={delta} placeholder="+5 / -2" onChange={(e) => setDelta(e.target.value)} />
      </Field>
      <Field label={t('stock.itemForm.reason')}>
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          {ADJUST_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`stock.reasons.${r}`)}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-muted">
        {item.quantity} → <b className="text-ink">{after}</b>
      </p>
    </Dialog>
  );
}
