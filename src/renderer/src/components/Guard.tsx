import { KeyRound, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SectionId } from '@shared/app.config';
import { api } from '@/lib/api';
import { useAction, useAuth } from '@/lib/hooks';
import { RecoveryCodeDialog } from './RecoveryCodeDialog';
import { Button, Card, Field, Input, Skeleton } from './ui';

/** Wrap a section's page: shows the password screen while that section is locked. */
export function Guard({ section, children }: { section: SectionId; children: ReactNode }) {
  const auth = useAuth();
  if (!auth.data) return <Skeleton className="m-8 h-40" />;
  const locked = auth.data.hasPassword && !auth.data.unlocked && auth.data.protectedSections.includes(section);
  return locked ? <UnlockScreen /> : <>{children}</>;
}

function UnlockScreen() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [forgot, setForgot] = useState(false);
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [newCode, setNewCode] = useState<string | null>(null);

  const unlock = useAction((p: string) => api('auth.unlock', { password: p }), { invalidate: [['auth']] });
  const reset = useAction((input: { code: string; next: string }) => api('auth.reset', input), {
    onDone: (r) => setNewCode(r.recoveryCode),
  });

  return (
    <div className="grid h-full place-items-center p-8">
      <Card className="w-full max-w-sm">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent">
            <Lock size={20} />
          </span>
          <div>
            <h1 className="text-lg font-bold">{t('lock.title')}</h1>
            <p className="text-sm text-muted">{t('lock.hint')}</p>
          </div>
        </div>
        {!forgot ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              unlock.mutate(password);
            }}
          >
            <Field label={t('lock.password')}>
              <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <div className="flex items-center justify-between">
              <Button type="submit" variant="primary" icon={KeyRound} disabled={!password || unlock.isPending}>
                {t('lock.open')}
              </Button>
              <button type="button" className="text-sm font-semibold text-muted underline" onClick={() => setForgot(true)}>
                {t('lock.forgot')}
              </button>
            </div>
          </form>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              reset.mutate({ code, next });
            }}
          >
            <Field label={t('lock.recoveryCode')}>
              <Input className="mono" dir="ltr" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" />
            </Field>
            <Field label={t('settings.security.newPassword')}>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!code || next.length < 4 || reset.isPending}>
                {t('lock.reset')}
              </Button>
              <Button onClick={() => setForgot(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        )}
      </Card>
      {newCode && <RecoveryCodeDialog code={newCode} />}
    </div>
  );
}
