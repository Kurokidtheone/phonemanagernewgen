import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { formatDateTime, useAction, useMoney } from '@/lib/hooks';

type Conflict = ApiResult<'sync.conflicts'>[number];

interface SaleLine {
  unitId?: string;
  productId?: string;
  quantity?: number;
  unitPrice?: number;
}

/**
 * "Needs review": what a phone tried to do while it was offline that the PC could not apply. Each card shows what the
 * phone did, what the PC has, and the two choices: discard it, or (for a sale of a phone that is gone) apply it with
 * another unit.
 */
export function ReviewTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const list = useQuery({ queryKey: ['sync', 'conflicts'], queryFn: () => api('sync.conflicts'), refetchInterval: 30_000 });
  const [discarding, setDiscarding] = useState<Conflict | null>(null);
  const [applying, setApplying] = useState<Conflict | null>(null);
  const discard = useAction((id: string) => api('sync.resolve', { id, action: 'discard' }), {
    success: t('sell.review.discarded'),
    invalidate: [['sync']],
    onDone: () => setDiscarding(null),
  });

  if (!list.data) return <Skeleton className="h-48" />;
  if (list.data.length === 0) return <Card><EmptyState title={t('sell.review.none')} hint={t('sell.review.noneHint')} /></Card>;

  return (
    <div className="space-y-3">
      {list.data.map((c) => {
        const payload = (c.op as { payload?: { lines?: SaleLine[]; imei1?: string; paid?: number } }).payload ?? {};
        const total = (payload.lines ?? []).reduce((sum, l) => sum + (l.unitPrice ?? 0) * (l.quantity ?? 1), 0);
        const pc = c.pcHas as { imei?: string; model?: string; status?: string; receiptNumber?: string; soldAt?: string };
        return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-semibold">
                  <Badge tone="danger">{t(`sell.review.reason.${c.reason}`, { defaultValue: c.reason })}</Badge>
                  <span>{c.deviceName ?? t('sell.review.unknownPhone')}</span>
                </div>
                <div className="text-sm text-muted">{formatDateTime(c.createdAt, i18n.language)}</div>
              </div>
              <div className="flex gap-2">
                {c.reason === 'imei_already_sold' && <Button variant="primary" onClick={() => setApplying(c)}>{t('sell.review.applyOther')}</Button>}
                <Button onClick={() => setDiscarding(c)}>{t('sell.review.discard')}</Button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg border border-line p-3">
                <div className="mb-1 font-semibold">{t('sell.review.phoneTried')}</div>
                {c.reason === 'imei_already_sold' ? (
                  <>
                    <div>{t('sell.review.saleLines', { n: (payload.lines ?? []).length })} · <b>{money(total)}</b></div>
                    <div className="text-muted">{t('sell.review.madeAt', { date: formatDateTime((c.op as { madeAt?: string }).madeAt ?? c.createdAt, i18n.language) })}</div>
                  </>
                ) : (
                  <div dir="ltr" className="mono">{payload.imei1}</div>
                )}
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="mb-1 font-semibold">{t('sell.review.pcHas')}</div>
                <div>{pc.model} <span dir="ltr" className="mono">{pc.imei}</span></div>
                <div className="text-muted">
                  {t(`sell.review.status.${pc.status ?? 'SOLD'}`, { defaultValue: pc.status ?? '' })}
                  {pc.receiptNumber && <> · <span dir="ltr" className="mono">{pc.receiptNumber}</span></>}
                  {pc.soldAt && <> · {formatDateTime(pc.soldAt, i18n.language)}</>}
                </div>
              </div>
            </div>
          </Card>
        );
      })}
      {discarding && (
        <ConfirmDialog title={t('sell.review.discardTitle')} body={t('sell.review.discardBody')} confirmLabel={t('sell.review.discard')} busy={discard.isPending} onConfirm={() => discard.mutate(discarding.id)} onClose={() => setDiscarding(null)} />
      )}
      {applying && <ApplyDialog conflict={applying} onClose={() => setApplying(null)} />}
    </div>
  );
}

/** Pick another phone from the stock to sell instead of the one that is gone. */
function ApplyDialog({ conflict, onClose }: { conflict: Conflict; onClose: () => void }) {
  const { t } = useTranslation();
  const units = useQuery({ queryKey: ['units', 'in_stock'], queryFn: () => api('units.list', { status: 'IN_STOCK' }) });
  const [unitId, setUnitId] = useState('');
  const apply = useAction(() => api('sync.resolve', { id: conflict.id, action: 'apply', unitId }), {
    success: t('sell.review.applied'),
    invalidate: [['sync'], ['units'], ['sales']],
    onDone: onClose,
  });
  return (
    <Dialog title={t('sell.review.applyTitle')} hint={t('sell.review.applyHint')} onClose={onClose} onSubmit={() => unitId && apply.mutate(undefined)} submitLabel={t('sell.review.applyOther')} busy={apply.isPending}>
      <select className="input w-full" value={unitId} onChange={(e) => setUnitId(e.target.value)} autoFocus>
        <option value="">{t('sell.review.pickUnit')}</option>
        {(units.data ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {[u.name, u.storage, u.color].filter(Boolean).join(' ')} · {u.imei1}
          </option>
        ))}
      </select>
    </Dialog>
  );
}
