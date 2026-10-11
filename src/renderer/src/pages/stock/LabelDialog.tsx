import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Field, Input } from '@/components/ui';
import { useMoney, useSettings } from '@/lib/hooks';
import { printLabels, type LabelSource } from '@/lib/labels';
import { toast } from '@/lib/toast';

/** Prints one label per selected item or unit. Rows without a code are skipped and counted. */
export function LabelDialog({ sources, onClose }: { sources: (Omit<LabelSource, 'code'> & { code: string | null })[]; onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const size = useSettings().data?.labelSize ?? '40x25';
  const [copies, setCopies] = useState('1');
  const [busy, setBusy] = useState(false);
  const printable = sources.filter((s): s is LabelSource => !!s.code);
  const n = Math.max(1, Math.min(99, Math.floor(Number(copies)) || 1));

  const print = async (): Promise<void> => {
    setBusy(true);
    try {
      await printLabels(printable, size, n, money);
      onClose();
    } catch {
      toast.error(t('errors.unexpected'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('stock.labels.title')}
      hint={t('stock.labels.hint', { size: size.replace('x', ' × ') })}
      onClose={onClose}
      onSubmit={() => void print()}
      submitLabel={t('stock.labels.print')}
      busy={busy || printable.length === 0}
    >
      <Field label={t('stock.labels.copies')}>
        <Input type="number" min={1} max={99} dir="ltr" value={copies} onChange={(e) => setCopies(e.target.value)} />
      </Field>
      <p className="text-sm font-semibold">{t('stock.labels.count', { count: printable.length * n })}</p>
      {sources.length > printable.length && <p className="text-sm text-danger">{t('stock.labels.skipped', { count: sources.length - printable.length })}</p>}
    </Dialog>
  );
}
