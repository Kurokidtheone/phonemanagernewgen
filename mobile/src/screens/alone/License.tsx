// The license: this phone's device ID (to give to the seller), the trial status, and a field for the key.
import { useQuery } from '@tanstack/react-query';
import { Copy, Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScreenHeader } from '@/components/common';
import { Button, Row, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { openWhatsapp } from '@/lib/whatsapp';
import { Panel, useDo } from './kit';

export function LicenseScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ['license'], queryFn: () => api('license.status') });
  const [key, setKey] = useState('');
  const activate = useDo(() => api('license.activate', { key: key.trim() }), { success: t('m.alone.activated'), onDone: () => setKey('') });
  const s = status.data;

  const copy = async (): Promise<void> => {
    if (!s) return;
    await navigator.clipboard.writeText(s.deviceId).catch(() => undefined);
    toast(t('common.copied'));
  };

  return (
    <div className="flex h-full flex-col" data-accent="olive">
      <ScreenHeader title={t('m.alone.license')} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s && (
          <>
            <Panel title={t('m.alone.deviceId')} hint={t('m.alone.deviceHint')}>
              <div dir="ltr" className="mono text-center text-2xl font-semibold tracking-wider">
                {s.deviceId}
              </div>
              <div className="mt-3 flex gap-2">
                <Button icon={Copy} className="flex-1" onClick={() => void copy()}>
                  {t('common.copy')}
                </Button>
                <Button icon={Send} variant="primary" className="flex-1" onClick={() => void openWhatsapp('', t('m.alone.deviceMessage', { id: s.deviceId }))}>
                  {t('sell.whatsapp')}
                </Button>
              </div>
            </Panel>
            <Panel title={t('m.alone.status')}>
              <Row title={t(`m.alone.license_${s.state}`)} subtitle={s.state === 'trial' ? t('m.alone.trialDays', { n: s.daysLeft ?? 0 }) : s.customer} />
              {s.state === 'expired' && <p className="mt-2 text-sm text-danger">{t('m.alone.readOnly')}</p>}
            </Panel>
            {s.state !== 'licensed' && (
              <Panel title={t('m.alone.pasteKey')}>
                <textarea dir="ltr" rows={4} className={`${inputClass} mono`} value={key} onChange={(e) => setKey(e.target.value)} />
                <Button variant="primary" className="mt-3 w-full" busy={activate.isPending} disabled={key.trim().length < 20} onClick={() => activate.mutate(undefined)}>
                  {t('m.alone.activate')}
                </Button>
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}
