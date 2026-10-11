// Small pickers shared by Receive stock and Count stock: a phone model, an accessory.
import { useQuery } from '@tanstack/react-query';
import { ScanLine, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, inputClass, Row } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { scanCode, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';

export interface ModelChoice {
  id: string;
  label: string;
  salePrice: number;
}

export function ModelPicker({ onPick }: { onPick: (m: ModelChoice) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const models = useQuery({ queryKey: ['models'], queryFn: () => api('models.list') });
  const needle = q.trim().toLowerCase();
  const rows = (models.data ?? []).filter((m) => !needle || `${m.brandName ?? ''} ${m.name} ${m.storage} ${m.color}`.toLowerCase().includes(needle));
  return (
    <div>
      <input className={inputClass} placeholder={t('m.receive.searchModel')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2">
        {rows.length === 0 ? (
          <Empty>{t('m.lookup.none')}</Empty>
        ) : (
          rows.map((m) => {
            const label = [m.brandName, m.name, m.storage, m.color].filter(Boolean).join(' ');
            return <Row key={m.id} title={label} onClick={() => onPick({ id: m.id, label, salePrice: m.salePrice })} />;
          })
        )}
      </div>
    </div>
  );
}

export interface ItemChoice {
  id: string;
  name: string;
  quantity: number;
}

/** An accessory by search or by its barcode. */
export function ItemPicker({ onPick }: { onPick: (item: ItemChoice) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const query = q.trim();
  const results = useQuery({ queryKey: ['search', 'items', query], queryFn: () => api('stock.search', { q: query }), enabled: query.length >= 2 });

  const scan = async (): Promise<void> => {
    try {
      const code = await scanCode();
      if (!code) return;
      const hit = await api('stock.lookup', { code });
      if (hit?.type === 'item') {
        const item = await api('items.get', { id: hit.id });
        onPick({ id: item.id, name: item.name, quantity: item.quantity });
      } else toast(t('m.receive.itemNotFound'));
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
          <input className={`${inputClass} ps-10`} placeholder={t('m.receive.searchItem')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="primary" icon={ScanLine} onClick={() => void scan()}>
          {t('m.lookup.scan')}
        </Button>
      </div>
      <div className="mt-2">
        {query.length >= 2 && (results.data?.items ?? []).map((i) => <Row key={i.id} title={i.name} subtitle={i.barcode ?? i.categoryName} right={i.quantity} onClick={() => onPick({ id: i.id, name: i.name, quantity: i.quantity })} />)}
        {query.length >= 2 && results.data && results.data.items.length === 0 && <Empty>{t('m.lookup.none')}</Empty>}
      </div>
    </div>
  );
}
