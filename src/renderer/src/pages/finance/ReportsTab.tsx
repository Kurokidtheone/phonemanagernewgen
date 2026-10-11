import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REPORT_KINDS } from '@shared/schemas';
import { DataTable, type Column } from '@/components/DataTable';
import { Button, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useMoney } from '@/lib/hooks';
import { escapeHtml, printDocument } from '@/lib/print';
import { toast } from '@/lib/toast';
import { PeriodChips, usePeriod } from './period';

type Kind = (typeof REPORT_KINDS)[number];
type Cell = string | number | null;
// Which reports follow the period; the others describe the shop right now.
const PERIODIC: Kind[] = ['bestModels', 'bestAccessories', 'profitByBrand', 'profitByEmployee'];

/** Ready tables: on screen, to print (A4) and to export to Excel. */
export function ReportsTab() {
  const { t } = useTranslation();
  const money = useMoney();
  const state = usePeriod('month');
  const [kind, setKind] = useState<Kind>('bestModels');
  const [slowDays, setSlowDays] = useState('60');
  const days = Math.max(1, Math.floor(Number(slowDays)) || 60);

  const data = useQuery({ queryKey: ['finance', 'report', kind, state.period.from, state.period.to, days], queryFn: () => api('finance.report', { kind, ...state.period, slowDays: days }) }).data;
  const title = t(`analytics.reports.${kind}`);
  const label = (key: string): string => t(`analytics.cols.${key}`);

  const columns: Column<Cell[]>[] = (data?.columns ?? []).map((key, i) => ({
    header: label(key),
    align: data!.money.includes(key) || ['qty', 'quantity', 'threshold', 'days', 'sales', 'repairs'].includes(key) ? ('end' as const) : ('start' as const),
    cell: (row: Cell[]) => {
      const v = row[i];
      if (v === null || v === undefined) return '—';
      if (key === 'condition') return t(`stock.condition.${v}`, { defaultValue: String(v) });
      return data!.money.includes(key) ? money(Number(v)) : String(v);
    },
  }));

  // Excel gets raw numbers (money in DA); print gets the same text as the screen.
  const exportXlsx = async (): Promise<void> => {
    if (!data) return;
    const moneyColumns = data.columns.flatMap((k, i) => (data.money.includes(k) ? [i] : []));
    const rows = data.rows.map((r) => r.map((v, i) => (moneyColumns.includes(i) && typeof v === 'number' ? v / 100 : v)));
    try {
      const result = await api('file.exportXlsx', { title, headers: data.columns.map(label), rows, moneyColumns });
      if (result.saved) toast.ok(t('analytics.exported'));
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };
  const print = async (): Promise<void> => {
    if (!data) return;
    const e = escapeHtml;
    const cell = (v: Cell, key: string): string => (v === null ? '—' : key === 'condition' ? t(`stock.condition.${v}`, { defaultValue: String(v) }) : data.money.includes(key) ? money(Number(v)) : String(v));
    const body = `<h1>${e(title)}</h1><p class="muted">${e(new Date().toLocaleString())}</p>
      <table><thead><tr>${data.columns.map((k) => `<th>${e(label(k))}</th>`).join('')}</tr></thead>
      <tbody>${data.rows.map((r) => `<tr>${r.map((v, i) => `<td${data.money.includes(data.columns[i]) ? ' class="end"' : ''}>${e(cell(v, data.columns[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    try {
      await printDocument(body, 'A4');
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };

  return (
    <div>
      <div role="tablist" className="mb-4 flex flex-wrap gap-2">
        {REPORT_KINDS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${kind === k ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink'}`}
          >
            {t(`analytics.reports.${k}`)}
          </button>
        ))}
      </div>
      {PERIODIC.includes(kind) ? <PeriodChips state={state} /> : <p className="mb-4 text-sm text-muted">{t('analytics.reportsNow')}</p>}
      {kind === 'slowStock' && (
        <div className="mb-4 max-w-[12rem]">
          <Field label={t('analytics.slowDays')}>
            <Input type="number" min={1} dir="ltr" value={slowDays} onChange={(e) => setSlowDays(e.target.value)} />
          </Field>
        </div>
      )}
      <DataTable
        rows={data?.rows}
        loading={!data}
        columns={columns}
        rowKey={(r) => r.map(String).join('|')}
        pageSize={25}
        emptyTitle={t('analytics.empty')}
        actions={
          <>
            <Button icon={Printer} disabled={!data || data.rows.length === 0} onClick={() => void print()}>
              {t('analytics.print')}
            </Button>
            <Button icon={FileSpreadsheet} disabled={!data || data.rows.length === 0} onClick={() => void exportXlsx()}>
              {t('analytics.exportExcel')}
            </Button>
          </>
        }
      />
    </div>
  );
}
