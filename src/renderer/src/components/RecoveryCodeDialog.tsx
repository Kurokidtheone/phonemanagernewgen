import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

/** Shows a recovery code once. It cannot be closed until the user confirms they wrote it down. */
export function RecoveryCodeDialog({ code, onDone }: { code: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [noted, setNoted] = useState(false);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-line bg-card p-6 shadow-xl">
        <h2 className="text-xl font-bold">{t('settings.security.recoveryTitle')}</h2>
        <p className="mt-1 text-sm text-muted">{t('settings.security.recoveryHint')}</p>
        <p className="mono my-5 select-all rounded-xl border border-line bg-paper py-4 text-center text-xl font-bold tracking-wider" dir="ltr">
          {code}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={noted} onChange={(e) => setNoted(e.target.checked)} />
          {t('settings.security.recoveryNoted')}
        </label>
        <Button
          variant="primary"
          className="mt-5"
          disabled={!noted}
          onClick={() => {
            void client.invalidateQueries({ queryKey: ['auth'] });
            onDone?.();
          }}
        >
          {t('common.done')}
        </Button>
      </div>
    </div>
  );
}
