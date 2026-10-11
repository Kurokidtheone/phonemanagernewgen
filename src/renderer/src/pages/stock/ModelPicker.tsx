import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SearchSelect } from '@/components/SearchSelect';
import { Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';

/** Which phone model a unit belongs to: an existing one, or a new one (brand, name, storage, colour). */
export interface ModelPick {
  modelId: string;
  brandId: string;
  name: string;
  storage: string;
  color: string;
}

export const EMPTY_PICK: ModelPick = { modelId: '', brandId: '', name: '', storage: '', color: '' };

export const pickValid = (p: ModelPick): boolean => !!p.modelId || (!!p.brandId && !!p.name.trim());

/** The part of an IPC input that names the model. */
export const pickInput = (p: ModelPick) =>
  p.modelId ? { productId: p.modelId } : { model: { brandId: p.brandId, name: p.name.trim(), storage: p.storage.trim(), color: p.color.trim() } };

export function ModelPicker({ value, onChange }: { value: ModelPick; onChange: (next: ModelPick) => void }) {
  const { t } = useTranslation();
  const models = useQuery({ queryKey: ['models'], queryFn: () => api('models.list') });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api('brands.list') });
  const set = (patch: Partial<ModelPick>): void => onChange({ ...value, ...patch });
  const createBrand = useAction((name: string) => api('brands.create', { name }), { invalidate: [['brands']], onDone: (b) => set({ brandId: b.id }) });
  const picked = models.data?.some((m) => m.id === value.modelId);

  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <Field label={t('stock.phoneForm.model')}>
        <select className="input" value={value.modelId} onChange={(e) => set({ modelId: e.target.value })}>
          <option value="">{t('stock.phoneForm.newModel')}</option>
          {models.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {[m.name, m.storage, m.color].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </Field>
      {!picked && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('stock.phoneForm.brand')} required>
            <SearchSelect options={brands.data ?? []} value={value.brandId} onChange={(id) => set({ brandId: id })} placeholder={t('stock.phoneForm.pickBrand')} onCreate={(name) => createBrand.mutate(name)} />
          </Field>
          <Field label={t('stock.phoneForm.modelName')} required>
            <Input value={value.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t('stock.phoneForm.storage')}>
            <Input value={value.storage} placeholder="128GB" dir="ltr" onChange={(e) => set({ storage: e.target.value })} />
          </Field>
          <Field label={t('stock.phoneForm.color')}>
            <Input value={value.color} onChange={(e) => set({ color: e.target.value })} />
          </Field>
        </div>
      )}
    </div>
  );
}
