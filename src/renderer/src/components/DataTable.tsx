import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, Skeleton } from './ui';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end';
  width?: string;
}

/**
 * List with instant search, a "shown / total" counter and pagination.
 * Filtering happens here, in memory: fine up to a few thousand rows. Beyond that, filter in SQL.
 */
export function DataTable<T>({ rows, columns, rowKey, searchText, searchPlaceholder, filters, actions, summary, note, selection, emptyTitle, emptyHint, loading, pageSize = 20, onRowClick }: {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  filters?: ReactNode;
  actions?: ReactNode;
  /** Extra figure next to the counter, computed from the rows that match the search. */
  summary?: (rows: T[]) => ReactNode;
  /** A line under the counter, for example "showing the latest 5,000". */
  note?: string;
  /** Adds a checkbox column. Ids are the rowKey values. */
  selection?: { ids: Set<string>; onChange: (ids: Set<string>) => void };
  emptyTitle: string;
  emptyHint?: string;
  loading?: boolean;
  pageSize?: number;
  onRowClick?: (row: T) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const all = rows ?? [];
    const q = query.trim().toLowerCase();
    return q && searchText ? all.filter((r) => searchText(r).toLowerCase().includes(q)) : all;
  }, [rows, query, searchText]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, (current + 1) * pageSize);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {searchText && (
          <label className="relative min-w-[240px] flex-1">
            <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              className="input ps-9"
              value={query}
              placeholder={searchPlaceholder ?? t('common.search')}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
        )}
        {filters}
        <div className="ms-auto flex gap-2">{actions}</div>
      </div>

      <div className="rounded-2xl border border-line bg-card p-4">
        <p className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-bold">
          <span>{t('common.counter', { shown: filtered.length, total: rows?.length ?? 0 })}</span>
          {summary && rows && <span>{summary(filtered)}</span>}
        </p>
        {note && <p className="mb-3 text-xs text-muted">{note}</p>}
        {loading || !rows ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title={emptyTitle} hint={rows.length === 0 ? emptyHint : t('common.noMatch')} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-paper text-muted">
                  {selection && (
                    <th className="w-10 px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={t('common.selectAll')}
                        checked={filtered.length > 0 && filtered.every((r) => selection.ids.has(rowKey(r)))}
                        onChange={(e) => selection.onChange(e.target.checked ? new Set(filtered.map(rowKey)) : new Set())}
                      />
                    </th>
                  )}
                  {columns.map((c) => (
                    <th key={c.header} style={{ width: c.width }} className={`px-3 py-2.5 font-semibold ${c.align === 'end' ? 'text-end' : 'text-start'}`}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`border-t border-line ${onRowClick ? 'cursor-pointer hover:bg-paper' : ''}`}
                  >
                    {selection && (
                      <td className="w-10 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={t('common.select')}
                          checked={selection.ids.has(rowKey(row))}
                          onChange={(e) => {
                            const next = new Set(selection.ids);
                            if (e.target.checked) next.add(rowKey(row));
                            else next.delete(rowKey(row));
                            selection.onChange(next);
                          }}
                        />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.header} className={`px-3 py-2.5 ${c.align === 'end' ? 'text-end' : 'text-start'}`}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted">
          <span>{t('common.page', { page: current + 1, pages })}</span>
          <span className="flex gap-1">
            <button className="rounded-md border border-line bg-card p-1.5 disabled:opacity-40" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={t('common.previous')}>
              <ChevronRight size={16} className="ltr:rotate-180" />
            </button>
            <button className="rounded-md border border-line bg-card p-1.5 disabled:opacity-40" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label={t('common.next')}>
              <ChevronLeft size={16} className="ltr:rotate-180" />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
