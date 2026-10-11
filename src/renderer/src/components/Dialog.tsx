import { X } from 'lucide-react';
import { useEffect, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

/** Modal dialog. Esc closes it. If onSubmit is given, Enter submits and the footer shows the buttons. */
export function Dialog({ title, hint, onClose, onSubmit, submitLabel, submitVariant = 'primary', busy, wide, children }: {
  title: string;
  hint?: string;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitVariant?: 'primary' | 'danger';
  busy?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    e.stopPropagation(); // a dialog opened from inside another must not submit it too
    if (!busy) onSubmit?.();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-card p-6 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{title}</h2>
            {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-md p-1 text-muted hover:bg-paper">
            <X size={18} />
          </button>
        </header>
        <div className="space-y-4">{children}</div>
        {onSubmit && (
          <footer className="mt-6 flex gap-2">
            <Button type="submit" variant={submitVariant} disabled={busy}>
              {submitLabel ?? t('common.save')}
            </Button>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
          </footer>
        )}
      </form>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose, busy }: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog title={title} onClose={onClose} onSubmit={onConfirm} submitLabel={confirmLabel} submitVariant="danger" busy={busy}>
      <p className="text-sm text-muted">{body}</p>
    </Dialog>
  );
}
