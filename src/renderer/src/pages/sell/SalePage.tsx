import { useQuery } from '@tanstack/react-query';
import { MessageCircle, Printer, Receipt, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { PageBody, PageHeader } from '@/components/Page';
import { Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, useMoney, useSettings } from '@/lib/hooks';
import { printReceipt, whatsappUrl } from '@/lib/receipt';
import { toast } from '@/lib/toast';
import { ReceiptDialog } from './ReceiptDialog';
import { ReturnDialog } from './ReturnDialog';

export function SalePage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const { id = '' } = useParams();
  const [preview, setPreview] = useState(false);
  const [returning, setReturning] = useState(false);
  const query = useQuery({ queryKey: ['sales', 'get', id], queryFn: () => api('sales.get', { id }), retry: false });
  const sale = query.data;
  const back = { to: '/sell?tab=history', label: t('sell.history.back') };

  if (query.isError) {
    return (
      <PageBody>
        <PageHeader icon={Receipt} title={t('sell.history.notFound')} back={back} />
        <Card>
          <EmptyState title={t('errors.not_found')} />
        </Card>
      </PageBody>
    );
  }
  if (!sale || !settings) return <Skeleton className="m-8 h-64" />;
  const showProfit = sale.profit !== null;

  return (
    <PageBody>
      <PageHeader
        icon={Receipt}
        title={t('sell.receiptTitle', { number: sale.receiptNumber })}
        subtitle={formatDateTime(sale.date, i18n.language)}
        back={back}
        action={
          <div className="flex gap-2">
            <Button icon={Printer} onClick={() => void printReceipt(t, i18n.language, sale, settings, money).catch(() => toast.error(t('errors.unexpected')))}>
              {t('sell.reprint')}
            </Button>
            <Button icon={MessageCircle} onClick={() => window.open(whatsappUrl(t, i18n.language, sale, settings, money), '_blank')}>
              {t('sell.whatsapp')}
            </Button>
            <Button onClick={() => setPreview(true)}>{t('sell.preview')}</Button>
            <Button icon={Undo2} disabled={sale.status === 'RETURNED'} onClick={() => setReturning(true)}>
              {t('sell.returns.start')}
            </Button>
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title={t('sell.history.items')}>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-paper text-muted">
                  <th className="px-3 py-2 text-start">{t('stock.items.name')}</th>
                  <th className="px-3 py-2 text-end">{t('stock.items.quantity')}</th>
                  <th className="px-3 py-2 text-end">{t('sell.price')}</th>
                  <th className="px-3 py-2 text-end">{t('sell.lineDiscount')}</th>
                  <th className="px-3 py-2 text-end">{t('sell.total')}</th>
                  <th className="px-3 py-2 text-start">{t('sell.warranty')}</th>
                  {showProfit && <th className="px-3 py-2 text-end">{t('sell.history.profit')}</th>}
                </tr>
              </thead>
              <tbody>
                {sale.lines.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <span className="font-semibold">{[l.name, l.storage, l.color].filter(Boolean).join(' ')}</span>
                      {l.imei1 && <span className="mono block text-xs text-muted" dir="ltr">{l.imei1}</span>}
                    </td>
                    <td className="px-3 py-2 text-end">
                      {l.quantity}
                      {l.returnedQuantity > 0 && <span className="block text-xs text-danger">{t('sell.returns.alreadyReturned', { count: l.returnedQuantity })}</span>}
                    </td>
                    <td className="px-3 py-2 text-end">{money(l.unitPrice)}</td>
                    <td className="px-3 py-2 text-end">{l.discount ? money(l.discount) : '—'}</td>
                    <td className="px-3 py-2 text-end font-semibold">{money(l.lineTotal)}</td>
                    <td className="px-3 py-2">{l.warrantyEnd ? formatDate(l.warrantyEnd, i18n.language) : '—'}</td>
                    {showProfit && <td className={`px-3 py-2 text-end font-semibold ${(l.profit ?? 0) < 0 ? 'text-danger' : 'text-ok'}`}>{money(l.profit ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {showProfit && (
            <p className="mt-3 text-end text-sm">
              {t('sell.history.profit')}: <b className={(sale.profit ?? 0) < 0 ? 'text-danger' : 'text-ok'}>{money(sale.profit ?? 0)}</b>
            </p>
          )}
        </Card>

        <div className="space-y-5">
          <Card>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">{t('sell.customer')}</dt>
              <dd className="font-semibold">{sale.customerName ?? '—'}</dd>
              <dt className="text-muted">{t('sell.seller')}</dt>
              <dd className="font-semibold">{sale.employeeName ?? '—'}</dd>
              <dt className="text-muted">{t('sell.history.status')}</dt>
              <dd><Badge tone={sale.status === 'COMPLETED' ? 'ok' : 'accent'}>{t(`sell.status.${sale.status}`)}</Badge></dd>
              <dt className="text-muted">{t('sell.subtotal')}</dt>
              <dd>{money(sale.subtotal)}</dd>
              {sale.discount > 0 && (<><dt className="text-muted">{t('sell.discount')}</dt><dd>-{money(sale.discount)}</dd></>)}
              {sale.tradeIn && (<><dt className="text-muted">{t('sell.tradeIn')}</dt><dd>-{money(sale.tradeIn.value)} <span className="mono block text-xs text-muted" dir="ltr">{sale.tradeIn.name} · {sale.tradeIn.imei1 ?? '—'}</span></dd></>)}
              <dt className="font-bold">{t('sell.total')}</dt>
              <dd className="font-bold text-accent">{money(sale.total)}</dd>
              <dt className="text-muted">{t('sell.remaining')}</dt>
              <dd className={sale.remaining > 0 ? 'font-bold text-danger' : ''}>{money(sale.remaining)}</dd>
            </dl>
          </Card>
          {sale.returns.length > 0 && (
            <Card title={t('sell.returns.history')}>
              <ul className="divide-y divide-line text-sm">
                {sale.returns.map((r) => (
                  <li key={r.id} className="py-2">
                    <p className="flex justify-between"><span>{formatDate(r.date, i18n.language)}</span><b>{money(r.returnedValue)}</b></p>
                    <p className="text-xs text-muted">{r.reason}{r.debtCancelled > 0 ? ` · ${t('sell.returns.debtCancelled')}: ${money(r.debtCancelled)}` : ''}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title={t('sell.history.payments')}>
            {sale.payments.length === 0 ? (
              <p className="text-sm text-muted">{t('sell.history.noPayments')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {sale.payments.map((p) => (
                  <li key={p.id} className="flex justify-between py-2">
                    <span>{formatDate(p.date, i18n.language)} · {t(`sell.methods.${p.method}`, { defaultValue: p.method })}</span>
                    <b>{money(p.amount)}</b>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {preview && <ReceiptDialog saleId={id} onClose={() => setPreview(false)} />}
      {returning && <ReturnDialog saleId={id} onClose={() => setReturning(false)} />}
    </PageBody>
  );
}
