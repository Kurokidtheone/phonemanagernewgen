// Prints what the PC is asked to print by a phone: a sale receipt or a repair intake slip, silently, on the
// receipt printer chosen in Settings. Nothing is shown; the core waits for the outcome.
import { listen } from '@tauri-apps/api/event';
import QRCode from 'qrcode';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/money';
import type { Language } from '@shared/app.config';
import { api, type ApiResult } from '@/lib/api';
import { printHtml, printSilently } from '@/lib/print';
import { receiptBody } from '@/lib/receipt';
import { intakeSlipBody } from '@/lib/repairSlips';

interface PrintRequest {
  id: string;
  kind: 'receipt' | 'repairSlip';
  data: unknown;
}

export function PrintBridge() {
  const { t, i18n } = useTranslation();
  // A document the core asked to print with the dialog (the print.html channel).
  useEffect(() => {
    const stop = listen<string>('print:html', (event) => void printHtml(event.payload));
    return () => void stop.then((unlisten) => unlisten());
  }, []);
  useEffect(() => {
    const stop = listen<PrintRequest>('print:request', ({ payload: request }) => {
      void (async () => {
        try {
          const settings = await api('settings.get');
          const lang = i18n.language as Language;
          const money = (c: number): string => formatMoney(c, lang);
          if (request.kind === 'receipt') {
            const { sale } = request.data as { sale: ApiResult<'sales.get'> };
            await printSilently(await receiptBody(t, lang, sale, settings, money), settings.receiptSize, request.id);
          } else {
            const { repair } = request.data as { repair: ApiResult<'repairs.get'> };
            const qr = await QRCode.toDataURL(repair.qrToken, { margin: 1, width: 240 });
            await printSilently(intakeSlipBody(t, lang, repair, settings, money, qr), '80mm', request.id);
          }
        } catch {
          // The phone is told the print failed when the PC does not answer in time.
        }
      })();
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [t, i18n.language]);
  return null;
}
