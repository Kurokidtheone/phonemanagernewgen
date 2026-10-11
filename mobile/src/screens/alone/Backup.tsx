// Backup: export the whole shop as one zip (the desktop's format) and restore one. The Home banner reminds after 7 days.
import { useQuery } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ScreenHeader } from '@/components/common';
import { Button } from '@/components/ui';
import { ApiError, errorText } from '@/lib/api';
import { formatDateTime } from '@/lib/hooks';
import { exportBackup, lastExported, restoreBackup, shareFile } from '@/lib/standalone';
import { toast } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { Panel } from './kit';

export function BackupScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const last = useQuery({ queryKey: ['backup', 'last'], queryFn: lastExported });

  const doExport = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const out = await exportBackup(`phone-store-backup-${stamp}.zip`);
    if (!out.result.ok) return toast(errorText(t, new ApiError(out.result.error.code, out.result.error.params)));
    await shareFile({ path: out.path, mime: 'application/zip', title: t('m.alone.backupTitle') });
    void client.invalidateQueries({ queryKey: ['backup'] });
  };
  const doRestore = async (): Promise<void> => {
    if (!window.confirm(t('m.alone.restoreWarn'))) return;
    const res = await restoreBackup();
    if (!res) return;
    if (!res.ok) return toast(errorText(t, new ApiError(res.error.code, res.error.params)));
    toast(t('m.alone.restored'));
    void client.invalidateQueries();
  };

  return (
    <div className="flex h-full flex-col" data-accent="olive">
      <ScreenHeader title={t('m.alone.backup')} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Panel title={t('m.alone.backupTitle')} hint={t('m.alone.backupHint')}>
          <div className="mb-3 text-sm text-muted">{last.data ? t('m.alone.lastBackup', { date: formatDateTime(last.data, i18n.language) }) : t('m.alone.neverBackup')}</div>
          <Button icon={Download} variant="primary" className="w-full" onClick={() => void doExport()}>
            {t('m.alone.exportBackup')}
          </Button>
        </Panel>
        <Panel title={t('m.alone.restoreTitle')} hint={t('m.alone.restoreHint')}>
          <Button icon={Upload} className="w-full" onClick={() => void doRestore()}>
            {t('m.alone.restoreBackup')}
          </Button>
        </Panel>
      </div>
    </div>
  );
}
