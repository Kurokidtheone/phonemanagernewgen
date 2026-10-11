import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Database, DatabaseBackup, Download, FolderOpen, Info, KeyRound, Languages, Lock, Monitor, Moon, Palette, Save, Printer, Settings as SettingsIcon, ShieldCheck, ShoppingCart, Sun, Tags, Upload, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { APP, LANGUAGES, SECTIONS, type SectionId, type Theme } from '@shared/app.config';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { PageBody, PageHeader } from '@/components/Page';
import { MobileDevices } from '@/pages/MobileDevices';
import nextLevelLogo from '@/assets/next-level.png';
import { whatsappNumber } from '@/lib/receipt';
import { RecoveryCodeDialog } from '@/components/RecoveryCodeDialog';
import { Badge, Button, Card, Field, Input, MoneyInput, Skeleton } from '@/components/ui';
import { api, fileUrl } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useAction, useAuth, useLicense, useSettings } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { IMAGE_EXTENSIONS, pickFile } from '@/lib/files';

const LANGUAGE_NAMES = { ar: 'العربية', fr: 'Français', en: 'English' } as const;

export function Settings() {
  const { t } = useTranslation();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  return (
    <PageBody narrow>
      <PageHeader icon={SettingsIcon} title={t('sections.settings')} subtitle={t('settings.subtitle')} />
      <div className="space-y-5">
        <Identity />
        <LanguageAndTheme />
        <Printing />
        <SalesSettings />
        <ServicesSettings />
        <ExpenseCategories />
        <Security />
        <MobileDevices />
        <Backup />
        <License />
        <System />
        <SampleData />
      </div>
    </PageBody>
  );
}

function Identity() {
  const { t } = useTranslation();
  const settings = useSettings().data;
  const [form, setForm] = useState({ storeName: '', ownerName: '', phone: '', address: '' });
  useEffect(() => {
    if (settings) setForm({ storeName: settings.storeName, ownerName: settings.ownerName, phone: settings.phone, address: settings.address });
  }, [settings]);

  const save = useAction(() => api('settings.update', form), { success: t('common.saved'), invalidate: [['settings']] });
  const logo = useAction((path: string | null) => api('settings.setLogo', { path }), { success: t('common.saved'), invalidate: [['settings']] });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  if (!settings) return <Skeleton className="h-64" />;
  return (
    <div id="identity">
      <Card icon={Building2} title={t('settings.identity.title')} hint={t('settings.identity.hint')}>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.identity.storeName')}>
            <Input value={form.storeName} onChange={set('storeName')} />
          </Field>
          <Field label={t('settings.identity.ownerName')}>
            <Input value={form.ownerName} onChange={set('ownerName')} />
          </Field>
          <Field label={t('settings.identity.phone')}>
            <Input dir="ltr" value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label={t('settings.identity.address')}>
            <Input value={form.address} onChange={set('address')} />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-4">
          {settings.logoFile ? (
            <img src={fileUrl(settings.logoFile)} alt="" className="h-16 w-16 rounded-xl border border-line object-cover" />
          ) : (
            <span className="grid h-16 w-16 place-items-center rounded-xl border border-dashed border-line text-xs text-muted">{t('settings.identity.logo')}</span>
          )}
          <Button onClick={() => void pickFile(t('settings.identity.chooseLogo'), IMAGE_EXTENSIONS).then((chosen) => chosen && logo.mutate(chosen))}>
            {t('settings.identity.chooseLogo')}
          </Button>
          {settings.logoFile && (
            <Button variant="ghost" onClick={() => logo.mutate(null)}>
              {t('common.remove')}
            </Button>
          )}
        </div>
        <Button variant="primary" icon={Save} className="mt-5" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          {t('common.save')}
        </Button>
      </Card>
    </div>
  );
}

