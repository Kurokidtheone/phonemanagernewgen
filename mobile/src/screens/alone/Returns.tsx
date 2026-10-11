// A customer brings something back: find the sale, pick the lines, see what it comes to, confirm.
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScreenHeader, useFormatMoney } from '@/components/common';
import { Button, Empty, Field, inputClass, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/hooks';
import { Panel, useDo } from './kit';

export function ReturnsScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [saleId, setSaleId] = useState<string | null>(null);
  const found = useQuery({ queryKey: ['returns', 'find', query], queryFn: () => api('returns.find', { query }), enabled: query.length > 0 });
  if (saleId) return <ReturnSale saleId={saleId} onBack={() => setSaleId(null)} />;
  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <ScreenHeader title={t('m.alone.returns')} onBack={onBack} />
      <div className="relative p-3">
        <Search className="pointer-events-none absolute start-6 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
        <input className={`${inputClass} ps-10`} placeholder={t('m.alone.findSale')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(text.trim())} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query && (found.data ?? []).length === 0 && <Empty>{t('m.lookup.none')}</Empty>}
        {(found.data ?? []).map((s) => (
          <Row key={s.id} title={s.itemsSummary ?? s.receiptNumber} subtitle={`${s.receiptNumber} · ${formatDateTime(s.date, i18n.language)}`} right={money(s.total)} onClick={() => setSaleId(s.id)} />
        ))}
      </div>
    </div>
  );
}

function ReturnSale({ saleId, onBack }: { saleId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const lines = useQuery({ queryKey: ['returns', 'lines', saleId], queryFn: () => api('returns.lines', { id: saleId }) });
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const chosen = Object.entries(picked).filter(([, q]) => q > 0).map(([saleLineId, quantity]) => ({ saleLineId, quantity, restock: true }));
  const preview = useQuery({ queryKey: ['returns', 'preview', saleId, chosen], queryFn: () => api('returns.preview', { saleId, lines: chosen }), enabled: chosen.length > 0 });
  const create = useDo(() => api('returns.create', { saleId, reason: reason.trim() || t('m.alone.returnReason'), lines: chosen, exchange: null }), { success: t('common.saved'), onDone: onBack });
  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <ScreenHeader title={t('m.alone.returns')} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(lines.data ?? []).map((l) => {
          const left = l.quantity - l.returnedQuantity;
          return (
            <Row
              key={l.id}
              title={[l.name, l.storage, l.color].filter(Boolean).join(' ')}
              subtitle={l.imei1 ? <span dir="ltr">{l.imei1}</span> : `× ${left}`}
              right={left > 0 ? <input type="checkbox" checked={(picked[l.id] ?? 0) > 0} onChange={(e) => setPicked({ ...picked, [l.id]: e.target.checked ? left : 0 })} /> : <span className="text-muted">{t('m.alone.returned')}</span>}
            />
          );
        })}
        {preview.data && (
          <Panel>
            <Row title={t('m.alone.returnValue')} right={money(preview.data.value)} />
            <Row title={t('m.alone.refund')} right={<b>{money(preview.data.refund)}</b>} />
          </Panel>
        )}
        <Panel>
          <Field label={t('m.alone.reason')}>
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button variant="primary" className="mt-3 w-full" busy={create.isPending} disabled={chosen.length === 0} onClick={() => create.mutate(undefined)}>
            {t('m.alone.confirmReturn')}
          </Button>
        </Panel>
      </div>
    </div>
  );
}
