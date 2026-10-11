import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { QR_TOKEN_PATTERN } from '@shared/schemas';
import { Dialog } from '@/components/Dialog';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useScanner } from '@/lib/hooks';
import { toast } from '@/lib/toast';

/**
 * The global scanner listener for the Stock pages: a scanned IMEI opens its unit, a scanned
 * barcode opens its item, and an unknown code offers to create one. Ignored while a dialog is
 * open, so scanning into a form field just fills the field.
 */
export function StockScanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [unknown, setUnknown] = useState<string | null>(null);

  useScanner((code) => {
    // A repair ticket's QR code is handled for the whole app (App.tsx).
    if (document.querySelector('[role="dialog"]') || QR_TOKEN_PATTERN.test(code)) return;
    api('stock.lookup', { code })
      .then((found) => {
        if (found?.type === 'unit') navigate(`/stock/phones/${found.id}`);
        else if (found?.type === 'item') navigate(`/stock?tab=items&open=${found.id}`);
        else setUnknown(code);
      })
      .catch(() => toast.error(t('errors.unexpected')));
  });

  if (!unknown) return null;
  const create = (tab: 'phones' | 'items'): void => {
    navigate(`/stock?tab=${tab}&new=${encodeURIComponent(unknown)}`);
    setUnknown(null);
  };
  return (
    <Dialog title={t('stock.scan.unknownTitle')} hint={t('stock.scan.unknownBody', { code: unknown })} onClose={() => setUnknown(null)}>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => create('phones')}>{t('stock.scan.createPhone')}</Button>
        <Button variant="primary" onClick={() => create('items')}>{t('stock.scan.createItem')}</Button>
        <Button onClick={() => setUnknown(null)}>{t('common.cancel')}</Button>
      </div>
    </Dialog>
  );
}
