// The connected app: top bar (shop name, status dot), the tab's content, bottom tab bar. Tabs depend on the role.
import { Home as HomeIcon, MoreHorizontal, Search, ShoppingCart, Users, Wrench, Boxes, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import appIcon from '@/assets/app-icon.png';
import { UpdateBanner } from '@/components/UpdateBanner';
import { useConnection } from '@/lib/connection';
import { ago } from '@/lib/time';
import { useSync } from '@/sync/runtime';
import { ACCENT, TABS, type TabId } from '@/lib/roles';
import { onToast } from '@/lib/toast';
import { Customers } from './Customers';
import { Home } from './Home';
import { Lookup } from './Lookup';
import { More } from './More';
import { MoreAlone } from './alone/MoreAlone';
import { UnlockSheet } from '@/components/UnlockSheet';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RepairsHome } from './repairs/RepairsHome';
import { SellHome } from './sell/SellHome';
import { StockHome } from './stock/StockHome';

const ICONS: Record<TabId, LucideIcon> = { home: HomeIcon, sell: ShoppingCart, stock: Boxes, repairs: Wrench, lookup: Search, customers: Users, more: MoreHorizontal };

function Content({ tab, alone }: { tab: TabId; alone: boolean }) {
  switch (tab) {
    case 'home':
      return <Home />;
    case 'lookup':
      return <Lookup />;
    case 'customers':
      return <Customers />;
    case 'stock':
      return <StockHome />;
    case 'sell':
      return <SellHome />;
    case 'repairs':
      return <RepairsHome />;
    case 'more':
      return alone ? <MoreAlone /> : <More />;
    default:
      return null;
  }
}

export function Shell() {
  const { t, i18n } = useTranslation();
  const { session, role, phase, route, mode } = useConnection();
  const alone = mode === 'standalone';
  const ownStore = useQuery({ queryKey: ['settings'], queryFn: () => api('settings.get'), enabled: alone }).data?.storeName;
  const sync = useSync();
  // Working from the phone's own copy: no route to the PC, but the app is open.
  const offlineMode = phase === 'connected' && route === 'none';
  const tabs = useMemo(() => (role ? TABS[role] : []), [role]);
  const [tab, setTab] = useState<TabId>(tabs[0] ?? 'more');
  const [message, setMessage] = useState('');

  useEffect(() => {
    onToast((m) => {
      setMessage(m);
      setTimeout(() => setMessage(''), 3500);
    });
    return () => onToast(null);
  }, []);
  useEffect(() => {
    if (tabs.length && !tabs.includes(tab)) setTab(tabs[0]);
  }, [tabs, tab]);

  return (
    <div className="flex h-full flex-col bg-paper" data-accent={ACCENT[tab]}>
      <header className="safe-top flex items-center justify-between gap-3 bg-paper px-5 pb-2 pt-3">
        {/* Only the shop's logo mark and its name: the app's own name is not repeated here. */}
        <div className="flex min-w-0 items-center gap-3">
          <img src={appIcon} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
          <h1 className="truncate text-lg font-semibold">{alone ? ownStore : session?.storeName}</h1>
        </div>
        {/* In the shop (the normal case) is just a green dot; only the unusual states say a word. */}
        {!alone && <span className="flex items-center gap-2 text-xs text-muted" role="status">
          {offlineMode
            ? t(sync.pending > 0 ? 'm.status.offlineWaiting' : 'm.status.offlineNone', { n: sync.pending })
            : phase !== 'connected'
              ? t('m.status.offline')
              : route === 'remote'
                ? t('m.status.remote')
                : sync.pending > 0
                  ? t('m.status.waiting', { n: sync.pending })
                  : null}
          <span className={`h-2.5 w-2.5 rounded-full ${phase !== 'connected' ? 'bg-danger' : offlineMode ? 'bg-amber-500' : route === 'remote' ? 'bg-accent' : 'bg-ok'}`} />
        </span>}
      </header>
      <UpdateBanner />
      {offlineMode && <div className="bg-accent-soft px-5 py-1.5 text-xs text-muted">{t('m.sync.lastUpdated', { when: ago(sync.lastSyncAt, i18n.language, t('m.sync.lastUpdatedNever')) })}</div>}
      <main className="relative min-h-0 flex-1">
        <Content tab={tab} alone={alone} />
        {alone && <UnlockSheet />}
        {message && <div className="absolute inset-x-4 bottom-4 rounded-2xl bg-ink px-4 py-3 text-center text-sm text-paper shadow-lg">{message}</div>}
      </main>
      <nav className="safe-bottom flex border-t border-line bg-paper">
        {tabs.map((id) => {
          const Icon = ICONS[id];
          const active = id === tab;
          return (
            <button key={id} data-accent={ACCENT[id]} className={`flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? 'font-semibold text-ink' : 'text-muted'}`} onClick={() => setTab(id)} aria-current={active ? 'page' : undefined}>
              <Icon className={`h-6 w-6 ${active ? 'text-accent' : ''}`} strokeWidth={active ? 2.4 : 1.8} />
              {t(`m.tabs.${id}`)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
