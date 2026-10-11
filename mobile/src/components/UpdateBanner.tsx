import { AppLauncher } from '@capacitor/app-launcher';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConnection } from '@/lib/connection';

/** "Update available": the PC holds a newer phone app. The download opens in the browser, which installs it. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { update } = useConnection();
  if (!update) return null;
  return (
    <button className="flex min-h-touch w-full items-center gap-3 bg-accent px-4 py-2 text-start text-[color:var(--on-action)]" onClick={() => void AppLauncher.openUrl({ url: update.url })}>
      <Download className="h-6 w-6 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{t('m.update.available')}</span>
        <span className="block text-sm opacity-90">{t('m.update.availableHint', { version: update.versionName })} · {t('m.update.download')}</span>
      </span>
    </button>
  );
}
