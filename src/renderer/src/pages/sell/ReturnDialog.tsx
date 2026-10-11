import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useEnsureDay } from '@/components/EnsureDay';
import { useAction, useMoney } from '@/lib/hooks';

interface Pick {
  on: boolean;
  quantity: number;
  restock: boolean;
}

/**
 * Take goods back from a sale: choose lines and quantities, a reason, and for each line whether it
 * goes back on the shelf. "Exchange" carries the choice to the till, where the return and the
 * replacement sale are saved together.
 */
export function ReturnDialog({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const setExchange = useCart((s) => s.setExchange);
  const sale = useQuery({ queryKey: ['sales', 'get', saleId], queryFn: () => api('sales.get', { id: saleId }) }).data;
  const lines = useQuery({ queryKey: ['returns', 'lines', saleId], queryFn: () => api('returns.lines', { id: saleId }) }).data;
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [reason, setReason] = useState('');
  const day = useEnsureDay();

  const chosen = (lines ?? []).filter((l) => picks[l.id]?.on).map((l) => ({ saleLineId: l.id, quantity: picks[l.id].quantity, restock: picks[l.id].restock }));
  const preview = useQuery({
    queryKey: ['returns', 'preview', saleId, JSON.stringify(chosen)],
    queryFn: () => api('returns.preview', { saleId, lines: chosen }),
    enabled: chosen.length > 0,
  }).data;

  const patch = (id: string, change: Partial<Pick>): void => setPicks((p) => ({ ...p, [id]: { ...(p[id] ?? { on: false, quantity: 1, restock: true }), ...change } }));
  const valid = chosen.length > 0 && !!reason.trim();

  const save = useAction(() => api('returns.create', { saleId, reason, lines: chosen, exchange: null }), {
    success: t('sell.returns.saved'),
    invalidate: [['sales'], ['units'], ['items'], ['models'], ['customers'], ['customer'], ['returns'], ['cash']],
    onDone: onClose,
  });
  const exchange = (): void => {
    if (!sale || !preview) return;
    setExchange({ saleId, receipt: sale.receiptNumber, customerId: sale.customerId, reason, lines: chosen, credit: preview.refund });
    onClose();
    navigate('/sell?tab=newSale');
  };

  return (
    <>
    <Dialog
      wide
      title={sale ? t('sell.returns.title', { number: sale.receiptNumber }) : t('sell.returns.titleShort')}
      hint={sale?.customerName ?? undefined}
      onClose={onClose}
      onSubmit={() => day.ensure(() => save.mutate(undefined))}
      submitLabel={t('sell.returns.confirm')}
      busy={save.isPending || !valid}
    >
      {!lines ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-paper text-muted">
                  <th className="w-10 px-3 py-2" />
                  <th className="px-3 py-2 text-start">{t('stock.items.name')}</th>
                  <th className="px-3 py-2 text-end">{t('sell.returns.sold')}</th>
                  <th className="w-24 px-3 py-2 text-end">{t('sell.returns.quantity')}</th>
                  <th className="px-3 py-2 text-start">{t('sell.returns.restock')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const left = l.quantity - l.returnedQuantity;
                  const p = picks[l.id];
                  return (
                    <tr key={l.id} className={`border-t border-line ${left === 0 ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2">
                        <input type="checkbox" disabled={left === 0} checked={!!p?.on} onChange={(e) => patch(l.id, { on: e.target.checked })} aria-label={t('common.select')} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-semibold">{[l.name, l.storage, l.color].filter(Boolean).join(' ')}</span>
                        {l.imei1 && <span className="mono block text-xs text-muted" dir="ltr">{l.imei1}</span>}
                      </td>
                      <td className="px-3 py-2 text-end">
                        {l.quantity}
                        {l.returnedQuantity > 0 && <span className="block text-xs text-muted">{t('sell.returns.alreadyReturned', { count: l.returnedQuantity })}</span>}
                      </td>
                      <td className="px-3 py-2">
                        {l.unitId ? (
                          <span className="block text-end">1</span>
                        ) : (
                          <Input type="number" min={1} max={left} dir="ltr" disabled={left === 0 || !p?.on} value={p?.quantity ?? 1} onChange={(e) => patch(l.id, { quantity: Math.min(left, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select className="input w-auto" disabled={!p?.on} value={(p?.restock ?? true) ? 'yes' : 'no'} onChange={(e) => patch(l.id, { restock: e.target.value === 'yes' })}>
                          <option value="yes">{t('sell.returns.backToStock')}</option>
                          <option value="no">{t('sell.returns.defective')}</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Field label={t('sell.returns.reason')} required>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {preview && (
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-xl bg-paper p-3 text-sm">
              <dt className="text-muted">{t('sell.returns.value')}</dt>
              <dd className="text-end font-bold">{money(preview.value)}</dd>
              <dt className="text-muted">{t('sell.returns.debtCancelled')}</dt>
              <dd className="text-end">{money(preview.debtCancelled)}</dd>
              <dt className="text-muted">{t('sell.returns.refund')}</dt>
              <dd className="text-end font-bold text-accent">{money(preview.refund)}</dd>
            </dl>
          )}
          <Button disabled={!valid || !preview} onClick={exchange}>
            {t('sell.returns.exchange')}
          </Button>
        </>
      )}
    </Dialog>
    {day.dialog}
    </>
  );
}
