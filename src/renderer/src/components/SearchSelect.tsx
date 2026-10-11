import { ChevronDown, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface SearchOption {
  id: string;
  name: string;
}

/**
 * A select with a search bar, for long lists such as brands. Type to filter, arrows and Enter to
 * pick. `onCreate` offers to add what was typed when nothing matches it exactly. Enter and Esc stay
 * inside, so a surrounding dialog is not submitted or closed by accident.
 */
export function SearchSelect({ options, value, onChange, placeholder, emptyLabel, onCreate, className }: {
  options: SearchOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  /** Adds a first entry that clears the choice (for filters: "All brands"). */
  emptyLabel?: string;
  onCreate?: (name: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const selected = options.find((o) => o.id === value);

  const rows = useMemo(() => {
    const text = q.trim().toLowerCase();
    const found = options.filter((o) => !text || o.name.toLowerCase().includes(text)).slice(0, 60);
    const list: { id: string; name: string; create?: boolean }[] = emptyLabel && !text ? [{ id: '', name: emptyLabel }, ...found] : found;
    if (onCreate && text && !options.some((o) => o.name.toLowerCase() === text)) list.push({ id: '__new', name: q.trim(), create: true });
    return list;
  }, [options, q, emptyLabel, onCreate]);

  const close = (): void => {
    setOpen(false);
    setQ('');
    setIndex(0);
  };
  const pick = (row: (typeof rows)[number] | undefined): void => {
    if (!row) return;
    if (row.create) onCreate?.(row.name);
    else onChange(row.id);
    close();
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      <button type="button" className="input flex items-center justify-between gap-2 text-start" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={selected ? '' : 'text-muted'}>{selected?.name ?? (value === '' && emptyLabel ? emptyLabel : placeholder)}</span>
        <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute z-20 mt-1 w-full min-w-[14rem] rounded-xl border border-line bg-card p-2 shadow-xl">
            <label className="relative mb-2 block">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input
                autoFocus
                className="input ps-9"
                value={q}
                placeholder={t('common.search')}
                onChange={(e) => {
                  setQ(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setIndex((i) => Math.min(i + 1, rows.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    pick(rows[index]);
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                  }
                }}
              />
            </label>
            <ul role="listbox" className="max-h-56 overflow-y-auto">
              {rows.map((r, i) => (
                <li key={r.id + r.name} role="option" aria-selected={r.id === value}>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pick(r)}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-sm ${i === index ? 'bg-paper' : ''} ${r.id === value ? 'font-bold text-accent' : 'font-semibold'}`}
                  >
                    {r.create && <Plus size={14} aria-hidden />}
                    {r.create ? t('common.createNamed', { name: r.name }) : r.name}
                  </button>
                </li>
              ))}
              {rows.length === 0 && <li className="px-3 py-3 text-center text-sm text-muted">{t('common.noMatch')}</li>}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
