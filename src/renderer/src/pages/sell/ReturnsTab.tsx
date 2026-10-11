import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Card } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDateTime, useMoney } from '@/lib/hooks';
import { ReturnDialog } from './ReturnDialog';

type Row = ApiResult<'returns.list'>[number];

/** Find the sale by receipt number or IMEI, return from it, and see every return so far. */
export function ReturnsTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [saleId, setSaleId] = useState<string | null>(null);

  const found = useQuery({ queryKey: ['returns', 'find', query], queryFn: () => api('returns.find', { query }), enabled: query.length > 0 });
  const list = useQuery({ queryKey: ['returns', 'list'], queryFn: () => api('returns.list') });

  const columns: Column<Row>[] = [
    { header: t('sell.receipt.date'), cell: (r) => formatDateTime(r.date, i18n.language) },
    { header: t('sell.receipt.number'), cell: (r) => <span className="mono font-semibold" dir="ltr">{r.receiptNumber}</span> },
    { header: t('sell.customer'), cell: (r) => r.customerName ?? '—' },
    {
      header: t('sell.returns.value'),
      align: 'end',
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          {r.exchangeReceipt && <Badge tone="accent">{t('sell.returns.exchangeBadge', { receipt: r.exchangeReceipt })}</Badge>}
          <b>{money(r.returnedValue)}</b>
        </span>
      ),
    },
    { header: t('sell.returns.reason'), cell: (r) => <span className="text-muted">{r.reason}</span> },
  ];

  return (
    <div className="space-y-5">
      <Card title={t('sell.returns.findTitle')} hint={t('sell.returns.findHint')}>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text.trim());
          }}
        >
          <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input autoFocus className="input ps-9" dir="auto" value={text} placeholder={t('sell.returns.findPlaceholder')} onChange={(e) => setText(e.target.value)} />
        </form>
        {query && found.data && (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {found.data.map((s) => (
              <li key={s.id}>
                <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start hover:bg-paper" onClick={() => setSaleId(s.id)}>
                  <span>
                    <span className="mono font-semibold" dir="ltr">{s.receiptNumber}</span>
                    <span className="block text-xs text-muted">{formatDateTime(s.date, i18n.language)} · {s.customerName ?? '—'} · {s.itemsSummary}</span>
                  </span>
                  <b>{money(s.total)}</b>
                </button>
              </li>
            ))}
            {found.data.length === 0 && <li className="px-4 py-3 text-sm text-muted">{t('sell.returns.noSale')}</li>}
          </ul>
        )}
      </Card>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/sell/sales/${r.saleId}`)}
        searchText={(r) => `${r.receiptNumber} ${r.customerName ?? ''} ${r.reason}`}
        emptyTitle={t('sell.returns.empty')}
        emptyHint={t('sell.returns.emptyHint')}
      />
      {saleId && <ReturnDialog saleId={saleId} onClose={() => setSaleId(null)} />}
    </div>
  );
}
