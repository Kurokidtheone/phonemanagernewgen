// "Sent and waiting": what this phone made that the PC has not taken yet, and what it refused (with the reason in plain
// words and what the manager has to do on the PC).
import { Check, Clock, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Row } from '@/components/ui';
import { useMoney } from '@/lib/hooks';
import type { Summary } from '@/sync/effects';
import type { OutboxRow } from '@/sync/engine';
import { getEngine, useSync } from '@/sync/runtime';

const parse = (row: OutboxRow): Summary => JSON.parse(row.summary) as Summary;

export function NotSent() {
  const { t } = useTranslation();
  const money = useMoney();
  const sync = useSync();
  const [failed, setFailed] = useState<OutboxRow[]>([]);
  const [waiting, setWaiting] = useState<OutboxRow[]>([]);

  useEffect(() => {
    const engine = getEngine();
    if (!engine) return;
    void Promise.all([engine.notSent(), engine.pendingOps()]).then(([f, w]) => {
      setFailed(f);
      setWaiting(w);
    });
  }, [sync.pending, sync.notSent]);

  const line = (row: OutboxRow) => {
    const s = parse(row);
    return { title: `${t(`m.sync.what.${row.type}`)} · ${s.label}`, amount: s.amount };
  };

  return (
    <div className="h-full overflow-y-auto" data-accent="olive">
      {failed.length === 0 && waiting.length === 0 && <Empty>{t('m.sync.none')}</Empty>}
      {failed.length > 0 && <h3 className="px-5 pb-1 pt-4 font-semibold">{t('m.sync.notSentTitle')}</h3>}
      {failed.map((row) => {
        const l = line(row);
        return (
          <div key={row.op_id} className="border-b border-line/50 px-5 py-3">
            <div className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-5 w-5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
              {l.amount !== undefined && <span>{money(l.amount)}</span>}
            </div>
            <p className="mt-1 text-sm text-muted">{t(`m.sync.reason.${row.last_error ?? 'default'}`, { defaultValue: t('m.sync.reason.default') })}</p>
            <Button icon={Check} className="mt-2" onClick={() => void getEngine()?.dismiss(row.op_id)}>
              {t('m.sync.dismiss')}
            </Button>
          </div>
        );
      })}
      {waiting.length > 0 && <h3 className="px-5 pb-1 pt-4 font-semibold">{t('m.sync.waitingTitle')}</h3>}
      {waiting.map((row) => {
        const l = line(row);
        return <Row key={row.op_id} title={l.title} subtitle={<span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {t('m.sync.waitingMark')}</span>} right={l.amount !== undefined ? money(l.amount) : undefined} />;
      })}
    </div>
  );
}
