import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrinterConfig } from '@/lib/hooks-printer';
import { printerError } from '@/lib/printer';
import { toast } from '@/lib/toast';
import { Button } from './ui';

/**
 * Prints one document on the phone's Bluetooth printer. `make` draws and sends it. With no printer chosen it says
 * where to choose one instead of failing. `always` shows the button even then (a phone alone has no other printer).
 */
export function PrintButton({ make, always = false, disabled, className, variant }: { make: () => Promise<void>; always?: boolean; disabled?: boolean; className?: string; variant?: 'default' | 'primary' }) {
  const { t } = useTranslation();
  const config = usePrinterConfig();
  const [busy, setBusy] = useState(false);
  if (!always && !config.data) return null;
  const run = async (): Promise<void> => {
    if (!config.data) {
      toast(t('m.printer.chooseFirst'));
      return;
    }
    setBusy(true);
    try {
      await make();
      toast(t('m.printer.printed'));
    } catch (err) {
      toast(printerError(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon={Printer} variant={variant} className={className ?? 'w-full'} busy={busy} disabled={disabled} onClick={() => void run()}>
      {t('m.printer.print')}
    </Button>
  );
}
