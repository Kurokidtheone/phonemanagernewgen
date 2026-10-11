import clsx from 'clsx';
import { Loader2, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode, type TouchEvent } from 'react';

/** 48 px minimum touch target. */
export function Button({ variant = 'default', icon: Icon, busy, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger'; icon?: LucideIcon; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        'flex min-h-touch items-center justify-center gap-2 rounded-full border px-5 text-base font-medium transition active:scale-[0.98] active:opacity-80 disabled:opacity-50',
        variant === 'primary' && 'border-transparent bg-action text-[color:var(--on-action)]',
        variant === 'danger' && 'border-transparent bg-danger text-white',
        variant === 'default' && 'border-transparent bg-accent-soft text-ink',
        className,
      )}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : Icon && <Icon className="h-5 w-5" />}
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = 'input min-h-touch text-base';

export function Row({ title, subtitle, right, onClick }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="min-w-0 flex-1 text-start">
        <div className="truncate font-medium">{title}</div>
        {subtitle && <div className="truncate text-sm text-muted">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0 text-end">{right}</div>}
    </>
  );
  const cls = 'flex min-h-[60px] w-full items-center gap-3 border-b border-line/50 px-5 py-2';
  return onClick ? (
    <button className={clsx(cls, 'transition-colors active:bg-accent-faint')} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'danger' | 'accent'; children: ReactNode }) {
  return (
    <span className={clsx('inline-block rounded-full px-2.5 py-0.5 text-xs font-medium', tone === 'ok' && 'bg-ok/15 text-ok', tone === 'danger' && 'bg-danger/15 text-danger', tone === 'accent' && 'bg-accent-soft text-accent', tone === 'neutral' && 'bg-line text-muted')}>
      {children}
    </span>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-6 py-12 text-center text-muted">{children}</div>;

/** Pull down at the top of a list to refresh it. */
export function Refreshable({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  const down = (e: TouchEvent): void => {
    start.current = box.current && box.current.scrollTop <= 0 ? e.touches[0].clientY : null;
  };
  const move = (e: TouchEvent): void => {
    if (start.current === null || busy) return;
    const dy = e.touches[0].clientY - start.current;
    setPull(dy > 0 ? Math.min(dy / 2, 80) : 0);
  };
  const up = async (): Promise<void> => {
    const triggered = pull >= 60;
    start.current = null;
    setPull(0);
    if (!triggered) return;
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={box} className="h-full overflow-y-auto" onTouchStart={down} onTouchMove={move} onTouchEnd={() => void up()}>
      <div className="flex items-center justify-center overflow-hidden text-muted transition-[height]" style={{ height: busy ? 40 : pull }}>
        <Loader2 className={clsx('h-5 w-5', busy && 'animate-spin')} />
      </div>
      {children}
    </div>
  );
}
