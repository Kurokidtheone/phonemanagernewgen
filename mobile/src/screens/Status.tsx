// Full-screen states: waiting for approval, not connected, update needed.
import { CloudOff, Download, Hourglass, Loader2, RefreshCw, ScanLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { forget, reconnect, useConnection } from '@/lib/connection';

function Frame({ icon, title, accent, children }: { icon: ReactNode; title: string; accent: string; children?: ReactNode }) {
  return (
    <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center gap-5 bg-paper p-8 text-center" data-accent={accent}>
      <div className="text-accent">{icon}</div>
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
    </div>
  );
}

export function WaitingScreen() {
  const { t } = useTranslation();
  const { session } = useConnection();
  return (
    <Frame icon={<Hourglass className="h-16 w-16" />} title={t('m.waiting.title')} accent="orange">
      <p className="text-muted">{t('m.waiting.hint')}</p>
      {session?.storeName && <p className="font-medium">{session.storeName}</p>}
      <Button icon={ScanLine} onClick={() => void forget()}>
        {t('m.offline.pairAgain')}
      </Button>
    </Frame>
  );
}

/** "Not connected to the shop PC": what to check, Retry and Pair again. */
export function OfflineScreen() {
  const { t } = useTranslation();
  const { searching, offlineReason } = useConnection();
  const known = ['shop_offline', 'shop_blocked'].includes(offlineReason ?? '');
  return (
    <Frame icon={<CloudOff className="h-16 w-16" />} title={t('m.offline.title')} accent="pink">
      {known && <div className="w-full max-w-sm rounded-xl bg-danger/15 p-3 text-danger">{t(`m.remote.reason_${offlineReason}`)}</div>}
      <div className="w-full max-w-sm space-y-2 text-start text-muted">
        <p className="font-medium text-ink">{t('m.offline.check')}</p>
        <ul className="list-disc space-y-1 ps-5">
          <li>{t('m.offline.wifi')}</li>
          <li>{t('m.offline.pcOpen')}</li>
          <li>{t('m.offline.setting')}</li>
        </ul>
      </div>
      {searching && (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 className="h-5 w-5 animate-spin" /> {t('m.offline.searching')}
        </div>
      )}
      <div className="flex w-full max-w-sm flex-col gap-3">
        <Button variant="primary" icon={RefreshCw} disabled={searching} onClick={() => void reconnect()}>
          {t('m.offline.retry')}
        </Button>
        <Button icon={ScanLine} onClick={() => void forget()}>
          {t('m.offline.pairAgain')}
        </Button>
      </div>
    </Frame>
  );
}

export function UpdateScreen({ side }: { side: 'app' | 'pc' }) {
  const { t } = useTranslation();
  return (
    <Frame icon={<Download className="h-16 w-16" />} title={t(`m.update.${side}`)} accent="olive">
      <p className="text-muted">{t(`m.update.${side}Hint`)}</p>
    </Frame>
  );
}
