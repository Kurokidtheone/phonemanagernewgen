import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, type ApiResult } from '@/lib/api';
import { formatDate, useAction } from '@/lib/hooks';
import { CancelDialog } from './CancelDialog';
import { DeliverDialog } from './DeliverDialog';
import { OPEN_REPAIR_STATUSES } from './shared';

type Ticket = ApiResult<'repairs.list'>[number];
const DELIVERED = 'DELIVERED';

const startOfToday = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** One column per open status; drag a card to change its status, or onto "Delivered today" to deliver. */
export function BoardTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const since = useMemo(startOfToday, []);
  const list = useQuery({ queryKey: ['repairs', 'board', since], queryFn: () => api('repairs.list', { boardSince: since }), refetchInterval: 60_000 });
  const [dragging, setDragging] = useState<Ticket | null>(null);
  const [delivering, setDelivering] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // Needs a small drag before it starts, so a plain click still opens the ticket.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const move = useAction((v: { id: string; status: (typeof OPEN_REPAIR_STATUSES)[number] }) => api('repairs.setStatus', { ...v, note: '' }), {
    success: t('repairs.statusChanged'),
    invalidate: [['repairs']],
  });

  const tickets = list.data ?? [];
  const onStart = (e: DragStartEvent): void => setDragging(tickets.find((x) => x.id === e.active.id) ?? null);
  const onEnd = (e: DragEndEvent): void => {
    setDragging(null);
    const ticket = tickets.find((x) => x.id === e.active.id);
    const target = e.over?.id as string | undefined;
    if (!ticket || !target || ticket.status === target) return;
    if (target === DELIVERED) setDelivering(ticket.id);
    else if ((OPEN_REPAIR_STATUSES as readonly string[]).includes(target)) move.mutate({ id: ticket.id, status: target as (typeof OPEN_REPAIR_STATUSES)[number] });
  };

  const columns: { id: string; title: string; items: Ticket[] }[] = [
    ...OPEN_REPAIR_STATUSES.map((s) => ({ id: s, title: t(`customers.repairStatus.${s}`), items: tickets.filter((x) => x.status === s) })),
    { id: DELIVERED, title: t('repairs.deliveredToday'), items: tickets.filter((x) => x.status === DELIVERED) },
  ];

  return (
    <>
      <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
        <div className="grid grid-cols-5 gap-3 overflow-x-auto">
          {columns.map((c) => (
            <Column key={c.id} id={c.id} title={c.title} count={c.items.length} accent={c.id === DELIVERED}>
              {c.items.map((x) => (
                <Card key={x.id} ticket={x} locked={c.id === DELIVERED} onOpen={() => navigate(`/repairs/${x.id}`)} />
              ))}
              {c.items.length === 0 && <p className="py-6 text-center text-xs text-muted">{t('repairs.emptyColumn')}</p>}
            </Column>
          ))}
        </div>
        <DragOverlay>{dragging && <Card ticket={dragging} overlay onOpen={() => undefined} />}</DragOverlay>
      </DndContext>
      {delivering && <DeliverDialog id={delivering} onClose={() => setDelivering(null)} onCancelInstead={() => (setCancelling(delivering), setDelivering(null))} />}
      {cancelling && <CancelDialog id={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}

function Column({ id, title, count, accent, children }: { id: string; title: string; count: number; accent?: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={clsx('min-h-[320px] min-w-[200px] rounded-2xl border p-2.5 transition', isOver ? 'border-accent bg-accent-soft' : 'border-line bg-paper', accent && 'border-dashed')}>
      <h3 className="mb-2 flex items-center justify-between px-1 text-sm font-bold">
        <span>{title}</span>
        <span className="rounded-full bg-card px-2 py-0.5 text-xs text-muted">{count}</span>
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Card({ ticket, locked, overlay, onOpen }: { ticket: Ticket; locked?: boolean; overlay?: boolean; onOpen: () => void }) {
  const { i18n } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: ticket.id, disabled: locked || overlay });
  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : { ...listeners, ...attributes })}
      onClick={onOpen}
      className={clsx(
        'cursor-grab rounded-xl border bg-card p-3 text-start shadow-sm transition hover:border-accent',
        ticket.overdue ? 'border-danger/60' : 'border-line',
        isDragging && 'opacity-40',
        overlay && 'rotate-1 shadow-xl',
      )}
    >
      <p className="mono text-xs font-bold text-accent" dir="ltr">{ticket.ticketNumber}</p>
      <p className="mt-0.5 truncate text-sm font-semibold">{ticket.customerName}</p>
      <p className="flex items-center gap-1 truncate text-xs text-muted">
        <Wrench size={12} aria-hidden /> {[ticket.brand, ticket.model].filter(Boolean).join(' ') || '—'}
      </p>
      <p className="mt-1 line-clamp-2 text-xs">{ticket.fault}</p>
      {ticket.dueAt && !locked && (
        <p className={clsx('mt-1.5 flex items-center gap-1 text-xs font-semibold', ticket.overdue ? 'text-danger' : 'text-muted')}>
          <CalendarClock size={12} aria-hidden /> {formatDate(ticket.dueAt, i18n.language)}
        </p>
      )}
    </article>
  );
}

