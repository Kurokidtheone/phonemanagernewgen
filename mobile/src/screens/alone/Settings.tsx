// All of Settings, in sections on one scrolling screen: identity, language, appearance, manager password, protected
// sections, sales rules, backup, license and system. The core validates every value.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '@shared/app.config';
import { ScreenHeader } from '@/components/common';
import { Button, Field, Row, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { chooseLanguage, moveToShopPc } from '@/lib/connection';
import { applyTheme } from '@/lib/theme';
import { applyLanguage } from '@/i18n';
import { Panel, useDo } from './kit';

const NAMES: Record<Language, string> = { ar: 'العربية', fr: 'Français', en: 'English' };
const PROTECTABLE = ['sell', 'stock', 'repairs', 'people', 'finance', 'settings'] as const;

export function SettingsScreen({ onBack, open }: { onBack: () => void; open: (page: 'backup' | 'license') => void }) {
  const { t, i18n } = useTranslation();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('settings.get') });
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api('auth.status') });
  const info = useQuery({ queryKey: ['system'], queryFn: () => api('system.info') });
  const s = settings.data;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const value = <K extends string>(key: K, fallback: unknown): unknown => (key in draft ? draft[key] : fallback);
  const save = useDo((patch: Record<string, unknown>) => api('settings.update', patch as never), { success: t('common.saved'), onDone: () => setDraft({}) });
  const text = (key: string, label: string, current: string) => (
    <Field label={label}>
      <input className={inputClass} value={String(value(key, current))} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </Field>
  );
  const num = (key: string, label: string, current: number) => (
    <Field label={label}>
      <input dir="ltr" inputMode="numeric" className={inputClass} value={String(value(key, current))} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value.replace(/\D/g, '')) })} />
    </Field>
  );
  const check = (key: string, label: string, current: boolean) => (
    <label className="flex items-center gap-2 py-1">
      <input type="checkbox" checked={Boolean(value(key, current))} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} /> {label}
    </label>
  );
  const dirty = Object.keys(draft).length > 0;
  const saveButton = (
    <Button variant="primary" className="mt-3 w-full" disabled={!dirty} busy={save.isPending} onClick={() => save.mutate(draft)}>
      {t('common.save')}
    </Button>
  );

  return (
    <div className="flex h-full flex-col" data-accent="olive">
      <ScreenHeader title={t('m.alone.settings')} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        {s && (
          <>
            <Panel title={t('m.alone.identity')}>
              {text('storeName', t('m.alone.identity'), s.storeName)}
              {text('ownerName', t('m.alone.owner'), s.ownerName)}
              {text('phone', t('m.alone.phone'), s.phone)}
              {text('address', t('m.alone.address'), s.address)}
              {saveButton}
            </Panel>

            <Panel title={t('m.alone.language')}>
              <div className="flex gap-2">
                {LANGUAGES.map((l) => (
                  <Button
                    key={l}
                    variant={i18n.language === l ? 'primary' : 'default'}
                    className="flex-1"
                    onClick={() => {
                      applyLanguage(l);
                      void chooseLanguage(l);
                      save.mutate({ language: l });
                    }}
                  >
                    {NAMES[l]}
                  </Button>
                ))}
              </div>
            </Panel>

            <Panel title={t('m.alone.theme')}>
              <div className="flex gap-2">
                {(['system', 'light', 'dark'] as const).map((th) => (
                  <Button
                    key={th}
                    variant={s.theme === th ? 'primary' : 'default'}
                    className="flex-1"
                    onClick={() => {
                      applyTheme(th);
                      save.mutate({ theme: th });
                    }}
                  >
                    {t(`m.alone.theme_${th}`)}
                  </Button>
                ))}
              </div>
            </Panel>

            <Panel title={t('m.alone.salesRules')}>
              {check('allowNegativeStock', t('m.alone.allowNegative'), s.allowNegativeStock)}
              {check('askSeller', t('m.alone.askSeller'), s.askSeller)}
              {check('hideCostWhenLocked', t('m.alone.hideCost'), s.hideCostWhenLocked)}
              {num('debtDueDays', t('m.alone.debtDays'), s.debtDueDays)}
              {num('warrantyNewDays', t('m.alone.warrantyNew'), s.warrantyNewDays)}
              {num('warrantyUsedDays', t('m.alone.warrantyUsed'), s.warrantyUsedDays)}
              {num('warrantyAccessoryDays', t('m.alone.warrantyAccessory'), s.warrantyAccessoryDays)}
              {text('receiptFooter', t('m.alone.receiptFooter'), s.receiptFooter)}
              {text('repairTerms', t('m.alone.repairTerms'), s.repairTerms)}
              {saveButton}
            </Panel>
          </>
        )}

        {auth.data && <Security status={auth.data} />}

        <Panel>
          <Row title={t('m.alone.backup')} onClick={() => open('backup')} />
          <Row title={t('m.alone.license')} onClick={() => open('license')} />
        </Panel>

        <Panel title={t('m.alone.system')}>
          {info.data && (
            <>
              <Row title={t('m.more.version')} right={<span dir="ltr">v{info.data.version}</span>} />
              <Row title={t('m.alone.schema')} right={<span dir="ltr">{info.data.schemaVersion}</span>} />
            </>
          )}
          <MoveToPc />
        </Panel>
      </div>
    </div>
  );
}