function LanguageAndTheme() {
  const { t } = useTranslation();
  const settings = useSettings().data;
  const update = useAction((patch: { language?: (typeof LANGUAGES)[number]; theme?: Theme }) => api('settings.update', patch), { invalidate: [['settings']] });
  const themes: { id: Theme; icon: typeof Sun }[] = [
    { id: 'light', icon: Sun },
    { id: 'dark', icon: Moon },
    { id: 'system', icon: Monitor },
  ];
  if (!settings) return <Skeleton className="h-40" />;
  return (
    <>
      <Card icon={Languages} title={t('settings.language.title')} hint={t('settings.language.hint')}>
        <div className="flex gap-2">
          {LANGUAGES.map((lang) => (
            <Button key={lang} variant={settings.language === lang ? 'primary' : 'quiet'} onClick={() => update.mutate({ language: lang })}>
              {LANGUAGE_NAMES[lang]}
            </Button>
          ))}
        </div>
      </Card>
      <Card icon={Palette} title={t('settings.theme.title')} hint={t('settings.theme.hint')}>
        <div className="flex gap-2">
          {themes.map((th) => (
            <Button key={th.id} icon={th.icon} variant={settings.theme === th.id ? 'primary' : 'quiet'} onClick={() => update.mutate({ theme: th.id })}>
              {t(`settings.theme.${th.id}`)}
            </Button>
          ))}
        </div>
      </Card>
    </>
  );
}

type PasswordDialog = 'set' | 'change' | 'remove' | 'recovery' | 'unlock' | null;

