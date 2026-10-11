import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidImei } from '@shared/imei';
import { Dialog } from '@/components/Dialog';
import { Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { EMPTY_PICK, ModelPicker, pickInput, pickValid, type ModelPick } from '../stock/ModelPicker';
import { CONDITIONS } from '../stock/shared';

type Condition = (typeof CONDITIONS)[number];
export interface TradeIn {
  label: string;
  value: number;
  input: { imei1: string | null; imei2: null; condition: Condition; batteryHealth: number | null; grade: null; value: number } & ReturnType<typeof pickInput>;
}

/** The phone a customer hands over as part of the payment. It joins the stock as a used unit at cost = its value. */
export function TradeInDialog({ onSave, onClose }: { onSave: (t: TradeIn) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const models = useQuery({ queryKey: ['models'], queryFn: () => api('models.list') });
  const [pick, setPick] = useState<ModelPick>(EMPTY_PICK);
  const [imei, setImei] = useState('');
  const [condition, setCondition] = useState<Condition>('USED');
  const [battery, setBattery] = useState('');
  const [value, setValue] = useState<number | null>(null);

  const formatOk = isValidImei(imei);
  const status = useQuery({ queryKey: ['units', 'imei', imei], queryFn: () => api('units.imeiStatus', { imei }), enabled: formatOk });
  const imeiError = !imei ? undefined : !formatOk ? t('stock.phoneForm.imeiBad') : status.data?.duplicate ? t('stock.phoneForm.imeiTaken', { model: status.data.duplicate.model }) : undefined;
  // The IMEI is optional for a trade-in (it may be unreadable); when typed it must be right and not already registered.
  const valid = pickValid(pick) && (!imei || (formatOk && !imeiError)) && !status.isFetching && !!value;

  const save = (): void => {
    const picked = models.data?.find((m) => m.id === pick.modelId);
    const label = picked ? [picked.name, picked.storage].filter(Boolean).join(' ') : [pick.name, pick.storage].filter(Boolean).join(' ');
    onSave({
      label,
      value: value ?? 0,
      input: { imei1: imei || null, imei2: null, condition, batteryHealth: condition !== 'NEW' && battery ? Number(battery) : null, grade: null, value: value ?? 0, ...pickInput(pick) },
    });
  };

  return (
    <Dialog wide title={t('sell.tradeInTitle')} hint={t('sell.tradeInHint')} onClose={onClose} onSubmit={save} busy={!valid}>
      <ModelPicker value={pick} onChange={setPick} />
      <div className="grid grid-cols-2 gap-3">
        <Field label={`${t('stock.phoneForm.imei1')} (${t('common.optional')})`} error={imeiError}>
          <Input autoFocus className="mono" dir="ltr" inputMode="numeric" maxLength={15} value={imei} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} onChange={(e) => setImei(e.target.value.trim())} />
        </Field>
        <Field label={t('sell.tradeInValue')} required>
          <MoneyInput value={value} onChange={setValue} />
        </Field>
        <Field label={t('stock.phoneForm.condition')}>
          <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {t(`stock.condition.${c}`)}
              </option>
            ))}
          </select>
        </Field>
        {condition !== 'NEW' && (
          <Field label={t('stock.phoneForm.battery')}>
            <Input type="number" min={0} max={100} dir="ltr" value={battery} onChange={(e) => setBattery(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
