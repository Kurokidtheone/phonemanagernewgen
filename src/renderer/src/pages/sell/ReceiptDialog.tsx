import { useQuery } from '@tanstack/react-query';
import { MessageCircle, Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useMoney, useSettings } from '@/lib/hooks';
import { printReceipt, receiptBody, whatsappUrl } from '@/lib/receipt';
import { toast } from '@/lib/toast';

/** Shown after payment (and from a sale's page). Prints on its own when "print receipt automatically" is on. */
export function ReceiptDialog({ saleId, justSold, onClose }: { saleId: string; justSold?: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const sale = useQuery({ queryKey: ['sales', 'get', saleId], queryFn: () => api('sales.get', { id: saleId }) }).data;
  const [html, setHtml] = useState('');
  const printed = useRef(false);

  useEffect(() => {
    if (!sale || !settings) return;
    void receiptBody(t, i18n.language, sale, settings, money).then(setHtml);
    if (justSold && settings.autoPrintReceipt && !printed.current) {
      printed.current = true;
      void printReceipt(t, i18n.language, sale, settings, money).catch(() => toast.error(t('errors.unexpected')));
    }
  }, [sale, settings, t, i18n.language, money, justSold]);

  const print = (): void => {
    if (sale && settings) void printReceipt(t, i18n.language, sale, settings, money).catch(() => toast.error(t('errors.unexpected')));
  };
  const whatsapp = (): void => {
    if (sale && settings) window.open(whatsappUrl(t, i18n.language, sale, settings, money), '_blank');
  };

  return (
    <Dialog
      title={sale ? t('sell.receiptTitle', { number: sale.receiptNumber }) : t('sell.receipt.title')}
      onClose={onClose}
      onSubmit={onClose}
      submitLabel={justSold ? t('sell.newSale') : t('common.close')}
    >
      {!sale ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          {/* Same HTML the printer gets, with every value escaped when it was built. */}
          <div className="mx-auto max-h-[50vh] w-[300px] overflow-y-auto rounded-lg border border-line bg-white p-3 text-[12px] leading-snug text-black [&_.center]:text-center [&_.end]:text-end [&_.muted]:text-neutral-500 [&_.rule]:my-2 [&_.rule]:border-t [&_.rule]:border-dashed [&_.rule]:border-black [&_.total]:font-bold [&_h1]:text-base [&_h1]:font-bold [&_table]:w-full" dangerouslySetInnerHTML={{ __html: html }} />
          <div className="flex flex-wrap gap-2">
            <Button icon={Printer} onClick={print}>{t('sell.print')}</Button>
            <Button icon={MessageCircle} onClick={whatsapp}>{t('sell.whatsapp')}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
