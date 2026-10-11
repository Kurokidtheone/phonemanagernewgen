import { useQuery } from '@tanstack/react-query';
import { Plus, Printer, Tags, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { SearchSelect } from '@/components/SearchSelect';
import { Badge, Button } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useFinanceVisible, useMoney } from '@/lib/hooks';
import { BuyBackDialog } from './BuyBackDialog';
import { CatalogDialog } from './CatalogDialog';
import { LabelDialog } from './LabelDialog';
import { PhoneDialog } from './PhoneDialog';
import { CONDITIONS, CONDITION_TONE, STATUS_TONE, UNIT_STATUSES } from './shared';

type Unit = ApiResult<'units.list'>[number];
type Status = (typeof UNIT_STATUSES)[number];
type Condition = (typeof CONDITIONS)[number];

export function PhonesTab({ newImei, onHandled }: { newImei: string | null; onHandled: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const showCost = useFinanceVisible();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status | ''>('IN_STOCK');
  const [brandId, setBrandId] = useState('');
  const [condition, setCondition] = useState<Condition | ''>('');
  const [selected, setSelected] = useState(new Set<string>());
  const [adding, setAdding] = useState<{ imei?: string } | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [labelling, setLabelling] = useState(false);
  const [buying, setBuying] = useState(false);

  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api('brands.list') });
  const list = useQuery({
    queryKey: ['units', 'list', status, brandId, condition],
    queryFn: () => api('units.list', { status: status || undefined, brandId: brandId || undefined, condition: condition || undefined }),
  });

  // A scan of an unknown IMEI asks this tab to start a new phone with it.
  useEffect(() => {
    if (newImei) {
      setAdding({ imei: newImei });
      onHandled();
    }
  }, [newImei, onHandled]);

  const columns: Column<Unit>[] = [
    {
      header: t('stock.phones.model'),
      cell: (r) => (
        <span>
          <span className="font-semibold">{r.name}</span>
          <span className="block text-xs text-muted">{[r.storage, r.color].filter(Boolean).join(' · ')}</span>
        </span>
      ),
    },
    { header: t('stock.phones.imei'), cell: (r) => <span className="mono text-xs" dir="ltr">{r.imei1 ?? '—'}</span> },
    { header: t('stock.phones.condition'), cell: (r) => <Badge tone={CONDITION_TONE[r.condition]}>{t(`stock.condition.${r.condition}`)}</Badge> },
    { header: t('stock.phones.battery'), cell: (r) => (r.condition !== 'NEW' && r.batteryHealth !== null ? `${r.batteryHealth}%` : '—') },
    ...(showCost ? [{ header: t('stock.phones.cost'), align: 'end' as const, cell: (r: Unit) => money(r.cost ?? 0) }] : []),
    { header: t('stock.phones.price'), align: 'end', cell: (r) => <span className="font-bold">{money(r.salePrice)}</span> },
    { header: t('stock.phones.status'), cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{t(`stock.status.${r.status}`)}</Badge> },
    { header: t('stock.phones.age'), align: 'end', cell: (r) => (r.status === 'IN_STOCK' ? t('stock.phones.days', { count: r.ageDays }) : '—') },
  ];
  const chosen = (list.data ?? []).filter((u) => selected.has(u.id));

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        selection={{ ids: selected, onChange: setSelected }}
        onRowClick={(r) => navigate(`/stock/phones/${r.id}`)}
        searchText={(r) => `${r.name} ${r.model} ${r.storage} ${r.color} ${r.imei1 ?? ''} ${r.imei2 ?? ''}`}
        searchPlaceholder={t('stock.phones.search')}
        summary={showCost ? (rows) => `${t('stock.phones.value')}: ${money(rows.filter((r) => r.status === 'IN_STOCK').reduce((s, r) => s + (r.cost ?? 0), 0))}` : undefined}
        emptyTitle={t('stock.phones.empty')}
        emptyHint={t('stock.phones.emptyHint')}
        filters={
          <>
            <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as Status | '')} aria-label={t('stock.phones.status')}>
              <option value="">{t('stock.phones.allStatuses')}</option>
              {UNIT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`stock.status.${s}`)}
                </option>
              ))}
            </select>
            <SearchSelect className="w-52" options={brands.data ?? []} value={brandId} onChange={setBrandId} placeholder={t('stock.phones.allBrands')} emptyLabel={t('stock.phones.allBrands')} />
            <select className="input w-auto" value={condition} onChange={(e) => setCondition(e.target.value as Condition | '')} aria-label={t('stock.phones.condition')}>
              <option value="">{t('stock.phones.allConditions')}</option>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`stock.condition.${c}`)}
                </option>
              ))}
            </select>
            <Button icon={Tags} onClick={() => setCatalog(true)}>
              {t('stock.catalog.open')}
            </Button>
          </>
        }
        actions={
          <>
            <Button icon={Printer} disabled={chosen.length === 0} onClick={() => setLabelling(true)}>
              {t('stock.labels.printSelected', { count: chosen.length })}
            </Button>
            <Button icon={UserRound} onClick={() => setBuying(true)}>
              {t('stock.buyBack.open')}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setAdding({})}>
              {t('stock.phones.add')}
            </Button>
          </>
        }
      />
      {adding && <PhoneDialog prefillImei={adding.imei} onClose={() => setAdding(null)} />}
      {buying && <BuyBackDialog onClose={() => setBuying(false)} />}
      {catalog && <CatalogDialog onClose={() => setCatalog(false)} />}
      {labelling && (
        <LabelDialog
          sources={chosen.map((u) => ({ name: [u.name, u.storage].filter(Boolean).join(' '), price: u.salePrice, code: u.imei1 }))}
          onClose={() => setLabelling(false)}
        />
      )}
    </>
  );
}
