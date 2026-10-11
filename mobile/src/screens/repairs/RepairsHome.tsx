// The repair desk: the board by status, a new repair with photos, the ticket, and a slip's QR code opens its ticket.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OPEN_REPAIR_STATUSES, QR_TOKEN_PATTERN } from '@shared/schemas';
import { Button, Empty, Pill, Refreshable, Row } from '@/components/ui';
import { api, errorText, type ApiResult } from '@/lib/api';
import { useConnection } from '@/lib/connection';
import { formatDate, listRefresh, useCanWrite } from '@/lib/hooks';
import { scanCode, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';
import { NewRepair } from './NewRepair';
import { Ticket } from './Ticket';

type Repair = ApiResult<'repairs.list'>[number];
type View = { name: 'board' } | { name: 'new' } | { name: 'ticket'; id: string };
const BOARD = [...OPEN_REPAIR_STATUSES, 'DELIVERED'] as const;

export function RepairsHome() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const employeeId = useConnection().employeeId;
  const canWrite = useCanWrite();
  const [view, setView] = useState<View>({ name: 'board' });
  const [mine, setMine] = useState(false);
  const since = (): string => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  };
  const board = useQuery({ queryKey: ['repairs', 'board'], queryFn: () => api('repairs.list', { boardSince: since() }), refetchInterval: listRefresh });

  if (view.name === 'new') return <NewRepair onBack={() => setView({ name: 'board' })} onOpen={(id) => setView({ name: 'ticket', id })} />;
  if (view.name === 'ticket') return <Ticket id={view.id} onBack={() => setView({ name: 'board' })} />;

  const scanSlip = async (): Promise<void> => {
    try {
      const token = await scanCode({ title: t('m.rep.scanSlip') });
      if (!token) return;
      const hit = QR_TOKEN_PATTERN.test(token) ? await api('repairs.byToken', { token }) : null;
      if (hit) setView({ name: 'ticket', id: hit.id });
      else toast(t('m.rep.slipNotFound'));
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
  };

  const rows = (board.data ?? []).filter((r) => !mine || r.employeeId === employeeId);
  const by = (status: string): Repair[] => rows.filter((r) => r.status === status);
  return (
    <div className="flex h-full flex-col" data-accent="orange">
      <div className={`grid gap-2 p-3 ${canWrite ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {canWrite && (
          <Button variant="primary" icon={Plus} onClick={() => setView({ name: 'new' })}>
            {t('m.rep.new')}
          </Button>
        )}
        <Button icon={ScanLine} onClick={() => void scanSlip()}>
          {t('m.rep.scanSlip')}
        </Button>
      </div>
      <div className="flex gap-2 px-3 pb-2">
        {[false, true].map((v) => (
          <button
            key={String(v)}
            disabled={v && !employeeId}
            className={`min-h-touch flex-1 rounded-xl border px-3 text-base ${mine === v ? 'border-accent bg-accent-soft font-semibold' : 'border-line bg-card'} disabled:opacity-40`}
            onClick={() => setMine(v)}
          >
            {t(v ? 'm.rep.mine' : 'm.rep.all')}
          </button>
        ))}
      </div>
      {!employeeId && <p className="px-4 pb-1 text-xs text-muted">{t('m.rep.mineNeedsEmployee')}</p>}
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['repairs'] })}>
          {rows.length === 0 && <Empty>{t('m.rep.empty')}</Empty>}
          {BOARD.map((status) => {
            const list = by(status);
            if (list.length === 0) return null;
            return (
              <section key={status}>
                <h3 className="flex items-center justify-between bg-accent-faint px-4 py-2 font-semibold">
                  {t(`customers.repairStatus.${status}`)}
                  <Pill tone="accent">{list.length}</Pill>
                </h3>
                {list.map((r) => (
                  <Row
                    key={r.id}
                    onClick={() => setView({ name: 'ticket', id: r.id })}
                    title={`${r.ticketNumber} · ${[r.brand, r.model].filter(Boolean).join(' ')}`}
                    subtitle={`${r.customerName} · ${r.fault}`}
                    right={r.dueAt ? <span className={new Date(r.dueAt) < new Date() && status !== 'DELIVERED' ? 'text-danger' : 'text-muted'}>{t('m.rep.due', { date: formatDate(r.dueAt, i18n.language) })}</span> : undefined}
                  />
                ))}
              </section>
            );
          })}
        </Refreshable>
      </div>
    </div>
  );
}
