// Look up: type or scan an IMEI or a barcode, open the phone or item.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ScanLine, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, inputClass, Pill, Refreshable, Row } from '@/components/ui';
import { api, errorText, type ApiResult } from '@/lib/api';
import { formatDateTime, listRefresh, useMoney } from '@/lib/hooks';
import { scanCode, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';

type Target = { type: 'unit' | 'item'; id: string };
type Unit = ApiResult<'units.get'>;

export function Lookup() {
  const { t } = useTranslation();
  const money = useMoney();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const results = useQuery({ queryKey: ['search', query], queryFn: () => api('stock.search', { q: query }), enabled: query.length >= 2, refetchInterval: listRefresh });

  /** An exact IMEI or barcode opens its page at once. */
  const open = async (code: string): Promise<boolean> => {
    try {
      const hit = await api('stock.lookup', { code });
      if (hit) {
        setTarget(hit);
        return true;
      }
    } catch (err) {
      toast(errorText(t, err));
      return true;
    }
    return false;
  };

  const scan = async (): Promise<void> => {
    try {
      const code = await scanCode();
      if (code && !(await open(code))) toast(t('m.lookup.notFoundCode'));
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
  };

  if (target) return target.type === 'unit' ? <UnitView id={target.id} onBack={() => setTarget(null)} /> : <ItemView id={target.id} onBack={() => setTarget(null)} />;

  return (
    <div className="flex h-full flex-col" data-accent="green">
      <div className="flex gap-2 p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
          <input
            className={`${inputClass} ps-10`}
            inputMode="search"
            placeholder={t('m.lookup.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && /^\d{8,}$/.test(text.trim())) void open(text.trim());
            }}
          />
        </div>
        <Button variant="primary" icon={ScanLine} onClick={() => void scan()}>
          {t('m.lookup.scan')}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['search'] })}>
          {query.length < 2 ? (
            <Empty>{t('m.lookup.hint')}</Empty>
          ) : results.data && results.data.units.length + results.data.items.length === 0 ? (
            <Empty>{t('m.lookup.none')}</Empty>
          ) : (
            <>
              {results.data?.units.map((u) => (
                <Row
                  key={u.id}
                  onClick={() => setTarget({ type: 'unit', id: u.id })}
                  title={[u.name, u.storage, u.color].filter(Boolean).join(' ')}
                  subtitle={<span dir="ltr">{u.imei1 ?? t('m.unit.noImei')}</span>}
                  right={
                    <div>
                      <div className="font-medium">{money(u.salePrice)}</div>
                      <Pill tone={u.status === 'IN_STOCK' ? 'ok' : 'neutral'}>{t(`stock.status.${u.status}`)}</Pill>
                    </div>
                  }
                />
              ))}
              {results.data?.items.map((i) => (
                <Row
                  key={i.id}
                  onClick={() => setTarget({ type: 'item', id: i.id })}
                  title={i.name}
                  subtitle={i.barcode ?? i.categoryName}
                  right={
                    <div>
                      <div className="font-medium">{money(i.salePrice)}</div>
                      <Pill tone={i.isLow ? 'danger' : 'ok'}>{i.quantity}</Pill>
                    </div>
                  }
                />
              ))}
            </>
          )}
        </Refreshable>
      </div>
    </div>
  );
}

function Back({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line p-2">
      <button className="flex h-12 w-12 items-center justify-center rounded-xl active:bg-accent-faint" onClick={onBack} aria-label="back">
        <ArrowLeft className="h-6 w-6 rtl:rotate-180" />
      </button>
      <h2 className="truncate text-lg font-semibold">{title}</h2>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
      <span className="text-muted">{label}</span>
      <span className="text-end font-medium">{value}</span>
    </div>
  );
}

export function UnitView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const client = useQueryClient();
  const unit = useQuery({ queryKey: ['unit', id], queryFn: () => api('units.get', { id }), refetchInterval: listRefresh });
  const u = unit.data;
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <Back onBack={onBack} title={u ? [u.name, u.storage, u.color].filter(Boolean).join(' ') : ''} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['unit', id] })}>
          {u && (
            <>
              <Fact label={t('m.unit.status')} value={<Pill tone={u.status === 'IN_STOCK' ? 'ok' : 'neutral'}>{t(`stock.status.${u.status}`)}</Pill>} />
              <Fact label={t('m.unit.price')} value={money(u.salePrice)} />
              {/* The PC leaves the cost out for every role except the owner. */}
              {'cost' in u && typeof u.cost === 'number' && <Fact label={t('m.unit.cost')} value={money(u.cost)} />}
              <Fact label={t('m.unit.imei')} value={<span dir="ltr">{u.imei1 ?? t('m.unit.noImei')}</span>} />
              {u.imei2 && <Fact label={t('m.unit.imei2')} value={<span dir="ltr">{u.imei2}</span>} />}
              <Fact label={t('m.unit.condition')} value={t(`stock.condition.${u.condition}`)} />
              {u.batteryHealth !== null && <Fact label={t('m.unit.battery')} value={`${u.batteryHealth}%`} />}
              {u.grade && <Fact label={t('m.unit.grade')} value={u.grade} />}
              {u.notes && <Fact label={t('m.unit.notes')} value={u.notes} />}
              <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.unit.history')}</h3>
              {u.timeline.map((e, i) => (
                <Row key={i} title={timelineText(t, e)} subtitle={formatDateTime(e.at, i18n.language)} />
              ))}
            </>
          )}
        </Refreshable>
      </div>
    </div>
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

export function ItemView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const client = useQueryClient();
  const item = useQuery({ queryKey: ['item', id], queryFn: () => api('items.get', { id }), refetchInterval: listRefresh });
  const i = item.data;
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <Back onBack={onBack} title={i?.name ?? ''} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['item', id] })}>
          {i && (
            <>
              <Fact label={t('m.item.quantity')} value={<Pill tone={i.isLow ? 'danger' : 'ok'}>{i.quantity}</Pill>} />
              {i.isLow && <Fact label="" value={t('m.item.low')} />}
              <Fact label={t('m.item.price')} value={money(i.salePrice)} />
              {'avgCost' in i && typeof i.avgCost === 'number' && <Fact label={t('m.item.cost')} value={money(i.avgCost)} />}
              {i.barcode && <Fact label={t('m.item.barcode')} value={<span dir="ltr">{i.barcode}</span>} />}
              <Fact label={t('m.item.category')} value={i.categoryName} />
            </>
          )}
        </Refreshable>
      </div>
    </div>
  );
}
