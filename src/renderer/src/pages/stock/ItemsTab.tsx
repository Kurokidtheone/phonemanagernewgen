import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, Plus, Printer, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Button } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { useFinanceVisible, useMoney } from '@/lib/hooks';
import { CatalogDialog } from './CatalogDialog';
import { ImportDialog } from './ImportDialog';
import { ItemDialog } from './ItemDialog';
import { LabelDialog } from './LabelDialog';

type Item = ApiResult<'items.list'>[number];

export function ItemsTab({ openId, newBarcode, onHandled }: { openId: string | null; newBarcode: string | null; onHandled: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const showCost = useFinanceVisible();
  const [categoryId, setCategoryId] = useState('');
  const [params] = useSearchParams();
  const [lowOnly, setLowOnly] = useState(params.get('low') === '1'); // from the Overview
  const [partsOnly, setPartsOnly] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [dialog, setDialog] = useState<{ item?: Item; barcode?: string } | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [labelling, setLabelling] = useState(false);
  const [importing, setImporting] = useState(false);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api('categories.list') });
  const list = useQuery({
    queryKey: ['items', 'list', categoryId, lowOnly, partsOnly],
    queryFn: () => api('items.list', { categoryId: categoryId || undefined, lowStockOnly: lowOnly || undefined, repairPartsOnly: partsOnly || undefined }),
  });

  // A scan from anywhere in Stock asks this tab to open an item or start a new one.
  useEffect(() => {
    if (newBarcode) {
      setDialog({ barcode: newBarcode });
      onHandled();
    } else if (openId) {
      void api('items.get', { id: openId }).then((item) => setDialog({ item }));
      onHandled();
    }
  }, [openId, newBarcode, onHandled]);

  const columns: Column<Item>[] = [
    { header: t('stock.items.name'), cell: (r) => <span className="font-semibold">{r.name}</span> },
    { header: t('stock.items.category'), cell: (r) => r.categoryName },
    { header: t('stock.items.barcode'), cell: (r) => <span className="mono text-xs" dir="ltr">{r.barcode ?? '—'}</span> },
    {
      header: t('stock.items.quantity'),
      align: 'end',
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          {r.isLow && <Badge tone="danger">{t('stock.items.low')}</Badge>}
          <b>{r.quantity}</b>
        </span>
      ),
    },
    ...(showCost ? [{ header: t('stock.items.cost'), align: 'end' as const, cell: (r: Item) => money(r.avgCost ?? 0) }] : []),
    { header: t('stock.items.price'), align: 'end', cell: (r) => <span className="font-bold">{money(r.salePrice)}</span> },
  ];
  const chosen = (list.data ?? []).filter((i) => selected.has(i.id));

  return (
    <>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        selection={{ ids: selected, onChange: setSelected }}
        onRowClick={(r) => setDialog({ item: r })}
        searchText={(r) => `${r.name} ${r.barcode ?? ''}`}
        searchPlaceholder={t('stock.items.search')}
        summary={showCost ? (rows) => `${t('stock.items.value')}: ${money(rows.reduce((s, r) => s + r.quantity * (r.avgCost ?? 0), 0))}` : undefined}
        emptyTitle={t('stock.items.empty')}
        emptyHint={t('stock.items.emptyHint')}
        filters={
          <>
            <select className="input w-auto" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label={t('stock.items.category')}>
              <option value="">{t('stock.items.allCategories')}</option>
              {categories.data
                ?.filter((c) => c.kind !== 'PHONE')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
              {t('stock.items.lowOnly')}
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={partsOnly} onChange={(e) => setPartsOnly(e.target.checked)} />
              {t('stock.items.partsOnly')}
            </label>
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
            <Button icon={FileSpreadsheet} onClick={() => setImporting(true)}>
              {t('import.open')}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setDialog({})}>
              {t('stock.items.add')}
            </Button>
          </>
        }
      />
      {dialog && <ItemDialog item={dialog.item} prefillBarcode={dialog.barcode} onClose={() => setDialog(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {catalog && <CatalogDialog onClose={() => setCatalog(false)} />}
      {labelling && <LabelDialog sources={chosen.map((i) => ({ name: i.name, price: i.salePrice, code: i.barcode }))} onClose={() => setLabelling(false)} />}
    </>
  );
}
