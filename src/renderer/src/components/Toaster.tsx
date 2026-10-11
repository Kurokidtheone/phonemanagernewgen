import { CircleAlert, CircleCheck } from 'lucide-react';
import { useToasts } from '@/lib/toast';

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed start-6 top-5 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-start text-sm font-semibold shadow-lg ${
            t.kind === 'ok' ? 'border-ok/50 text-ok' : 'border-danger/50 text-danger'
          }`}
        >
          {t.kind === 'ok' ? <CircleCheck size={17} className="mt-0.5 shrink-0" /> : <CircleAlert size={17} className="mt-0.5 shrink-0" />}
          {t.text}
        </button>
      ))}
    </div>
  );
}