function Security() {
  const { t } = useTranslation();
  const auth = useAuth().data;
  const [dialog, setDialog] = useState<PasswordDialog>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const protect = useAction((sections: SectionId[]) => api('auth.setProtected', { sections }), { invalidate: [['auth']] });

  const hideCost = useSettings().data?.hideCostWhenLocked ?? true;
  const hideCostSave = useSettingsSave();

  if (!auth) return <Skeleton className="h-48" />;
  const lockable = SECTIONS.filter((s) => s.lockable);
  const toggle = (id: SectionId): void => {
    if (!auth.unlocked) return setDialog('unlock');
    const next = auth.protectedSections.includes(id) ? auth.protectedSections.filter((s) => s !== id) : [...auth.protectedSections, id];
    protect.mutate(next);
  };

  return (
    <div id="security" className="space-y-5">
      <Card icon={KeyRound} title={t('settings.security.title')} hint={t('settings.security.hint')}>
        {auth.hasPassword ? (
          <>
            <Badge tone="ok">{t('settings.security.active')}</Badge>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => setDialog('change')}>{t('settings.security.change')}</Button>
              <Button onClick={() => setDialog('recovery')}>{t('settings.security.newRecovery')}</Button>
              <Button variant="danger" onClick={() => setDialog('remove')}>
                {t('settings.security.remove')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Badge>{t('settings.security.none')}</Badge>
            <div className="mt-4">
              <Button variant="primary" icon={KeyRound} onClick={() => setDialog('set')}>
                {t('settings.security.set')}
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card icon={Lock} title={t('settings.protected.title')} hint={t('settings.protected.hint')}>
        <div className="grid grid-cols-2 gap-2">
          {lockable.map((s) => (
            <label key={s.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 font-semibold ${auth.hasPassword ? 'cursor-pointer hover:bg-paper' : 'opacity-50'}`}>
              <input type="checkbox" disabled={!auth.hasPassword || protect.isPending} checked={auth.protectedSections.includes(s.id)} onChange={() => toggle(s.id)} />
              {t(`sections.${s.id}`)}
            </label>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Info size={15} /> {auth.hasPassword ? t('settings.protected.overviewNote') : t('settings.protected.needPassword')}
        </p>
        <label className="mt-4 flex items-start gap-2 border-t border-line pt-4 text-sm font-semibold">
          <input type="checkbox" className="mt-1" checked={hideCost} onChange={(e) => hideCostSave.mutate({ hideCostWhenLocked: e.target.checked })} />
          <span>
            {t('settings.protected.hideCost')}
            <span className="block text-xs font-normal text-muted">{t('settings.protected.hideCostHint')}</span>
          </span>
        </label>
      </Card>

      {dialog && (
        <PasswordForm
          mode={dialog}
          onClose={() => setDialog(null)}
          onRecoveryCode={(code) => {
            setDialog(null);
            setRecoveryCode(code);
          }}
        />
      )}
      {recoveryCode && <RecoveryCodeDialog code={recoveryCode} onDone={() => setRecoveryCode(null)} />}
    </div>
  );
}

function PasswordForm({ mode, onClose, onRecoveryCode }: { mode: Exclude<PasswordDialog, null>; onClose: () => void; onRecoveryCode: (code: string) => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const needsCurrent = mode !== 'set';
  const needsNext = mode === 'set' || mode === 'change';

  const run = useAction(
    async (): Promise<string | null> => {
      if (mode === 'set') return (await api('auth.setPassword', { password: next })).recoveryCode;
      if (mode === 'change') await api('auth.change', { current, next });
      if (mode === 'remove') await api('auth.remove', { current });
      if (mode === 'recovery') return (await api('auth.newRecoveryCode', { current })).recoveryCode;
      if (mode === 'unlock') await api('auth.unlock', { password: current });
      return null;
    },
    {
      invalidate: [['auth']],
      onDone: (code) => {
        if (code) return onRecoveryCode(code);
        if (mode !== 'unlock') toast.ok(t('common.saved'));
        onClose();
      },
    },
  );

  const mismatch = needsNext && confirm.length > 0 && next !== confirm;
  const valid = (!needsCurrent || current.length > 0) && (!needsNext || (next.length >= 4 && next === confirm));

  return (
    <Dialog
      title={t(`settings.security.dialog.${mode}`)}
      hint={mode === 'set' ? t('settings.security.setHint') : mode === 'unlock' ? t('lock.hint') : undefined}
      onClose={onClose}
      onSubmit={() => valid && run.mutate(undefined)}
      submitLabel={t(mode === 'remove' ? 'settings.security.remove' : mode === 'unlock' ? 'lock.open' : 'common.confirm')}
      submitVariant={mode === 'remove' ? 'danger' : 'primary'}
      busy={run.isPending || !valid}
    >
      {needsCurrent && (
        <Field label={t('settings.security.currentPassword')}>
          <Input type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
      )}
      {needsNext && (
        <>
          <Field label={t('settings.security.newPassword')}>
            <Input type="password" autoFocus={!needsCurrent} value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label={t('settings.security.confirmPassword')} error={mismatch ? t('settings.security.mismatch') : undefined}>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </>
      )}
    </Dialog>
  );
}

function Backup() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const create = useAction(() => api('backup.create'), { onDone: (r) => r.saved && toast.ok(t('settings.backup.created')) });
  const restore = useAction(() => api('backup.restore'), {
    onDone: (r) => {
      setConfirming(false);
      if (r.restored) {
        // The cart lives in the window, not in the database: its lines would point at records the backup may not have.
        useCart.getState().reset();
        toast.ok(t('settings.backup.restored'));
      }
    },
  });
  return (
    <div id="backup">
      <Card icon={DatabaseBackup} title={t('settings.backup.title')} hint={t('settings.backup.hint')}>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={Download} disabled={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('settings.backup.create')}
          </Button>
          <Button icon={Upload} onClick={() => setConfirming(true)}>
            {t('settings.backup.restore')}
          </Button>
        </div>
      </Card>
      {confirming && (
        <ConfirmDialog
          title={t('settings.backup.restoreTitle')}
          body={t('settings.backup.restoreBody')}
          confirmLabel={t('settings.backup.chooseFile')}
          busy={restore.isPending}
          onConfirm={() => restore.mutate(undefined)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function License() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const license = useLicense().data;
  const [key, setKey] = useState('');
  const activate = useAction((k: string) => api('license.activate', { key: k }), {
    success: t('settings.license.activated'),
    onDone: () => {
      setKey('');
      void client.invalidateQueries({ queryKey: ['license'] });
    },
  });
  if (!license) return <Skeleton className="h-40" />;

  const badge = {
    licensed: <Badge tone="ok">{t('settings.license.stateLicensed')}</Badge>,
    trial: <Badge tone="accent">{t('license.trial', { days: license.daysLeft ?? 0 })}</Badge>,
    expired: <Badge tone="danger">{t('license.expired')}</Badge>,
    unconfigured: <Badge tone="danger">{t('settings.license.stateUnconfigured')}</Badge>,
  }[license.state];

  return (
    <div id="license">
      <Card icon={ShieldCheck} title={t('settings.license.title')} hint={t('settings.license.hint')}>
        <div className="flex flex-wrap items-center gap-3">
          {badge}
          <span className="text-sm text-muted">{t('settings.license.deviceId')}</span>
          <code className="mono rounded-md border border-line bg-paper px-2 py-1 text-sm font-bold" dir="ltr">
            {license.deviceId}
          </code>
          <Button
            variant="ghost"
            icon={Copy}
            onClick={() => {
              void navigator.clipboard.writeText(license.deviceId);
              toast.ok(t('common.copied'));
            }}
          >
            {t('common.copy')}
          </Button>
        </div>
        {license.state === 'licensed' ? (
          <p className="mt-3 text-sm text-muted">{t('settings.license.customer', { name: license.customer, date: license.issued })}</p>
        ) : (
          license.state !== 'unconfigured' && (
            <div className="mt-4 space-y-3">
              <Field label={t('settings.license.key')}>
                <textarea className="input mono min-h-[96px] text-xs" dir="ltr" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
              </Field>
              <Button variant="primary" icon={ShieldCheck} disabled={!key.trim() || activate.isPending} onClick={() => activate.mutate(key)}>
                {t('license.activate')}
              </Button>
            </div>
          )
        )}
      </Card>
    </div>
  );
}

/** An integer setting saved when the field loses focus. */
function NumberSetting({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (n: number) => void }) {
  return (
    <Field label={label}>
      <Input
        key={value}
        type="number"
        min={min}
        max={max}
        dir="ltr"
        className="w-28"
        defaultValue={value}
        onBlur={(e) => {
          const n = Math.min(max, Math.max(min, Math.floor(Number(e.target.value)) || 0));
          if (n !== value) onSave(n);
        }}
      />
    </Field>
  );
}

type SettingsPatch = Partial<{
  receiptSize: '80mm' | 'A5';
  labelSize: '40x25' | '50x30';
  receiptFooter: string;
  receiptPrinter: string;
  repairTerms: string;
  slipCopies: number;
  allowNegativeStock: boolean;
  askSeller: boolean;
  autoPrintReceipt: boolean;
  debtDueDays: number;
  warrantyNewDays: number;
  warrantyUsedDays: number;
  warrantyAccessoryDays: number;
  hideCostWhenLocked: boolean;
}>;
const useSettingsSave = () => {
  const { t } = useTranslation();
  return useAction((patch: SettingsPatch) => api('settings.update', patch), { success: t('common.saved'), invalidate: [['settings']] });
};

/** The printer that receipts and slips sent from a phone come out of, silently. */
function PrinterChoice({ current, onChange }: { current: string; onChange: (name: string) => void }) {
  const { t } = useTranslation();
  const printers = useQuery({ queryKey: ['printers'], queryFn: () => api('print.printers') }).data ?? [];
  const names = current && !printers.includes(current) ? [current, ...printers] : printers;
  return (
    <Field label={t('settings.printing.receiptPrinter')}>
      <select className="input" value={current} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('settings.printing.defaultPrinter')}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-muted">{t('settings.printing.receiptPrinterHint')}</p>
    </Field>
  );
}

/** Everything that decides what printed paper looks like. */
function Printing() {
  const { t } = useTranslation();
  const settings = useSettings().data;
  const save = useSettingsSave();
  if (!settings) return <Skeleton className="h-64" />;
  return (
    <Card icon={Printer} title={t('settings.printing.title')} hint={t('settings.printing.hint')}>
      <div className="grid grid-cols-3 gap-4">
        <Field label={t('settings.printing.receiptSize')}>
          <select className="input" value={settings.receiptSize} onChange={(e) => save.mutate({ receiptSize: e.target.value as '80mm' | 'A5' })}>
            <option value="80mm">80 mm</option>
            <option value="A5">A5</option>
          </select>
        </Field>
        <Field label={t('settings.labels.size')}>
          <select className="input" value={settings.labelSize} onChange={(e) => save.mutate({ labelSize: e.target.value as '40x25' | '50x30' })}>
            <option value="40x25">40 × 25 mm</option>
            <option value="50x30">50 × 30 mm</option>
          </select>
        </Field>
        <Field label={t('settings.printing.slipCopies')}>
          <select className="input" value={settings.slipCopies} onChange={(e) => save.mutate({ slipCopies: Number(e.target.value) })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {t(`settings.printing.copies${n}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-4 space-y-4">
        <PrinterChoice current={settings.receiptPrinter} onChange={(receiptPrinter) => save.mutate({ receiptPrinter })} />
        <Field label={t('settings.identity.receiptFooter')}>
          <textarea
            key={`f${settings.receiptFooter}`}
            className="input min-h-[64px]"
            maxLength={400}
            defaultValue={settings.receiptFooter}
            onBlur={(e) => e.target.value !== settings.receiptFooter && save.mutate({ receiptFooter: e.target.value })}
          />
        </Field>
        <Field label={t('settings.repairs.terms')}>
          <textarea
            key={`r${settings.repairTerms}`}
            className="input min-h-[64px]"
            maxLength={400}
            placeholder={t('settings.repairs.example')}
            defaultValue={settings.repairTerms}
            onBlur={(e) => e.target.value !== settings.repairTerms && save.mutate({ repairTerms: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={settings.autoPrintReceipt} onChange={(e) => save.mutate({ autoPrintReceipt: e.target.checked })} />
          {t('settings.sales.autoPrint')}
        </label>
      </div>
    </Card>
  );
}

function SalesSettings() {
  const { t } = useTranslation();
  const settings = useSettings().data;
  const save = useSettingsSave();
  if (!settings) return <Skeleton className="h-48" />;
  return (
    <Card icon={ShoppingCart} title={t('settings.sales.title')} hint={t('settings.sales.hint')}>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={settings.allowNegativeStock} onChange={(e) => save.mutate({ allowNegativeStock: e.target.checked })} />
          {t('settings.sales.negativeStock')}
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={settings.askSeller} onChange={(e) => save.mutate({ askSeller: e.target.checked })} />
          {t('settings.sales.askSeller')}
        </label>
        <div className="grid grid-cols-4 gap-4 pt-1">
          <NumberSetting label={t('settings.sales.debtDueDays')} value={settings.debtDueDays} min={0} max={3650} onSave={(n) => save.mutate({ debtDueDays: n })} />
          <NumberSetting label={t('settings.sales.warrantyNew')} value={settings.warrantyNewDays} min={0} max={3650} onSave={(n) => save.mutate({ warrantyNewDays: n })} />
          <NumberSetting label={t('settings.sales.warrantyUsed')} value={settings.warrantyUsedDays} min={0} max={3650} onSave={(n) => save.mutate({ warrantyUsedDays: n })} />
          <NumberSetting label={t('settings.sales.warrantyAccessory')} value={settings.warrantyAccessoryDays} min={0} max={3650} onSave={(n) => save.mutate({ warrantyAccessoryDays: n })} />
        </div>
        <p className="text-xs text-muted">{t('settings.sales.warrantyHint')}</p>
      </div>
    </Card>
  );
}

/** Expense categories: rename, delete (only while no expense uses them) and add. */
function ExpenseCategories() {
  const { t } = useTranslation();
  const categories = useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api('expenses.categories') }).data ?? [];
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const invalidate = [['expenses', 'categories']];
  const create = useAction(() => api('expenses.createCategory', { name }), { success: t('common.saved'), invalidate, onDone: () => setName('') });
  const rename = useAction((c: { id: string; name: string }) => api('expenses.renameCategory', c), { success: t('common.saved'), invalidate, onDone: () => setEditing(null) });
  const remove = useAction((id: string) => api('expenses.deleteCategory', { id }), { success: t('stock.catalog.deleted'), invalidate, onDone: () => setDeleting(null) });
  return (
    <Card icon={Tags} title={t('settings.expenseCategories.title')} hint={t('settings.expenseCategories.hint')}>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {categories.map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            {editing?.id === c.id ? (
              <>
                <Input
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && editing.name.trim() && rename.mutate({ id: c.id, name: editing.name.trim() })}
                />
                <Button onClick={() => editing.name.trim() && rename.mutate({ id: c.id, name: editing.name.trim() })}>{t('common.save')}</Button>
              </>
            ) : (
              <>
                <span className="flex-1 font-semibold">{c.name}</span>
                <Button variant="ghost" onClick={() => setEditing({ id: c.id, name: c.name })}>{t('stock.catalog.rename')}</Button>
                <Button variant="ghost" className="text-danger" onClick={() => setDeleting(c)}>{t('common.delete')}</Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Input value={name} placeholder={t('expenses.newCategory')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate(undefined)} />
        <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate(undefined)}>{t('common.add')}</Button>
      </div>
      {deleting && (
        <ConfirmDialog title={t('stock.catalog.deleteTitle', { name: deleting.name })} body={t('settings.expenseCategories.deleteBody')} confirmLabel={t('common.delete')} busy={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)} />
      )}
    </Card>
  );
}

/** Margin rule of each service: a percentage of the amount, or a fixed fee. Cost = amount - margin. */
function ServicesSettings() {
  const { t } = useTranslation();
  const services = useQuery({ queryKey: ['services', 'all'], queryFn: () => api('services.all') }).data ?? [];
  const [name, setName] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const create = useAction(() => api('services.create', { name, defaultPrice: price ?? 0 }), {
    success: t('services.created'),
    invalidate: [['services']],
    onDone: () => {
      setName('');
      setPrice(null);
    },
  });
  return (
    <Card icon={Zap} title={t('settings.services.title')} hint={t('settings.services.hint')}>
      <div className="space-y-3">
        {services.map((s) => (
          <ServiceRule key={s.id} service={s} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-[1fr_9rem_auto] items-end gap-2 border-t border-line pt-4">
        <Field label={t('settings.services.newName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('settings.services.defaultPrice')}>
          <MoneyInput key={name === '' ? 'reset' : 'typing'} value={price} onChange={setPrice} />
        </Field>
        <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate(undefined)}>
          {t('common.add')}
        </Button>
      </div>
    </Card>
  );
}

function ServiceRule({ service }: { service: { id: string; name: string; kind: 'FLEXY' | 'OTHER'; marginType: 'PERCENT' | 'FIXED'; marginValue: number; defaultPrice: number; active: boolean } }) {
  const { t } = useTranslation();
  const [type, setType] = useState(service.marginType);
  // Percent is typed as 3 or 2.5 (stored in hundredths); a fixed fee is an amount in DA.
  const [value, setValue] = useState(String(service.marginValue / 100));
  const [active, setActive] = useState(service.active);
  const save = useAction(
    () => {
      const typed = Number(value.replace(',', '.'));
      return api('services.update', { id: service.id, name: service.name, marginType: type, marginValue: Math.max(0, Math.round((Number.isFinite(typed) ? typed : 0) * 100)), defaultPrice: service.defaultPrice, active });
    },
    { success: t('common.saved'), invalidate: [['services']] },
  );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
      <span className="min-w-[8rem] flex-1 font-semibold">{service.name}</span>
      {service.kind === 'FLEXY' ? (
        <>
          <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label={t('settings.services.rule')}>
            <option value="PERCENT">{t('settings.services.percent')}</option>
            <option value="FIXED">{t('settings.services.fixed')}</option>
          </select>
          <Input className="w-24" dir="ltr" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('settings.services.marginValue')} />
        </>
      ) : (
        <span className="text-sm text-muted">{t('settings.services.otherHint')}</span>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {t('settings.services.active')}
      </label>
      <Button onClick={() => save.mutate(undefined)} disabled={save.isPending}>
        {t('common.save')}
      </Button>
    </div>
  );
}

function SampleData() {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const load = useAction(() => api('seed.load'), {
    success: t('settings.seed.loaded'),
    invalidate: [['system']],
    onDone: () => setAsking(false),
  });
  return (
    <Card icon={Database} title={t('settings.seed.title')} hint={t('settings.seed.hint')}>
      <Button icon={Database} onClick={() => setAsking(true)}>
        {t('settings.seed.load')}
      </Button>
      {asking && (
        <ConfirmDialog
          title={t('settings.seed.confirmTitle')}
          body={t('settings.seed.confirmBody')}
          confirmLabel={t('settings.seed.load')}
          busy={load.isPending}
          onConfirm={() => load.mutate(undefined)}
          onClose={() => setAsking(false)}
        />
      )}
    </Card>
  );
}

function System() {
  const { t } = useTranslation();
  const info = useQuery({ queryKey: ['system'], queryFn: () => api('system.info') }).data;
  const open = useAction(() => api('system.openDataFolder'));
  return (
    <Card icon={Info} title={t('settings.system.title')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted">{t('settings.system.app')}</dt>
        <dd className="font-semibold">
          {APP.name} v{info?.version}
        </dd>
        <dt className="text-muted">{t('settings.system.data')}</dt>
        <dd className="mono break-all text-xs" dir="ltr">
          {info?.dataDir}
        </dd>
      </dl>
      <Button icon={FolderOpen} className="mt-4" onClick={() => open.mutate(undefined)}>
        {t('settings.system.openFolder')}
      </Button>
      {/* Opens in the real browser: the window sends every http(s) link there. */}
      <a
        href={`https://wa.me/${whatsappNumber(APP.developer.phone)}`}
        target="_blank"
        rel="noreferrer"
        className="mt-5 flex items-center gap-4 rounded-2xl bg-[#05060f] p-3 text-[#e8e4d8] transition hover:opacity-90"
      >
        <img src={nextLevelLogo} alt="" className="h-16 w-16 shrink-0 rounded-xl" />
        <span className="min-w-0">
          <span className="block text-xs uppercase tracking-wide text-[#8f8c82]">{t('settings.system.madeBy')}</span>
          <span className="block text-base font-semibold">{APP.developer.name}</span>
          <span className="block text-sm text-[#5eead4]" dir="ltr">
            WhatsApp · {APP.developer.phone}
          </span>
        </span>
      </a>
    </Card>
  );
}
