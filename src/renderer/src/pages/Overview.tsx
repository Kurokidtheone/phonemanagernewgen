import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, ClipboardCheck, CircleCheck, CircleDashed, DatabaseBackup, House, KeyRound, PackageMinus, ReceiptText, ShieldCheck, Truck, UserX, Wallet, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { PageBody, PageHeader } from '@/components/Page';
import { Sparkline } from '@/components/Sparkline';
import { Card, Skeleton, StatCard } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, useLicense, useMoney, useSettings } from '@/lib/hooks';

/**
 * The home page. Today at a glance, what needs attention (each card opens the matching filtered
 * list) and the last 7 days. Profit is left out by the main process while Finance is locked.
 */
export function Overview() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const settings = useSettings().data;
  const auth = useAuth().data;
  const license = useLicense().data;
  const data = useQuery({ queryKey: ['overview'], queryFn: () => api('overview.get'), refetchInterval: 60_000 }).data;

  const review = useQuery({ queryKey: ['sync', 'count'], queryFn: () => api('sync.conflictCount'), refetchInterval: 60_000 }).data ?? 0;

  if (!settings || !auth || !license || !data) return <Skeleton className="m-8 h-56" />;
  const { today, attention, week } = data;

  const steps = [
    { done: !!settings.storeName, icon: Building2, label: t('overview.stepIdentity'), to: '/settings#identity' },
    { done: auth.hasPassword, icon: KeyRound, label: t('overview.stepPassword'), to: '/settings#security' },
    { done: license.state === 'licensed', icon: ShieldCheck, label: t('overview.stepLicense'), to: '/settings#license' },
    { done: false, icon: DatabaseBackup, label: t('overview.stepBackup'), to: '/settings#backup' },
  ];

  const alerts: { icon: typeof Wrench; label: string; count: number; hint?: string; to: string }[] = [
    { icon: Wrench, label: t('overview.repairsReady'), count: attention.repairsReady, to: '/repairs?tab=tickets&status=READY' },
    { icon: AlertTriangle, label: t('overview.repairsOverdue'), count: attention.repairsOverdue, to: '/repairs?tab=tickets&overdue=1' },
    { icon: PackageMinus, label: t('overview.lowStock'), count: attention.lowStock, to: '/stock?tab=items&low=1' },
    { icon: UserX, label: t('overview.debtsOverdue'), count: attention.debtsOverdue, hint: attention.debtsOverdue ? money(attention.debtsOverdueAmount) : undefined, to: '/people?filter=overdue' },
    { icon: ClipboardCheck, label: t('overview.needsReview'), count: review, to: '/sell?tab=review' },
    { icon: Truck, label: t('overview.supplierBalances'), count: attention.supplierBalances, hint: attention.supplierBalances ? money(attention.supplierOwed) : undefined, to: '/stock?tab=suppliers' },
  ];

  return (
    <PageBody>
      <PageHeader icon={House} title={settings.storeName || t('overview.title')} subtitle={t('overview.subtitle')} />

      <h2 className="mb-2 text-lg font-bold">{t('overview.today')}</h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={ReceiptText} label={t('overview.salesTotal')} value={money(today.salesTotal)} onClick={() => navigate('/sell?tab=history&today=1')} />
        <StatCard icon={ReceiptText} label={t('overview.salesCount')} value={today.salesCount} onClick={() => navigate('/sell?tab=history&today=1')} />
        {today.profit !== null && <StatCard icon={Wallet} label={t('overview.profit')} value={<span className={today.profit >= 0 ? 'text-ok' : 'text-danger'}>{money(today.profit)}</span>} onClick={() => navigate('/finance?tab=analytics')} />}
        <StatCard
          icon={Wallet}
          label={t('overview.expectedCash')}
          value={today.expectedCash === null ? <span className="text-base text-muted">{t('overview.dayClosed')}</span> : money(today.expectedCash)}
          onClick={() => navigate('/finance?tab=cash')}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="mb-2 text-lg font-bold">{t('overview.attention')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {alerts.map((a) => (
              <StatCard
                key={a.label}
                icon={a.icon}
                label={a.label}
                value={<span className={a.count > 0 ? 'text-danger' : 'text-ok'}>{a.count}</span>}
                hint={a.count === 0 ? t('overview.allGood') : a.hint}
                onClick={() => navigate(a.to)}
              />
            ))}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-lg font-bold">{t('overview.last7')}</h2>
          <Card>
            <p className="text-sm text-muted">{t('overview.salesTotal')}</p>
            <p className="text-2xl font-bold text-accent">{money(week.reduce((s, d) => s + d.value, 0))}</p>
            <Sparkline data={week} format={money} lang={i18n.language} label={t('overview.salesTotal')} />
          </Card>
        </section>
      </div>

      {steps.some((s) => !s.done) && (
        <div className="mt-6">
          <Card title={t('overview.setup')} hint={t('overview.setupHint')}>
            <ul className="divide-y divide-line">
              {steps.map((s) => (
                <li key={s.to}>
                  <Link to={s.to} className="flex items-center gap-3 py-3 hover:text-accent">
                    {s.done ? <CircleCheck size={18} className="text-ok" /> : <CircleDashed size={18} className="text-muted" />}
                    <s.icon size={17} className="text-muted" aria-hidden />
                    <span className="font-semibold">{s.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </PageBody>
  );
}
