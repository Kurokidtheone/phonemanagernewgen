// Owner's home: today at a glance. Each card opens a simple list.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Clock, HandCoins, TrendingUp, Wrench, ShoppingBag, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Empty, Refreshable, Row } from '@/components/ui';
import { useConnection } from '@/lib/connection';
import { lastExported } from '@/lib/standalone';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, listRefresh, useMoney } from '@/lib/hooks';

type ListId = 'sales' | 'ready' | 'overdue' | 'debts';

function Card({ icon: Icon, label, value, hint, onClick }: { icon: LucideIcon; label: string; value: ReactNode; hint?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-sm text-muted">
        <Icon className="h-4 w-4 text-accent" /> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-sm text-muted">{hint}</div>}
    </>
  );
  const cls = 'min-h-[92px] rounded-3xl bg-card p-4 text-start';
  return onClick ? (
    <button className={`${cls} transition active:scale-[0.98] active:bg-accent-faint`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const dayRange = (): { from: string; to: string } => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000 - 1).toISOString() };
};

export function Home() {
  const { t } = useTranslation();
  const money = useMoney();
  const client = useQueryClient();
  const [list, setList] = useState<ListId | null>(null);
  const alone = useConnection().route === 'local';
  const lastBackup = useQuery({ queryKey: ['backup', 'last'], queryFn: lastExported, enabled: alone });
  // On a phone alone the data exists nowhere else: after 7 days without an export, say so.
  const backupDue = alone && lastBackup.isSuccess && (!lastBackup.data || Date.now() - new Date(lastBackup.data).getTime() > 7 * 86_400_000);
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api('overview.get'), refetchInterval: listRefresh });
  const debts = useQuery({ queryKey: ['debts'], queryFn: () => api('customer.list', { inDebt: true }), refetchInterval: listRefresh });

  if (list) return <HomeList id={list} onBack={() => setList(null)} />;
  const o = overview.data;
  const totalDebt = (debts.data ?? []).reduce((sum, c) => sum + c.balance, 0);

  return (
    <div className="h-full" data-accent="teal">
      <Refreshable onRefresh={() => client.invalidateQueries()}>
        {backupDue && <div className="mx-4 mt-3 rounded-2xl bg-danger/15 p-3 text-sm text-danger">{t('m.alone.backupBanner')}</div>}
        {o && (
          <div className="grid grid-cols-2 gap-3 px-4 py-3">
            <Card icon={ShoppingBag} label={t('m.home.salesToday')} value={money(o.today.salesTotal)} hint={t('m.home.count', { n: o.today.salesCount })} onClick={() => setList('sales')} />
            <Card icon={TrendingUp} label={t('m.home.profit')} value={o.today.profit === null ? '—' : money(o.today.profit)} />
            <Card icon={Banknote} label={t('m.home.cash')} value={o.today.expectedCash === null ? t('m.home.dayClosed') : money(o.today.expectedCash)} />
            <Card icon={HandCoins} label={t('m.home.debts')} value={money(totalDebt)} hint={`${debts.data?.length ?? 0}`} onClick={() => setList('debts')} />
            <Card icon={Wrench} label={t('m.home.ready')} value={o.attention.repairsReady} onClick={() => setList('ready')} />
            <Card icon={Clock} label={t('m.home.overdue')} value={o.attention.repairsOverdue} onClick={() => setList('overdue')} />
          </div>
        )}
      </Refreshable>
    </div>
  );
}

function HomeList({ id, onBack }: { id: ListId; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const client = useQueryClient();
  const sales = useQuery({ queryKey: ['home', 'sales'], queryFn: () => api('sales.list', dayRange()), enabled: id === 'sales', refetchInterval: listRefresh });
  const repairs = useQuery({
    queryKey: ['home', id],
    queryFn: () => api('repairs.list', id === 'ready' ? { status: 'READY' } : { overdue: true }),
    enabled: id === 'ready' || id === 'overdue',
    refetchInterval: listRefresh,
  });
  const debts = useQuery({ queryKey: ['debts'], queryFn: () => api('customer.list', { inDebt: true }), enabled: id === 'debts', refetchInterval: listRefresh });

  const titles = { sales: 'm.home.salesToday', ready: 'm.home.ready', overdue: 'm.home.overdue', debts: 'm.home.debts' } as const;
  const rows: ReactNode[] =
    id === 'sales'
      ? (sales.data ?? []).map((s) => <Row key={s.id} title={s.itemsSummary ?? s.receiptNumber} subtitle={`${s.receiptNumber} · ${s.customerName ?? ''}`} right={money(s.total)} />)
      : id === 'debts'
        ? (debts.data ?? []).map((c) => <Row key={c.id} title={c.name} subtitle={<span dir="ltr">{c.phone}</span>} right={money(c.balance)} />)
        : (repairs.data ?? []).map((r) => (
            <Row
              key={r.id}
              title={`${r.ticketNumber} · ${[r.brand, r.model].filter(Boolean).join(' ')}`}
              subtitle={`${r.customerName} · ${r.fault}`}
              right={r.dueAt ? t('m.home.due', { date: formatDate(r.dueAt, i18n.language) }) : formatDateTime(r.receivedAt, i18n.language)}
            />
          ));

  return (
    <div className="flex h-full flex-col" data-accent="teal">
      <div className="flex items-center gap-2 p-2">
        <button className="flex h-12 w-12 items-center justify-center rounded-xl active:bg-accent-faint" onClick={onBack} aria-label="back">
          <ArrowLeft className="h-6 w-6 rtl:rotate-180" />
        </button>
        <h2 className="text-lg font-semibold">{t(titles[id])}</h2>
      </div>
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries()}>{rows.length === 0 ? <Empty>{t('m.home.emptyList')}</Empty> : rows}</Refreshable>
      </div>
    </div>
  );
}
