import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SECTIONS } from '@shared/app.config';
import { SECTION_ICONS } from '@/lib/sections';

/** Extra destinations for Ctrl+K. Add your sub-pages here: { labelKey, path, section }. */
const EXTRA: { labelKey: string; path: string; section: (typeof SECTIONS)[number]['id'] }[] = [
  { labelKey: 'repairs.new', path: '/repairs?new=1', section: 'repairs' },
  { labelKey: 'tabs.repairs.tickets', path: '/repairs?tab=tickets', section: 'repairs' },
  { labelKey: 'tabs.sell.newSale', path: '/sell?tab=newSale', section: 'sell' },
  { labelKey: 'tabs.sell.returns', path: '/sell?tab=returns', section: 'sell' },
  { labelKey: 'tabs.people.customers', path: '/people', section: 'people' },
  { labelKey: 'tabs.sell.history', path: '/sell?tab=history', section: 'sell' },
  { labelKey: 'tabs.stock.purchases', path: '/stock?tab=purchases', section: 'stock' },
  { labelKey: 'tabs.stock.suppliers', path: '/stock?tab=suppliers', section: 'stock' },
  { labelKey: 'tabs.stock.phones', path: '/stock?tab=phones', section: 'stock' },
  { labelKey: 'tabs.stock.items', path: '/stock?tab=items', section: 'stock' },
  { labelKey: 'expenses.title', path: '/finance', section: 'finance' },
  { labelKey: 'settings.backup.title', path: '/settings#backup', section: 'settings' },
  { labelKey: 'settings.license.title', path: '/settings#license', section: 'settings' },
];

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery('');
        setIndex(0);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => {
    const all = [
      ...SECTIONS.map((s) => ({ label: t(`sections.${s.id}`), path: s.path as string, section: s.id })),
      ...EXTRA.map((e) => ({ label: t(e.labelKey), path: e.path, section: e.section })),
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
  }, [query, t]);

  if (!open) return null;
  const go = (path: string): void => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-3 shadow-2xl">
        <label className="relative block">
          <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            autoFocus
            className="input ps-9"
            placeholder={t('common.jumpTo')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, items.length - 1));
              if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
              if (e.key === 'Enter' && items[index]) go(items[index].path);
            }}
          />
        </label>
        <ul className="mt-2 max-h-72 overflow-y-auto">
          {items.map((item, i) => {
            const Icon = SECTION_ICONS[item.section];
            return (
              <li key={item.path + item.label}>
                <button
                  onClick={() => go(item.path)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-semibold ${i === index ? 'bg-paper' : ''}`}
                >
                  <Icon size={16} className="text-muted" /> {item.label}
                </button>
              </li>
            );
          })}
          {items.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{t('common.noMatch')}</li>}
        </ul>
      </div>
    </div>
  );
}
