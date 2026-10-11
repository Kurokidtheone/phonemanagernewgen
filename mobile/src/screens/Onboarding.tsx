// First launch: choose the language, then pair with the shop PC (scan its QR code, or type the address and code).
import { Globe, Keyboard, Loader2, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '@shared/app.config';
import { Button, Field, inputClass } from '@/components/ui';
import { Device } from '@capacitor/device';
import { ApiError, errorText } from '@/lib/api';
import { chooseLanguage, pair, pairRemote, PairError } from '@/lib/connection';
import { isIpv4, parseQr } from '@/lib/discovery';
import { applyLanguage } from '@/i18n';
import { isValidPin, setPin } from '@/lib/pin';
import { scanCode, ScanError } from '@/lib/scanner';
import { MOBILE_DEFAULT_PORT } from '@shared/schemas';
import { parsePairCode } from '@shared/remote/pairing';

const PAIR_ERRORS: Record<string, string> = { remote_not_found: 'm.pair.remoteNotFound', no_internet: 'm.pair.noInternet', not_configured: 'm.pair.notConfigured', bad_code: 'm.pair.badRemoteCode' };
const NAMES: Record<Language, string> = { ar: 'العربية', fr: 'Français', en: 'English' };

export function LanguageScreen() {
  const { t } = useTranslation();
  return (
    <div className="safe-top safe-bottom flex h-full flex-col justify-center gap-4 bg-paper p-6" data-accent="teal">
      <h1 className="text-center text-3xl font-bold text-accent">{t('m.app.name')}</h1>
      <p className="text-center text-muted">{t('m.welcome.pick')}</p>
      {LANGUAGES.map((l) => (
        <Button
          key={l}
          variant="primary"
          className="text-lg"
          onClick={() => {
            applyLanguage(l);
            void chooseLanguage(l);
          }}
        >
          {NAMES[l]}
        </Button>
      ))}
    </div>
  );
}

export function PairScreen() {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const [away, setAway] = useState(false);
  const [remoteCode, setRemoteCode] = useState('');
  const [pin, setPinText] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(MOBILE_DEFAULT_PORT));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const deviceName = async (): Promise<string> => {
    if (name.trim()) return name.trim();
    try {
      const info = await Device.getInfo();
      return [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Android';
    } catch {
      return 'Android';
    }
  };

  const run = async (job: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (err) {
      setError(err instanceof PairError ? t(PAIR_ERRORS[err.code] ?? 'm.pair.notFound') : err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err instanceof ApiError ? err : null));
    } finally {
      setBusy(false);
    }
  };

  const scan = (): Promise<void> =>
    run(async () => {
      const text = await scanCode();
      if (!text) return;
      const qr = parseQr(text);
      if (!qr) return void setError(t('m.pair.badQr'));
      if (!isValidPin(pin)) return void setError(t('m.pin.bad'));
      await pair({ hosts: qr.hosts, port: qr.port, code: qr.code, serverId: qr.id, deviceName: await deviceName() });
      await setPin(pin);
    });

  const submit = (): Promise<void> =>
    run(async () => {
      if (!isIpv4(host)) return void setError(t('m.pair.badAddress'));
      if (!/^\d{6}$/.test(code)) return void setError(t('m.pair.badCode'));
      if (!isValidPin(pin)) return void setError(t('m.pin.bad'));
      await pair({ hosts: [host.trim()], port: Number(port) || MOBILE_DEFAULT_PORT, code, deviceName: await deviceName() });
      await setPin(pin);
    });

  const submitRemote = (): Promise<void> =>
    run(async () => {
      if (!parsePairCode(remoteCode)) return void setError(t('m.pair.badRemoteCode'));
      if (!isValidPin(pin)) return void setError(t('m.pin.bad'));
      await pairRemote({ code: remoteCode, deviceName: await deviceName() });
      await setPin(pin);
    });

  return (
    <div className="safe-top safe-bottom flex h-full flex-col gap-4 overflow-y-auto bg-paper p-6" data-accent="teal">
      <h1 className="pt-6 text-2xl font-bold">{t('m.pair.title')}</h1>
      <p className="text-muted">{t('m.pair.hint')}</p>
      <Field label={t('m.pin.setTitle')}>
        <input dir="ltr" type="password" inputMode="numeric" maxLength={6} className={`${inputClass} text-center text-xl tracking-[0.4em]`} placeholder="••••" value={pin} onChange={(e) => setPinText(e.target.value.replace(/\D/g, ''))} />
      </Field>
      <p className="-mt-2 text-xs text-muted">{t('m.pin.setHint')}</p>
      <Button variant="primary" icon={ScanLine} className="min-h-[64px] text-lg" disabled={busy} onClick={() => void scan()}>
        {t('m.pair.scan')}
      </Button>
      {busy && (
        <div className="flex items-center justify-center gap-2 text-muted">
          <Loader2 className="h-5 w-5 animate-spin" /> {t('m.pair.searching')}
        </div>
      )}
      {error && <div className="rounded-xl bg-danger/15 p-3 text-danger">{error}</div>}

      {!manual ? (
        <Button icon={Keyboard} onClick={() => setManual(true)}>
          {t('m.pair.orManual')}
        </Button>
      ) : (
        <div className="space-y-3">
          <Field label={t('m.pair.address')}>
            <input dir="ltr" className={inputClass} inputMode="decimal" placeholder={t('m.pair.addressHint')} value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label={t('m.pair.port')}>
            <input dir="ltr" className={inputClass} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label={t('m.pair.code')}>
            <input dir="ltr" className={`${inputClass} mono text-2xl tracking-[0.3em]`} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={t('m.pair.deviceName')}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {t('m.pair.connect')}
          </Button>
        </div>
      )}

      {!away ? (
        <Button icon={Globe} onClick={() => setAway(true)}>
          {t('m.pair.remoteOpen')}
        </Button>
      ) : (
        <div className="space-y-3">
          <p className="text-muted">{t('m.pair.remoteHint')}</p>
          <Field label={t('m.pair.remoteCode')}>
            <input dir="ltr" autoCapitalize="characters" autoCorrect="off" className={`${inputClass} mono text-xl uppercase tracking-widest`} value={remoteCode} onChange={(e) => setRemoteCode(e.target.value)} />
          </Field>
          <Field label={t('m.pair.deviceName')}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void submitRemote()}>
            {t('m.pair.connect')}
          </Button>
        </div>
      )}
    </div>
  );
}
