import { useQuery } from '@tanstack/react-query';
import { Printer, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Badge, Button, Skeleton } from '@/components/ui';
import { api, fileUrl } from '@/lib/api';
import { formatDateTime, useAction, useMoney, useSettings } from '@/lib/hooks';
import { printBuyBackSlip } from '@/lib/slips';

/** One purchase: its lines and totals, with Cancel and (for private sellers) the buy-back slip. */
export function PurchaseDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const [cancelling, setCancelling] = useState(false);
  const query = useQuery({ queryKey: ['purchases', 'get', id], queryFn: () => api('purchases.get', { id }) });
  const cancel = useAction(() => api('purchases.cancel', { id }), {
    success: t('stock.purchases.cancelledToast'),
    invalidate: [['purchases'], ['suppliers'], ['items'], ['units'], ['models']],
    onDone: onClose,
  });
  const p = query.data;

  return (
    <>
      <Dialog wide title={t('stock.purchases.detail')} hint={p ? `${p.supplierName} · ${formatDateTime(p.date, i18n.language)}` : undefined} onClose={onClose}>
        {!p ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {p.cancelledAt && <Badge tone="danger">{t('stock.purchases.cancelled')}</Badge>}
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-paper text-muted">
                    <th className="px-3 py-2 text-start">{t('stock.items.name')}</th>
                    <th className="px-3 py-2 text-end">{t('stock.items.quantity')}</th>
                    <th className="px-3 py-2 text-end">{t('stock.items.cost')}</th>
                    <th className="px-3 py-2 text-end">{t('stock.purchases.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.id} className="border-t border-line">
                      <td className="px-3 py-2">
                        <span className="font-semibold">{l.productName}</span>
                        {l.imei1 && <span className="mono block text-xs text-muted" dir="ltr">{l.imei1}</span>}
                      </td>
                      <td className="px-3 py-2 text-end">{l.quantity}</td>
                      <td className="px-3 py-2 text-end">{money(l.unitCost)}</td>
                      <td className="px-3 py-2 text-end font-semibold">{money(l.unitCost * l.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt className="text-muted">{t('stock.purchases.total')}</dt>
              <dd className="text-end font-bold">{money(p.total)}</dd>
              <dt className="text-muted">{t('stock.purchases.paid')}</dt>
              <dd className="text-end">{money(p.paid)}</dd>
              <dt className="text-muted">{t('stock.purchases.remaining')}</dt>
              <dd className={`text-end font-bold ${p.remaining > 0 ? 'text-danger' : ''}`}>{money(p.remaining)}</dd>
            </dl>
            {p.note && <p className="text-sm text-muted">{p.note}</p>}
            {p.invoiceFile && (
              <a href={fileUrl(p.invoiceFile)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent underline">
                {t('stock.purchaseNew.invoice')}
              </a>
            )}
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {p.supplierKind === 'INDIVIDUAL' && settings && (
                <Button icon={Printer} onClick={() => void printBuyBackSlip(t, i18n.language, p, settings, money)}>
                  {t('stock.slip.print')}
                </Button>
              )}
              {!p.cancelledAt && (
                <Button icon={Undo2} className="text-danger" onClick={() => setCancelling(true)}>
                  {t('stock.purchases.cancel')}
                </Button>
              )}
              <Button className="ms-auto" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
      {cancelling && (
        <ConfirmDialog
          title={t('stock.purchases.cancelTitle')}
          body={t('stock.purchases.cancelBody')}
          confirmLabel={t('stock.purchases.cancel')}
          busy={cancel.isPending}
          onConfirm={() => cancel.mutate(undefined)}
          onClose={() => setCancelling(false)}
        />
      )}
    </>
  );
}
