import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Field, inputClass } from '@/components/ui';
import { isValidPin, lockedFor, setPin, usePinStatus, verifyPin } from '@/lib/pin';

/** Asked every time the app opens. A phone paired before the PIN existed is asked to choose one. */
export function PinScreen() {
  const { t } = useTranslation();
  const status = usePinStatus();
  const [pin, setPinText] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choosing = status === 'needs_set';

  const submit = async (): Promise<void> => {
    setError('');
    if (choosing) {
      if (!isValidPin(pin)) return setError(t('m.pin.bad'));
      if (pin !== again) return setError(t('m.pin.mismatch'));
      return setPin(pin);
    }
    const wait = lockedFor();
    if (wait > 0) return setError(t('m.pin.locked', { seconds: wait }));
    setBusy(true);
    const ok = await verifyPin(pin);
    setBusy(false);
    if (!ok) {
      setPinText('');
      setError(lockedFor() > 0 ? t('m.pin.locked', { seconds: lockedFor() }) : t('m.pin.wrong'));
    }
  };

  return (
    <div className="safe-top safe-bottom flex h-full flex-col justify-center gap-4 bg-paper p-8" data-accent="teal">
      <Lock className="mx-auto h-12 w-12 text-accent" />
      <h1 className="text-center text-2xl font-bold">{t(choosing ? 'm.pin.setTitle' : 'm.pin.enterTitle')}</h1>
      {choosing && <p className="text-center text-muted">{t('m.pin.setHint')}</p>}
      <Field label={t('m.pin.label')}>
        <input dir="ltr" type="password" inputMode="numeric" autoFocus maxLength={6} className={`${inputClass} text-center text-2xl tracking-[0.5em]`} value={pin} onChange={(e) => setPinText(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
      {choosing && (
        <Field label={t('m.pin.repeat')}>
          <input dir="ltr" type="password" inputMode="numeric" maxLength={6} className={`${inputClass} text-center text-2xl tracking-[0.5em]`} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </Field>
      )}
      {error && <div className="rounded-xl bg-danger/15 p-3 text-center text-danger">{error}</div>}
      <Button variant="primary" busy={busy} onClick={() => void submit()}>
        {t(choosing ? 'm.pin.save' : 'm.pin.open')}
      </Button>
    </div>
  );
}
