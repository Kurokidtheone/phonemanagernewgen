// What the user sees while the camera reads: the camera behind a transparent window, the light button, the last scans.
import { Check, Flashlight, FlashlightOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cancelScan, toggleTorch, useScanSession } from '@/lib/scanner';

export function ScanScreen() {
  const { t } = useTranslation();
  const session = useScanSession();
  if (!session) return null;
  const Light = session.torchOn ? Flashlight : FlashlightOff;
  return (
    <div className="scan-overlay safe-top safe-bottom fixed inset-0 z-50 flex flex-col">
      <div className="flex items-center gap-2 bg-black/70 p-2 text-white">
        <div className="min-w-0 flex-1 truncate ps-2 text-lg">{session.options.title || t('m.scan.title')}</div>
        {session.torchAvailable && (
          <button className="flex min-h-touch min-w-touch items-center justify-center gap-1 rounded-xl px-3 active:bg-white/20" onClick={() => void toggleTorch()} aria-pressed={session.torchOn}>
            <Light className="h-6 w-6" /> {t('m.scan.torch')}
          </button>
        )}
        <button className="flex min-h-touch items-center gap-1 rounded-xl bg-white/20 px-4 text-base font-medium active:bg-white/30" onClick={cancelScan}>
          <Check className="h-5 w-5" /> {t('m.scan.done')}
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="h-52 w-52 rounded-3xl border-4 border-white/90" />
      </div>

      <div className="max-h-[42%] overflow-y-auto bg-black/80 p-2 text-white">
        <div className="px-2 pb-1 text-sm opacity-70">
          {t('m.scan.last')} · {t('m.scan.reads', { n: session.entries.length })}
        </div>
        {session.entries.map((e) => (
          <div key={`${e.at}-${e.code}`} className="flex items-start gap-2 border-t border-white/10 px-2 py-2">
            {e.ok ? <Check className="mt-0.5 h-5 w-5 shrink-0 text-green-400" /> : <X className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />}
            <div className="min-w-0">
              <div dir="ltr" className="mono truncate text-start text-sm">
                {e.code}
              </div>
              <div className={e.ok ? 'text-sm text-green-300' : 'text-sm text-red-300'}>{e.message || t('m.scan.badImei')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
