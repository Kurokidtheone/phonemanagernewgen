import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidImei } from '@shared/imei';
import { Dialog } from '@/components/Dialog';
import { Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { dayToIso, today, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printBuyBackSlip } from '@/lib/slips';
import { EMPTY_PICK, ModelPicker, pickInput, pickValid, type ModelPick } from './ModelPicker';
import { CONDITIONS } from './shared';

type Condition = (typeof CONDITIONS)[number];

/** Buy one phone from a private seller, paid in full, and print the slip. */
export function BuyBackDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const [sellerName, setSellerName] = useState('');
  const [sellerPhone, setSellerPhone] = useState('');
  const [sellerIdNumber, setSellerIdNumber] = useState('');
  const [pick, setPick] = useState<ModelPick>(EMPTY_PICK);
  const [imei, setImei] = useState('');
  const [condition, setCondition] = useState<Condition>('USED');
  const [battery, setBattery] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);

  const formatOk = isValidImei(imei);
  const status = useQuery({ queryKey: ['units', 'imei', imei], queryFn: () => api('units.imeiStatus', { imei }), enabled: formatOk });
  const imeiError = !imei ? undefined : !formatOk ? t('stock.phoneForm.imeiBad') : status.data?.duplicate ? t('stock.phoneForm.imeiTaken', { model: status.data.duplicate.model }) : undefined;
  const valid = !!sellerName.trim() && !!sellerPhone.trim() && !!sellerIdNumber.trim() && pickValid(pick) && formatOk && !imeiError && !status.isFetching && !!cost && !!price;

  const save = useAction(
    async () => {
      const result = await api('purchases.buyFromIndividual', {
        sellerName,
        sellerPhone,
        sellerIdNumber,
        date: dayToIso(today()),
        line: {
          imei1: imei,
          imei2: null,
          condition,
          batteryHealth: condition !== 'NEW' && battery ? Number(battery) : null,
          grade: null,
          cost: cost ?? 0,
          salePrice: price ?? 0,
          minPrice: 0,
          ...pickInput(pick),
        },
      });
      return result.id;
    },
    {
      success: t('stock.buyBack.saved'),
      invalidate: [['units'], ['models'], ['brands'], ['suppliers'], ['purchases']],
      onDone: (purchaseId) => {
        onClose();
        // The slip is offered right away; cancelling the print dialog is fine.
        if (settings) void api('purchases.get', { id: purchaseId }).then((p) => printBuyBackSlip(t, i18n.language, p, settings, money));
      },
    },
  );

  return (
    <Dialog wide title={t('stock.buyBack.title')} hint={t('stock.buyBack.hint')} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('stock.buyBack.confirm')} busy={save.isPending || !valid}>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('stock.buyBack.sellerName')} required>
          <Input autoFocus value={sellerName} onChange={(e) => setSellerName(e.target.value)} />
        </Field>
        <Field label={t('stock.supplier.phone')} required>
          <Input dir="ltr" value={sellerPhone} onChange={(e) => setSellerPhone(e.target.value)} />
        </Field>
        <Field label={t('stock.supplier.idNumber')} required>
          <Input dir="ltr" value={sellerIdNumber} onChange={(e) => setSellerIdNumber(e.target.value)} />
        </Field>
      </div>
      <ModelPicker value={pick} onChange={setPick} />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('stock.phoneForm.imei1')} required error={imeiError}>
          <Input className="mono" dir="ltr" inputMode="numeric" maxLength={15} value={imei} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} onChange={(e) => setImei(e.target.value.trim())} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('stock.phoneForm.condition')} required>
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
        <Field label={t('stock.buyBack.pricePaid')} required>
          <MoneyInput value={cost} onChange={setCost} />
        </Field>
        <Field label={t('stock.buyBack.plannedPrice')} required>
          <MoneyInput value={price} onChange={setPrice} />
        </Field>
      </div>
    </Dialog>
  );
}
