import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '@shared/app.config';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api, errorText, ApiError } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { toast } from '@/lib/toast';

const LANGUAGE_NAMES: Record<Language, string> = { ar: 'العربية', fr: 'Français', en: 'English' };
const STEPS = ['language', 'identity', 'stock', 'cash'] as const;

/**
 * First launch: language, store identity, how to start the stock (empty or demo data) and the
 * opening cash float. Shown until finished or skipped; everything can be changed later in Settings.
 */
export function SetupWizard({ language }: { language: Language }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState({ storeName: '', ownerName: '', phone: '', address: '' });
  const [demo, setDemo] = useState(false);
  const [float, setFloat] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof identity) => (e: { target: { value: string } }) => setIdentity((s) => ({ ...s, [key]: e.target.value }));

  const refresh = (): void => void client.invalidateQueries();
  const chooseLanguage = async (lang: Language): Promise<void> => {
    await api('settings.update', { language: lang });
    refresh();
  };

  const finish = async (skip: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (!skip) {
        await api('settings.update', identity);
        if (demo) {
          try {
            await api('seed.load');
          } catch (err) {
            if (!(err instanceof ApiError && err.code === 'seed_not_empty')) throw err; // data already there: keep it
          }
        }
        // The day is opened with the cash counted in the drawer.
        await api('cash.open', { openingFloat: float ?? 0 }).catch((err) => {
          if (!(err instanceof ApiError && err.code === 'session_already_open')) throw err;
        });
      }
      await api('settings.update', { setupDone: true });
      // A new database: a cart left in the window by an earlier one would point at records that do not exist.
      useCart.getState().reset();
      refresh();
      if (!skip) toast.ok(t('wizard.done'));
    } catch (err) {
      toast.error(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-paper p-6" role="dialog" aria-modal="true" aria-label={t('wizard.title')}>
      <div className="w-full max-w-xl rounded-2xl border border-line bg-card p-8 shadow-xl">
        <header className="mb-6">
          <p className="text-sm font-semibold text-accent">{t('wizard.step', { n: step + 1, total: STEPS.length })}</p>
          <h1 className="text-2xl font-bold">{t(`wizard.${STEPS[step]}.title`)}</h1>
          <p className="mt-1 text-sm text-muted">{t(`wizard.${STEPS[step]}.hint`)}</p>
        </header>

        {step === 0 && (
          <div className="grid gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => void chooseLanguage(l)}
                className={`flex items-center justify-between rounded-xl border px-4 py-3 text-lg font-semibold ${language === l ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-paper'}`}
              >
                {LANGUAGE_NAMES[l]}
                {language === l && <Check size={18} aria-hidden />}
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.identity.storeName')}>
              <Input autoFocus value={identity.storeName} onChange={set('storeName')} />
            </Field>
            <Field label={t('settings.identity.ownerName')}>
              <Input value={identity.ownerName} onChange={set('ownerName')} />
            </Field>
            <Field label={t('settings.identity.phone')}>
              <Input dir="ltr" value={identity.phone} onChange={set('phone')} />
            </Field>
            <Field label={t('settings.identity.address')}>
              <Input value={identity.address} onChange={set('address')} />
            </Field>
          </div>
        )}
        {step === 2 && (
          <div className="grid gap-3">
            {([false, true] as const).map((choice) => (
              <label key={String(choice)} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${demo === choice ? 'border-accent bg-accent-soft' : 'border-line hover:bg-paper'}`}>
                <input type="radio" name="stock" className="mt-1" checked={demo === choice} onChange={() => setDemo(choice)} />
                <span>
                  <span className="block font-semibold">{t(choice ? 'wizard.stock.demo' : 'wizard.stock.empty')}</span>
                  <span className="text-sm text-muted">{t(choice ? 'wizard.stock.demoHint' : 'wizard.stock.emptyHint')}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {step === 3 && (
          <Field label={t('cash.openingFloat')}>
            <MoneyInput autoFocus value={float} onChange={setFloat} />
          </Field>
        )}

        <footer className="mt-8 flex items-center gap-2">
          <Button disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
            {t('wizard.back')}
          </Button>
          {last ? (
            <Button variant="primary" disabled={busy} onClick={() => void finish(false)}>
              {t('wizard.finish')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => setStep(step + 1)}>
              {t('wizard.next')}
            </Button>
          )}
          <Button variant="ghost" className="ms-auto" disabled={busy} onClick={() => void finish(true)}>
            {t('wizard.skip')}
          </Button>
        </footer>
      </div>
    </div>
  );
}
