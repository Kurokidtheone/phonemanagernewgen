import { LANGUAGES, type Language } from '@shared/app.config';
import { App as CapApp } from '@capacitor/app';
import { ArrowLeft, Info, Printer, ScanLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row } from '@/components/ui';
import { chooseLanguage, forget, useConnection } from '@/lib/connection';
import { applyLanguage } from '@/i18n';
import { useSync } from '@/sync/runtime';
import { About } from '@/components/About';
import { NotSent } from './NotSent';
import { PrinterScreen } from './Printer';

const NAMES: Record<Language, string> = { ar: 'العربية', fr: 'Français', en: 'English' };

export function More() {
  const { t, i18n } = useTranslation();
  const { session, role } = useConnection();
  const sync = useSync();
  const [confirm, setConfirm] = useState(false);
  const [sent, setSent] = useState(false);
  const [version, setVersion] = useState('');
  const [printer, setPrinter] = useState(false);
  useEffect(() => {
    void CapApp.getInfo().then((info) => setVersion(`v${info.version}`)).catch(() => undefined);
  }, []);
  if (printer) return <PrinterScreen onBack={() => setPrinter(false)} />;
  if (sent)
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 p-2">
          <button className="flex h-12 w-12 items-center justify-center rounded-xl active:bg-accent-faint" onClick={() => setSent(false)} aria-label="back">
            <ArrowLeft className="h-6 w-6 rtl:rotate-180" />
          </button>
          <h2 className="text-lg font-semibold">{t('m.sync.row')}</h2>
        </div>
        <div className="min-h-0 flex-1">
          <NotSent />
        </div>
      </div>
    );
  return (
    <div className="h-full overflow-y-auto" data-accent="olive">
      <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.more.device')}</h3>
      <Row title={session?.deviceName ?? ''} subtitle={role ? t(`settings.mobile.roles.${role}`) : ''} />

      <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.more.language')}</h3>
      <div className="flex gap-2 px-4 py-2">
        {LANGUAGES.map((l) => (
          <Button
            key={l}
            variant={i18n.language === l ? 'primary' : 'default'}
            className="flex-1"
            onClick={() => {
              applyLanguage(l);
              void chooseLanguage(l);
            }}
          >
            {NAMES[l]}
          </Button>
        ))}
      </div>

      <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.more.connection')}</h3>
      <Row title={t('m.more.store')} right={session?.storeName} />
      {sync.ready && (
        <Row
          title={t('m.sync.row')}
          subtitle={sync.notSent > 0 ? t('m.sync.rowNotSent', { n: sync.notSent }) : sync.pending > 0 ? t('m.sync.rowWaiting', { n: sync.pending }) : t('m.sync.rowAllSent')}
          right={sync.notSent > 0 ? <span className="text-danger">!</span> : undefined}
          onClick={() => setSent(true)}
        />
      )}
      <Row title={t('m.more.address')} right={<span dir="ltr">{session?.host ? `${session.host}:${session.port}` : ''}</span>} />

      <Row title={<span className="flex items-center gap-3"><Printer className="h-5 w-5 text-accent" /> {t('m.printer.title')}</span>} onClick={() => setPrinter(true)} />

      <h3 className="px-4 pb-1 pt-4 font-semibold">{t('m.more.about')}</h3>
      <Row title={t('m.more.version')} right={<span dir="ltr">{version}</span>} />

      <About />

      <div className="p-4">
        {confirm ? (
          <div className="space-y-3 rounded-2xl border border-line bg-card p-4">
            <div className="flex items-center gap-2 font-semibold">
              <Info className="h-5 w-5" /> {t('m.more.pairAgainTitle')}
            </div>
            <p className="text-muted">{t('m.more.pairAgainBody')}</p>
            {sync.pending > 0 && <p className="font-medium text-danger">{t('m.more.pairAgainWaiting', { n: sync.pending })}</p>}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setConfirm(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" className="flex-1" onClick={() => void forget()}>
                {t('m.more.pairAgain')}
              </Button>
            </div>
          </div>
        ) : (
          <Button icon={ScanLine} className="w-full" onClick={() => setConfirm(true)}>
            {t('m.more.pairAgain')}
          </Button>
        )}
      </div>
    </div>
  );
}