/** Manager password, recovery code and which sections it protects: the desktop's rules. */
function Security({ status }: { status: { hasPassword: boolean; unlocked: boolean; protectedSections: string[] } }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [current, setCurrent] = useState('');
  const [recovery, setRecovery] = useState('');
  const set = useDo(() => api('auth.setPassword', { password }), { onDone: (r) => (setRecovery(r.recoveryCode), setPassword(''), setAgain('')) });
  const change = useDo(() => api('auth.change', { current, next: password }), { success: t('common.saved'), onDone: () => (setCurrent(''), setPassword(''), setAgain('')) });
  const remove = useDo(() => api('auth.remove', { current }), { success: t('common.saved'), onDone: () => setCurrent('') });
  const lock = useDo(() => api('auth.lock'), {});
  const protect = useDo((sections: string[]) => api('auth.setProtected', { sections: sections as never }), { success: t('common.saved') });
  const pw = (v: string, on: (s: string) => void, label: string) => (
    <Field label={label}>
      <input type="password" className={inputClass} value={v} onChange={(e) => on(e.target.value)} />
    </Field>
  );
  const mismatch = password.length > 0 && password !== again;
  return (
    <Panel title={t('m.alone.security')}>
      {recovery && (
        <div className="mb-3 rounded-2xl bg-accent-soft p-3">
          <div className="text-sm">{t('lock.recoveryCode')}</div>
          <div dir="ltr" className="mono text-xl font-semibold">
            {recovery}
          </div>
          <div className="text-xs text-muted">{t('m.alone.recoveryHint')}</div>
        </div>
      )}
      {!status.hasPassword ? (
        <>
          {pw(password, setPassword, t('lock.password'))}
          {pw(again, setAgain, t('m.alone.repeatPassword'))}
          {mismatch && <p className="text-sm text-danger">{t('m.pin.mismatch')}</p>}
          <Button variant="primary" className="mt-2 w-full" busy={set.isPending} disabled={password.length < 4 || mismatch || !again} onClick={() => set.mutate(undefined)}>
            {t('m.alone.setPassword')}
          </Button>
        </>
      ) : (
        <>
          {pw(current, setCurrent, t('m.alone.currentPassword'))}
          {pw(password, setPassword, t('m.alone.newPassword'))}
          {pw(again, setAgain, t('m.alone.repeatPassword'))}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" className="flex-1" busy={change.isPending} disabled={!current || password.length < 4 || mismatch || !again} onClick={() => change.mutate(undefined)}>
              {t('m.alone.changePassword')}
            </Button>
            <Button variant="danger" className="flex-1" busy={remove.isPending} disabled={!current} onClick={() => remove.mutate(undefined)}>
              {t('common.remove')}
            </Button>
          </div>
          <Button className="mt-2 w-full" onClick={() => lock.mutate(undefined)}>
            {t('lock.now')}
          </Button>
          <h4 className="mb-1 mt-4 font-medium">{t('lock.sections')}</h4>
          {PROTECTABLE.map((id) => (
            <label key={id} className="flex items-center gap-2 py-1">
              <input type="checkbox" checked={status.protectedSections.includes(id)} onChange={(e) => protect.mutate(e.target.checked ? [...status.protectedSections, id] : status.protectedSections.filter((x) => x !== id))} /> {t(`sections.${id}`)}
            </label>
          ))}
        </>
      )}
    </Panel>
  );
}

/** Settings > "Move to a shop PC": three steps, then the phone's own data is erased and the app asks to pair. */
function MoveToPc() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  return step === 0 ? (
    <Button className="mt-3 w-full" onClick={() => setStep(1)}>
      {t('m.alone.moveTitle')}
    </Button>
  ) : (
    <div className="mt-3 space-y-2 rounded-2xl bg-accent-soft p-3 text-sm">
      <div className="font-semibold">{t('m.alone.moveTitle')}</div>
      <ol className="list-decimal space-y-1 ps-5">
        <li>{t('m.alone.moveStep1')}</li>
        <li>{t('m.alone.moveStep2')}</li>
        <li>{t('m.alone.moveStep3')}</li>
      </ol>
      <p className="text-danger">{t('m.alone.moveWarn')}</p>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => setStep(0)}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" className="flex-1" onClick={() => void moveToShopPc()}>
          {t('m.alone.moveConfirm')}
        </Button>
      </div>
    </div>
  );
}
