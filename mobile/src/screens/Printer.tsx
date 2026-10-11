// Choose the Bluetooth receipt printer, the paper width, and print a test. The printer itself is paired once in
// Android's Bluetooth settings: this screen only lists what is paired.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScreenHeader } from '@/components/common';
import { PrintButton } from '@/components/PrintButton';
import { Button, Empty, Row } from '@/components/ui';
import { renderLines } from '@/lib/documents';
import { usePrinterConfig } from '@/lib/hooks-printer';
import { clearPrinter, pairedPrinters, printImage, printerError, savePrinter, type PrinterConfig } from '@/lib/printer';

export function PrinterScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const current = usePrinterConfig();
  const [error, setError] = useState('');
  const paired = useQuery({
    queryKey: ['printer', 'paired'],
    queryFn: async () => {
      setError('');
      try {
        return await pairedPrinters();
      } catch (err) {
        setError(printerError(t, err));
        return [];
      }
    },
    staleTime: 0,
  });
  const cfg = current.data;
  const update = async (next: PrinterConfig): Promise<void> => {
    await savePrinter(next);
    await client.invalidateQueries({ queryKey: ['printer'] });
  };
  const test = (): Promise<void> =>
    printImage(
      renderLines(
        [
          { text: t('m.printer.testTitle'), big: true, center: true },
          { text: cfg ? `${cfg.name} · ${cfg.paper} mm` : '', center: true },
          { text: '', rule: true },
          { text: 'Phone Store Manager', right: '2.400 DA', bold: true },
          { text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
          { text: 'أبجد هوز حطي كلمن · 0123456789' },
        ],
        i18n.language,
      ),
      cfg,
    );

  return (
    <div className="flex h-full flex-col" data-accent="olive">
      <ScreenHeader title={t('m.printer.title')} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <p className="px-5 py-3 text-sm text-muted">{t('m.printer.hint')}</p>

        <h3 className="px-5 pb-1 pt-2 font-semibold">{t('m.printer.paired')}</h3>
        {error && <p className="px-5 pb-2 text-sm text-danger">{error}</p>}
        {!error && paired.isSuccess && paired.data.length === 0 && <Empty>{t('m.printer.none')}</Empty>}
        {paired.data?.map((d) => (
          <Row
            key={d.address}
            title={d.name}
            subtitle={<span dir="ltr">{d.address}</span>}
            right={cfg?.address === d.address ? <Check className="h-5 w-5 text-accent" /> : undefined}
            onClick={() => void update({ name: d.name, address: d.address, paper: cfg?.paper ?? '80', cut: cfg?.cut ?? false })}
          />
        ))}
        <div className="px-5 pt-2">
          <Button icon={Printer} className="w-full" onClick={() => void paired.refetch()}>
            {t('m.printer.refresh')}
          </Button>
        </div>

        {cfg && (
          <>
            <h3 className="px-5 pb-1 pt-5 font-semibold">{t('m.printer.paper')}</h3>
            <div className="flex gap-2 px-5">
              {(['58', '80'] as const).map((w) => (
                <Button key={w} variant={cfg.paper === w ? 'primary' : 'default'} className="flex-1" onClick={() => void update({ ...cfg, paper: w })}>
                  {w} mm
                </Button>
              ))}
            </div>
            <div className="px-5 pt-3">
              <Button variant={cfg.cut ? 'primary' : 'default'} className="w-full" onClick={() => void update({ ...cfg, cut: !cfg.cut })}>
                {cfg.cut ? t('m.printer.cutOn') : t('m.printer.cutOff')}
              </Button>
              <p className="pt-1 text-sm text-muted">{t('m.printer.cutHint')}</p>
            </div>
            <div className="space-y-2 px-5 pt-4">
              <PrintButton variant="primary" make={test} />
              <Button
                variant="danger"
                className="w-full"
                onClick={() => {
                  void clearPrinter().then(() => client.invalidateQueries({ queryKey: ['printer'] }));
                }}
              >
                {t('m.printer.forget')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
