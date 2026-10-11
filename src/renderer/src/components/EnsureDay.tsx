import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Field, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';

/** Ask for the opening float and open the day. `lastCounted` prefills it. */
export function OpenDayDialog({ lastCounted, onClose, onOpened }: { lastCounted: number; onClose: () => void; onOpened?: () => void }) {
  const { t } = useTranslation();
  const [float, setFloat] = useState<number | null>(lastCounted);
  const save = useAction(() => api('cash.open', { openingFloat: float ?? 0 }), {
    success: t('cash.opened'),
    invalidate: [['cash']],
    onDone: () => {
      onClose();
      onOpened?.();
    },
  });
  return (
    <Dialog title={t('cash.openTitle')} hint={t('cash.openHint')} onClose={onClose} onSubmit={() => save.mutate(undefined)} submitLabel={t('cash.openConfirm')} busy={save.isPending || float === null}>
      <Field label={t('cash.openingFloat')} required>
        <MoneyInput autoFocus value={float} onChange={setFloat} />
      </Field>
    </Dialog>
  );
}

/**
 * Selling needs an open cash day. `ensure(action)` runs the action now when the day is open;
 * otherwise it asks for the opening float first and runs the action once the day is open.
 */
export function useEnsureDay(): { ensure: (action: () => void) => void; dialog: ReactNode } {
  const client = useQueryClient();
  const [pending, setPending] = useState<{ action: () => void; lastCounted: number } | null>(null);

  const ensure = (action: () => void): void => {
    void client
      .fetchQuery({ queryKey: ['cash', 'state'], queryFn: () => api('cash.state'), staleTime: 0 })
      .then((state) => (state.open ? action() : setPending({ action, lastCounted: state.lastCounted })));
  };
  const dialog = pending ? <OpenDayDialog lastCounted={pending.lastCounted} onClose={() => setPending(null)} onOpened={pending.action} /> : null;
  return { ensure, dialog };
}
