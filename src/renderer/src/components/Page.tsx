import clsx from 'clsx';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Icon box + title + one-line subtitle, with an optional back link and primary action. */
export function PageHeader({ icon: Icon, title, subtitle, back, action }: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  back?: { to: string; label: string };
  action?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {back && (
        <Link to={back.to} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
          <ArrowRight size={15} className="ltr:rotate-180" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
            <Icon size={22} aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-accent">{title}</h1>
            {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
    </header>
  );
}

/** Chip-style sub navigation inside a section. */
export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="mb-5 flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={clsx(
            'rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition',
            tab.id === value ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function PageBody({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={clsx('mx-auto w-full px-8 py-7', narrow ? 'max-w-3xl' : 'max-w-6xl')}>{children}</div>;
}
