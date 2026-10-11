// Small building blocks. Everything uses CSS logical properties, so RTL and LTR both work.
import clsx from 'clsx';
import { Inbox, type LucideIcon } from 'lucide-react';
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { toCentimes } from '@shared/money';

type Variant = 'primary' | 'quiet' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-action text-white border-transparent hover:brightness-110',
  quiet: 'bg-card text-ink border-line hover:bg-paper',
  danger: 'bg-danger text-white border-transparent hover:brightness-110',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-paper',
};

export function Button({
  variant = 'quiet',
  icon: Icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: LucideIcon }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    >
      {Icon && <Icon size={16} aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ title, hint, icon: Icon, actions, children, className }: {
  title?: string;
  hint?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-2xl border border-line bg-card p-5', className)}>
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && (
              <h2 className="flex items-center gap-2 text-base font-bold">
                {Icon && <Icon size={17} className="text-muted" aria-hidden />}
                {title}
              </h2>
            )}
            {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-sm text-danger">{error}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return <input {...props} ref={ref} className={clsx('input', props.className)} />;
});

/** Text field for amounts. Reports centimes (or null while the text is not a number). */
export function MoneyInput({ value, onChange, autoFocus }: { value: number | null; onChange: (centimes: number | null) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value === null ? '' : String(value / 100));
  return (
    <input
      className="input mono"
      inputMode="decimal"
      dir="ltr"
      autoFocus={autoFocus}
      value={text}
      placeholder="0"
      onChange={(e) => {
        setText(e.target.value);
        onChange(toCentimes(e.target.value));
      }}
    />
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'danger' | 'accent'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-paper text-muted border-line',
    ok: 'border-ok/40 text-ok bg-ok/10',
    danger: 'border-danger/40 text-danger bg-danger/10',
    accent: 'border-accent/40 text-accent bg-accent-soft',
  };
  return <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold', tones[tone])}>{children}</span>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Inbox size={28} className="text-muted" aria-hidden />
      <p className="font-semibold">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-xl bg-line/60', className)} />;
}

export function StatCard({ label, value, hint, icon: Icon, onClick }: { label: string; value: ReactNode; hint?: string; icon?: LucideIcon; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={clsx('flex w-full items-start gap-3 rounded-2xl border border-line bg-card p-4 text-start', onClick && 'transition hover:border-accent')}
    >
      {Icon && (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-muted">{label}</span>
        <span className="block text-2xl font-bold text-accent">{value}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </Tag>
  );
}
