// After the language: connect to a shop PC, or use this phone alone. The choice is saved.
import { Smartphone, Store } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { chooseMode } from '@/lib/connection';

export function ModeScreen() {
  const { t } = useTranslation();
  return (
    <div className="safe-top safe-bottom flex h-full flex-col justify-center gap-4 bg-paper p-6" data-accent="teal">
      <h1 className="text-center text-2xl font-bold">{t('m.mode.title')}</h1>
      <button className="flex items-start gap-4 rounded-3xl bg-card p-5 text-start active:scale-[0.98]" onClick={() => void chooseMode('connected')}>
        <Store className="mt-1 h-8 w-8 shrink-0 text-accent" />
        <span>
          <span className="block text-lg font-semibold">{t('m.mode.connected')}</span>
          <span className="block text-sm text-muted">{t('m.mode.connectedHint')}</span>
        </span>
      </button>
      <button className="flex items-start gap-4 rounded-3xl bg-card p-5 text-start active:scale-[0.98]" onClick={() => void chooseMode('standalone')}>
        <Smartphone className="mt-1 h-8 w-8 shrink-0 text-accent" />
        <span>
          <span className="block text-lg font-semibold">{t('m.mode.alone')}</span>
          <span className="block text-sm text-muted">{t('m.mode.aloneHint')}</span>
        </span>
      </button>
    </div>
  );
}
