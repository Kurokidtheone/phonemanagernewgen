// The cash drawer: open the day with a float, see what moved, close it with a count and read the closing report.
import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyField, ScreenHeader, useFormatMoney } from '@/components/common';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { PrintButton } from '@/components/PrintButton';
import { printReport, shareReport } from '@/lib/documents';
import { formatDateTime } from '@/lib/hooks';
import { Panel, useDo } from './kit';

export function CashScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const state = useQuery({ queryKey: ['cash', 'state'], queryFn: () => api('cash.state') });
  const current = useQuery({ queryKey: ['cash', 'current'], queryFn: () => api('cash.current') });
  const [float, setFloat] = useState<number | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [done, setDone] = useState<{ id: string; difference: number } | null>(null);
  const report = useQuery({ queryKey: ['cash', 'report', done?.id], queryFn: () => api('cash.report', { id: done!.id }), enabled: !!done });

  const open = useDo(() => api('cash.open', { openingFloat: float ?? state.data?.lastCounted ?? 0 }), { success: t('cash.opened') });
  const close = useDo(() => api('cash.close', { counted: counted ?? 0, note }), {
    success: t('cash.closed'),
    onDone: (r) => {
      setDone({ id: r.id, difference: r.difference });
      setClosing(false);
    },
  });
  const data = current.data;

  return (
    <div className="flex h-full flex-col" data-accent="pink">
      <ScreenHeader title={t('m.alone.cash')} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => Promise.all([current.refetch(), state.refetch()])}>
          {done && report.data ? (
            <Panel title={t('cash.z.title')}>
              <Row title={t('cash.expected')} right={money(report.data.expected)} />
              <Row title={t('cash.counted')} right={money(report.data.counted ?? 0)} />
              <Row title={t('cash.difference')} right={<b className={done.difference === 0 ? 'text-ok' : 'text-danger'}>{money(done.difference)}</b>} />
              <Row title={t('sell.total')} subtitle={`${report.data.salesCount}`} right={money(report.data.salesTotal)} />
              <Row title={t('cash.in')} right={money(report.data.totalIn)} />
              <Row title={t('cash.out')} right={money(report.data.totalOut)} />
              <Button icon={Share2} variant="primary" className="mt-3 w-full" onClick={() => void shareReport(t, i18n.language, report.data, money)}>
                {t('m.alone.shareReport')}
              </Button>
              <PrintButton always className="mt-2 w-full" make={() => printReport(t, i18n.language, report.data, money)} />
              <Button className="mt-2 w-full" onClick={() => setDone(null)}>
                {t('common.done')}
              </Button>
            </Panel>
          ) : !data ? (
            <Panel title={t('cash.dayClosed')} hint={t('cash.dayClosedHint')}>
              <Field label={t('cash.openingFloat')}>
                <MoneyField value={float ?? state.data?.lastCounted ?? 0} onChange={setFloat} />
              </Field>
              <Button variant="primary" className="mt-3 w-full" busy={open.isPending} onClick={() => open.mutate(undefined)}>
                {t('cash.openConfirm')}
              </Button>
            </Panel>
          ) : (
            <>
              <Panel title={t('cash.expected')}>
                <div className="text-3xl font-semibold tabular-nums">{money(data.expected)}</div>
                <div className="mt-1 text-sm text-muted">{t('cash.sinceOpening', { date: formatDateTime(data.session.openedAt, i18n.language) })}</div>
                <div className="mt-3 flex gap-6 text-sm">
                  <span>
                    {t('cash.in')} <b className="text-ok">{money(data.totalIn)}</b>
                  </span>
                  <span>
                    {t('cash.out')} <b className="text-danger">{money(data.totalOut)}</b>
                  </span>
                </div>
                {closing ? (
                  <div className="mt-4 space-y-3">
                    <Field label={t('cash.counted')}>
                      <MoneyField value={counted} onChange={setCounted} />
                    </Field>
                    <Field label={t('cash.closeNote')}>
                      <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    <Button variant="primary" className="w-full" busy={close.isPending} disabled={counted === null} onClick={() => close.mutate(undefined)}>
                      {t('cash.closeConfirm')}
                    </Button>
                    <Button className="w-full" onClick={() => setClosing(false)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <Button variant="primary" className="mt-4 w-full" onClick={() => setClosing(true)}>
                    {t('cash.closeTitle')}
                  </Button>
                )}
              </Panel>
              <h3 className="px-5 pt-2 font-semibold">{t('cash.todayMovements')}</h3>
              {data.movements.length === 0 && <Empty>{t('cash.noMovements')}</Empty>}
              {data.movements.map((m) => (
                <Row key={m.id} title={t(`cash.types.${m.type}`, { defaultValue: m.type })} subtitle={m.note || undefined} right={<b className={m.direction === 'IN' ? 'text-ok' : 'text-danger'}>{m.direction === 'IN' ? '+' : '-'}{money(m.amount)}</b>} />
              ))}
            </>
          )}
        </Refreshable>
      </div>
    </div>
  );
}
