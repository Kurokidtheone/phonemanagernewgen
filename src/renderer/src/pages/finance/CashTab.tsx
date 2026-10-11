import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ArrowDownLeft, ArrowUpRight, Lock, Plus, Printer, Smartphone, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/DataTable';
import { OpenDayDialog } from '@/components/EnsureDay';
import { Button, Card, EmptyState, Skeleton, StatCard } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDateTime, useAction, useMoney, useSettings } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { printZReport } from '@/lib/zReport';
import { CloseDialog, ManualDialog } from './CashDialogs';

type Current = NonNullable<ApiResult<'cash.current'>>;
type Movement = Current['movements'][number];
type Session = ApiResult<'cash.sessions'>[number];

const typeLabel = (t: TFunction, m: Pick<Movement, 'type' | 'refId'>): string =>
  m.type.startsWith('MANUAL') && m.refId ? `${t(`cash.types.${m.type}`)} · ${t(`cash.reasons.${m.refId}`, { defaultValue: m.refId })}` : t(`cash.types.${m.type}`, { defaultValue: m.type });

export function CashTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const [dialog, setDialog] = useState<'open' | 'manual' | 'close' | null>(null);
  const state = useQuery({ queryKey: ['cash', 'state'], queryFn: () => api('cash.state') }).data;
  const current = useQuery({ queryKey: ['cash', 'current'], queryFn: () => api('cash.current'), refetchInterval: 30_000 });
  const sessions = useQuery({ queryKey: ['cash', 'sessions'], queryFn: () => api('cash.sessions') });
  const held = useQuery({ queryKey: ['cash', 'held'], queryFn: () => api('cash.phoneHeld'), refetchInterval: 30_000 }).data ?? [];
  const confirm = useAction((deviceId: string) => api('cash.confirmPhoneCash', { deviceId }), { success: t('cash.phoneConfirmed'), invalidate: [['cash']] });

  const print = async (id: string): Promise<void> => {
    if (!settings) return;
    try {
      await printZReport(t, i18n.language, await api('cash.report', { id }), settings, money);
    } catch {
      toast.error(t('errors.unexpected'));
    }
  };

  const movementColumns: Column<Movement>[] = [
    { header: t('cash.time'), width: '90px', cell: (m) => new Date(m.at).toLocaleTimeString(i18n.language === 'ar' ? 'ar-DZ-u-nu-latn' : i18n.language, { hour: '2-digit', minute: '2-digit' }) },
    { header: t('cash.type'), cell: (m) => <span className="font-semibold">{typeLabel(t, m)}</span> },
    { header: t('stock.supplier.notes'), cell: (m) => <span className="text-muted">{m.note || '—'}</span> },
    { header: t('stock.payment.amount'), align: 'end', cell: (m) => <b className={m.direction === 'IN' ? 'text-ok' : 'text-danger'}>{m.direction === 'IN' ? '+' : '-'}{money(m.amount)}</b> },
  ];
  const sessionColumns: Column<Session>[] = [
    { header: t('cash.day'), cell: (s) => formatDateTime(s.openedAt, i18n.language) },
    { header: t('cash.openingFloat'), align: 'end', cell: (s) => money(s.openingFloat) },
    { header: t('cash.expected'), align: 'end', cell: (s) => money(s.expected) },
    { header: t('cash.counted'), align: 'end', cell: (s) => (s.countedAmount === null ? <span className="text-muted">{t('cash.stillOpen')}</span> : money(s.countedAmount)) },
    { header: t('cash.difference'), align: 'end', cell: (s) => (s.difference === null ? '—' : <b className={s.difference === 0 ? 'text-ok' : 'text-danger'}>{money(s.difference)}</b>) },
    { header: '', width: '60px', align: 'end', cell: (s) => (
      <button type="button" className="rounded-md p-1.5 text-muted hover:bg-paper" aria-label={t('cash.z.print')} onClick={(e) => (e.stopPropagation(), void print(s.id))}>
        <Printer size={16} />
      </button>
    ) },
  ];

  if (current.isLoading || !state) return <Skeleton className="h-64" />;
  const data = current.data;

  // Totals by type for the movement chips.
  const byType = new Map<string, { count: number; amount: number; direction: 'IN' | 'OUT' }>();
  for (const m of data?.movements ?? []) {
    const key = `${m.direction}:${m.type}`;
    const row = byType.get(key) ?? { count: 0, amount: 0, direction: m.direction };
    byType.set(key, { count: row.count + 1, amount: row.amount + m.amount, direction: m.direction });
  }

  return (
    <div className="space-y-6">
      {!data ? (
        <Card>
          <EmptyState
            title={t('cash.dayClosed')}
            hint={t('cash.dayClosedHint')}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setDialog('open')}>
                {t('cash.openTitle')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard icon={Wallet} label={t('cash.expected')} value={money(data.expected)} hint={t('cash.sinceOpening', { date: formatDateTime(data.session.openedAt, i18n.language) })} />
            <StatCard icon={Lock} label={t('cash.openingFloat')} value={money(data.session.openingFloat)} />
            <StatCard icon={ArrowDownLeft} label={t('cash.in')} value={<span className="text-ok">{money(data.totalIn)}</span>} />
            <StatCard icon={ArrowUpRight} label={t('cash.out')} value={<span className="text-danger">{money(data.totalOut)}</span>} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={Plus} onClick={() => setDialog('manual')}>{t('cash.manualTitle')}</Button>
            <Button variant="primary" icon={Lock} onClick={() => setDialog('close')}>{t('cash.closeTitle')}</Button>
          </div>
          <section>
            <h2 className="mb-2 text-lg font-bold">{t('cash.todayMovements')}</h2>
            <div className="mb-3 flex flex-wrap gap-2">
              {[...byType].map(([key, v]) => (
                <span key={key} className="rounded-lg border border-line bg-card px-3 py-1.5 text-xs">
                  {typeLabel(t, { type: key.split(':')[1], refId: null })} ({v.count}) <b className={v.direction === 'IN' ? 'text-ok' : 'text-danger'}>{v.direction === 'IN' ? '+' : '-'}{money(v.amount)}</b>
                </span>
              ))}
            </div>
            <DataTable rows={data.movements} columns={movementColumns} rowKey={(m) => m.id} emptyTitle={t('cash.noMovements')} />
          </section>
        </>
      )}
      {held.length > 0 && (
        <Card icon={Smartphone} title={t('cash.phoneHeld')} hint={t('cash.phoneHeldHint')}>
          <div className="space-y-2">
            {held.map((h) => (
              <div key={h.deviceId} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <b>{h.deviceName ?? t('cash.phoneUnknown')}</b> · {t('cash.phoneHeldCount', { n: h.count })}
                </span>
                <span className="flex items-center gap-3">
                  <b>{money(h.amount)}</b>
                  <Button variant="primary" disabled={!data || confirm.isPending} title={!data ? t('cash.dayClosedHint') : undefined} onClick={() => confirm.mutate(h.deviceId)}>
                    {t('cash.phoneConfirm')}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <section>
        <h2 className="mb-2 text-lg font-bold">{t('cash.history')}</h2>
        <DataTable rows={sessions.data} loading={sessions.isLoading} columns={sessionColumns} rowKey={(s) => s.id} emptyTitle={t('cash.noSessions')} />
      </section>

      {dialog === 'open' && <OpenDayDialog lastCounted={state.lastCounted} onClose={() => setDialog(null)} />}
      {dialog === 'manual' && <ManualDialog onClose={() => setDialog(null)} />}
      {dialog === 'close' && data && <CloseDialog expected={data.expected} onClose={() => setDialog(null)} />}
    </div>
  );
}

