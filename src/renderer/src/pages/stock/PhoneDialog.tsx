import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidImei } from '@shared/imei';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { EMPTY_PICK, ModelPicker, pickInput, pickValid, type ModelPick } from './ModelPicker';
import { CONDITIONS } from './shared';

type Unit = ApiResult<'units.get'>;
type Condition = (typeof CONDITIONS)[number];

/**
 * Add a phone unit (pick or create its model first) or edit an existing one.
 * "Save and add another" keeps the model and prices so several units of one phone go in fast.
 */
export function PhoneDialog({ unit, prefillImei, onClose }: { unit?: Unit; prefillImei?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const editing = !!unit;
  const models = useQuery({ queryKey: ['models'], queryFn: () => api('models.list') });

  const [pick, setPick] = useState<ModelPick>({ ...EMPTY_PICK, modelId: unit?.productId ?? '' });
  const modelId = pick.modelId;
  const [imei1, setImei1] = useState(unit?.imei1 ?? prefillImei ?? '');
  const [imei2, setImei2] = useState(unit?.imei2 ?? '');
  const [condition, setCondition] = useState<Condition>(unit?.condition ?? 'NEW');
  const [battery, setBattery] = useState(unit?.batteryHealth?.toString() ?? '');
  const [grade, setGrade] = useState(unit?.grade ?? '');
  const [cost, setCost] = useState<number | null>(unit?.cost ?? null);
  // Finance locked: the cost is not shown, so an edit leaves it as it is.
  const costHidden = editing && unit?.cost === null;
  // A trade-in phone taken without an IMEI can get one later, but is not forced to.
  const imeiOptional = editing && unit?.imei1 === null;
  const [price, setPrice] = useState<number | null>(unit?.salePrice ?? null);
  const [minPrice, setMinPrice] = useState<number | null>(null);
  const [notes, setNotes] = useState(unit?.notes ?? '');
  const [round, setRound] = useState(0); // bumps after "save and add another" to reset the price fields' text
  const imeiRef = useRef<HTMLInputElement>(null);
  const another = useRef(false);

  const picked = useMemo(() => models.data?.find((m) => m.id === modelId), [models.data, modelId]);
  useEffect(() => {
    // Choosing an existing model offers its prices; the user can still change them.
    if (picked && !editing) {
      setCost(picked.avgCost || null);
      setPrice(picked.salePrice || null);
      setMinPrice(picked.minPrice || null);
      setRound((r) => r + 1);
    }
  }, [picked, editing]);

  const imeiFormatOk = isValidImei(imei1);
  const status = useQuery({
    queryKey: ['units', 'imei', imei1, unit?.id],
    queryFn: () => api('units.imeiStatus', { imei: imei1, excludeUnitId: unit?.id }),
    enabled: imeiFormatOk,
  });
  const imei1Error = !imei1
    ? undefined
    : !imeiFormatOk
      ? t('stock.phoneForm.imeiBad')
      : status.data?.duplicate
        ? t('stock.phoneForm.imeiTaken', { model: status.data.duplicate.model })
        : undefined;
  const imei2Error = imei2 && (!isValidImei(imei2) ? t('stock.phoneForm.imeiBad') : imei2 === imei1 ? t('stock.phoneForm.imeiSame') : undefined);

  const modelOk = editing || pickValid(pick);
  const valid = modelOk && (imeiFormatOk || (imeiOptional && !imei1)) && !imei1Error && !imei2Error && (cost !== null || costHidden) && price !== null && price > 0 && !status.isFetching;

  const save = useAction(
    async (): Promise<{ productId: string } | null> => {
      const fields = {
        imei1: imei1 || null,
        imei2: imei2 || null,
        condition,
        batteryHealth: condition !== 'NEW' && battery ? Number(battery) : null,
        grade: condition !== 'NEW' && grade ? grade : null,
        cost: costHidden ? undefined : (cost ?? 0),
        salePrice: price ?? 0,
        notes,
      };
      if (unit) {
        await api('units.update', { id: unit.id, ...fields });
        return null;
      }
      return api('units.add', { ...fields, imei1, cost: cost ?? 0, minPrice: minPrice ?? 0, ...pickInput(pick) });
    },
    {
      success: editing ? t('stock.phoneForm.updated') : t('stock.phoneForm.saved'),
      invalidate: [['units'], ['models'], ['brands']],
      onDone: (result) => {
        if (!another.current || !result) return onClose();
        // Keep model and prices, clear what is specific to the next unit.
        setPick({ ...EMPTY_PICK, modelId: result.productId });
        setImei1('');
        setImei2('');
        setBattery('');
        setGrade('');
        setNotes('');
        imeiRef.current?.focus();
      },
    },
  );
  const submit = (more: boolean): void => {
    another.current = more;
    save.mutate(undefined);
  };
  const noEnter = (e: React.KeyboardEvent): void => {
    // Scanners end with Enter: that must not submit the form half filled.
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <Dialog
      wide
      title={editing ? t('stock.phoneForm.editTitle') : t('stock.phoneForm.title')}
      onClose={onClose}
      onSubmit={() => submit(false)}
      busy={save.isPending || !valid}
    >
      {editing ? (
        <p className="text-sm font-semibold">{unit.name} {unit.storage} {unit.color}</p>
      ) : (
        <ModelPicker value={pick} onChange={setPick} />
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label={imeiOptional ? `${t('stock.phoneForm.imei1')} (${t('common.optional')})` : t('stock.phoneForm.imei1')} required={!imeiOptional} error={imei1Error}>
          <Input ref={imeiRef} className="mono" dir="ltr" inputMode="numeric" maxLength={15} autoFocus value={imei1} onKeyDown={noEnter} onChange={(e) => setImei1(e.target.value.trim())} />
        </Field>
        <Field label={t('stock.phoneForm.imei2')} error={imei2Error || undefined}>
          <Input className="mono" dir="ltr" inputMode="numeric" maxLength={15} value={imei2} onKeyDown={noEnter} onChange={(e) => setImei2(e.target.value.trim())} />
        </Field>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('stock.phoneForm.battery')}>
              <Input type="number" min={0} max={100} dir="ltr" value={battery} onChange={(e) => setBattery(e.target.value)} />
            </Field>
            <Field label={t('stock.phoneForm.grade')}>
              <Input value={grade} maxLength={10} placeholder="A / B / C" onChange={(e) => setGrade(e.target.value)} />
            </Field>
          </div>
        )}
        {!costHidden && (
          <Field label={t('stock.phoneForm.cost')} required>
            <MoneyInput key={`c${round}`} value={cost} onChange={setCost} />
          </Field>
        )}
        <Field label={t('stock.phoneForm.salePrice')} required>
          <MoneyInput key={`p${round}`} value={price} onChange={setPrice} />
        </Field>
        {!editing && !picked && (
          <Field label={t('stock.phoneForm.minPrice')}>
            <MoneyInput key={`m${round}`} value={minPrice} onChange={setMinPrice} />
          </Field>
        )}
      </div>
      <Field label={t('stock.phoneForm.notes')}>
        <textarea className="input min-h-[64px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {!editing && <p className="rounded-lg bg-paper p-3 text-sm text-muted">{t('stock.phoneForm.openingStockNote')}</p>}
      {!editing && (
        <Button disabled={save.isPending || !valid} onClick={() => submit(true)}>
          {t('stock.phoneForm.saveAnother')}
        </Button>
      )}
    </Dialog>
  );
}
