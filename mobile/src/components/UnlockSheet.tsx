import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, inputClass } from '@/components/ui';
import { Sheet } from '@/components/common';
import { runLocal } from '@/lib/standalone';
import { answerUnlock, useUnlockRequested } from '@/lib/unlock';

/** Asks for the manager password when a protected section was touched (stand-alone edition). */
export function UnlockSheet() {
  const { t } = useTranslation();
  const open = useUnlockRequested();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const submit = async (): Promise<void> => {
    setBusy(true);
    const res = await runLocal('auth.unlock', { password });
    setBusy(false);
    if (res.ok) {
      setPassword('');
      setError('');
      return answerUnlock(true);
    }
    setError(t(`errors.${res.error.code}`, { ...res.error.params, defaultValue: t('errors.unexpected') }));
  };
  return (
    <Sheet title={t('lock.title')} onClose={() => answerUnlock(false)}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-muted">
          <Lock className="h-5 w-5" /> {t('lock.hint')}
        </div>
        <input type="password" autoFocus placeholder={t('lock.password')} className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        {error && <div className="rounded-xl bg-danger/15 p-3 text-danger">{error}</div>}
        <Button variant="primary" className="w-full" busy={busy} onClick={() => void submit()}>
          {t('lock.open')}
        </Button>
      </div>
    </Sheet>
  );
}
