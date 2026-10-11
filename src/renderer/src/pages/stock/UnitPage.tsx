import { useQuery } from '@tanstack/react-query';
import { Pencil, Printer, Smartphone, Tag, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Dialog } from '@/components/Dialog';
import { PageBody, PageHeader } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Field, Input, MoneyInput, Skeleton } from '@/components/ui';
import { StockScanner } from '@/components/StockScanner';
import { api, type ApiResult } from '@/lib/api';
import { formatDateTime, useAction, useMoney } from '@/lib/hooks';
import { LabelDialog } from './LabelDialog';
import { PhoneDialog } from './PhoneDialog';
import { CONDITION_TONE, STATUS_TONE } from './shared';

type Unit = ApiResult<'units.get'>;

export function UnitPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const { id = '' } = useParams();
  const [dialog, setDialog] = useState<'edit' | 'price' | 'writeOff' | 'label' | null>(null);
  const query = useQuery({ queryKey: ['units', 'get', id], queryFn: () => api('units.get', { id }), retry: false });
  const unit = query.data;

  const back = { to: '/stock?tab=phones', label: t('stock.unit.back') };
  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={Smartphone} title={t('stock.unit.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  if (!unit) return <Skeleton className="m-8 h-64" />;

  const fields: [string, React.ReactNode][] = [
    [t('stock.phones.model'), `${unit.name} ${[unit.storage, unit.color].filter(Boolean).join(' · ')}`],
    [t('stock.phoneForm.imei1'), <span key="1" className="mono" dir="ltr">{unit.imei1 ?? '—'}</span>],
    [t('stock.phoneForm.imei2'), unit.imei2 ? <span key="2" className="mono" dir="ltr">{unit.imei2}</span> : '—'],
    [t('stock.phones.condition'), <Badge key="c" tone={CONDITION_TONE[unit.condition]}>{t(`stock.condition.${unit.condition}`)}</Badge>],
    [t('stock.phones.battery'), unit.batteryHealth !== null ? `${unit.batteryHealth}%` : '—'],
    [t('stock.phoneForm.grade'), unit.grade ?? '—'],
    ...(unit.cost === null ? [] : ([[t('stock.phones.cost'), money(unit.cost)]] as [string, React.ReactNode][])),
    [t('stock.phones.price'), <b key="p">{money(unit.salePrice)}</b>],
    [t('stock.phones.status'), <Badge key="s" tone={STATUS_TONE[unit.status]}>{t(`stock.status.${unit.status}`)}</Badge>],
    [t('stock.phones.age'), unit.status === 'IN_STOCK' ? t('stock.phones.days', { count: unit.ageDays }) : '—'],
    [t('stock.phoneForm.notes'), unit.notes || '—'],
  ];

  return (
    <PageBody>
      <StockScanner />
      <PageHeader
        icon={Smartphone}
        title={unit.name}
        subtitle={[unit.storage, unit.color].filter(Boolean).join(' · ')}
        back={back}
        action={
          <div className="flex flex-wrap gap-2">
            <Button icon={Pencil} onClick={() => setDialog('edit')}>{t('common.edit')}</Button>
            <Button icon={Tag} onClick={() => setDialog('price')}>{t('stock.unit.changePrice')}</Button>
            <Button icon={Printer} onClick={() => setDialog('label')}>{t('stock.labels.print')}</Button>
            <Button icon={XCircle} className="text-danger" disabled={unit.status !== 'IN_STOCK'} onClick={() => setDialog('writeOff')}>
              {t('stock.unit.writeOff')}
            </Button>
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('stock.unit.details')}>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={t('stock.unit.timeline')}>
          <ol className="space-y-3 border-s-2 border-line ps-4">
            {[...unit.timeline].reverse().map((e, i) => (
              <li key={i} className="relative">
                <span className="absolute -start-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
                <p className="text-sm font-semibold">{timelineText(t, e)}</p>
                <p className="text-xs text-muted">{formatDateTime(e.at, i18n.language)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {dialog === 'edit' && <PhoneDialog unit={unit} onClose={() => setDialog(null)} />}
      {dialog === 'price' && <PriceDialog unit={unit} onClose={() => setDialog(null)} />}
      {dialog === 'writeOff' && <WriteOffDialog unit={unit} onClose={() => setDialog(null)} />}
      {dialog === 'label' && (
        <LabelDialog sources={[{ name: [unit.name, unit.storage].filter(Boolean).join(' '), price: unit.salePrice, code: unit.imei1 }]} onClose={() => setDialog(null)} />
      )}
    </PageBody>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function timelineText(t: T, e: Unit['timeline'][number]): string {
  const name = e.party ?? '';
  switch (e.kind) {
    case 'PURCHASE':
      return e.party ? t('stock.timeline.purchase', { name }) : t('stock.timeline.purchaseNoParty');
    case 'SALE':
      return e.party ? t('stock.timeline.sold', { name }) : t('stock.timeline.soldNoParty');
    case 'RETURN':
      return e.party ? t('stock.timeline.returned', { name }) : t('stock.timeline.returnedNoParty');
    case 'TRADE_IN':
      return t('stock.timeline.tradeIn');
    case 'WRITE_OFF':
      return t('stock.timeline.writeOff', { reason: e.reason });
    case 'REPAIR':
      return t('stock.timeline.repair', { ticket: e.ref ?? '' });
    case 'ADJUSTMENT':
      return e.reason === 'MANUAL_ENTRY' ? t('stock.timeline.manual') : t('stock.timeline.adjustment', { reason: t(`stock.reasons.${e.reason}`, { defaultValue: e.reason }) });
    default:
      return e.kind;
  }
}

function PriceDialog({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const { t } = useTranslation();
  const [price, setPrice] = useState<number | null>(unit.salePrice);
  const save = useAction(() => api('units.setPrice', { id: unit.id, salePrice: price ?? 0 }), {
    success: t('stock.unit.priceSaved'),
    invalidate: [['units']],
    onDone: onClose,
  });
  return (
    <Dialog title={t('stock.unit.changePrice')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !price}>
      <Field label={t('stock.unit.newPrice')} required>
        <MoneyInput autoFocus value={price} onChange={setPrice} />
      </Field>
    </Dialog>
  );
}

function WriteOffDialog({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const save = useAction(() => api('units.writeOff', { id: unit.id, reason }), {
    success: t('stock.unit.writtenOff'),
    invalidate: [['units']],
    onDone: onClose,
  });
  return (
    <Dialog
      title={t('stock.unit.writeOffTitle')}
      hint={t('stock.unit.writeOffBody')}
      onClose={onClose}
      onSubmit={() => save.mutate(undefined)}
      submitLabel={t('stock.unit.writeOff')}
      submitVariant="danger"
      busy={save.isPending || !reason.trim()}
    >
      <Field label={t('stock.unit.reason')} required>
        <Input autoFocus value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}
