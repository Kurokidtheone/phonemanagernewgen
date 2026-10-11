import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney, toCentimes } from '@shared/money';
import type { Language } from '@shared/app.config';
import { Button, inputClass } from './ui';

export function ScreenHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line bg-paper p-2">
      {onBack && (
        <button className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl active:bg-accent-faint" onClick={onBack} aria-label="back">
          <ArrowLeft className="h-6 w-6 rtl:rotate-180" />
        </button>
      )}
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
      {right}
    </div>
  );
}

/** An amount in dinars typed as text; reports centimes (null while empty or not a number). */
export function MoneyField({ value, onChange, placeholder }: { value: number | null; onChange: (centimes: number | null) => void; placeholder?: string }) {
  const [text, setText] = useState(value === null ? '' : String(value / 100));
  useEffect(() => {
    // Follow outside changes (a new default), not the user's own typing.
    if (toCentimes(text) !== value) setText(value === null ? '' : String(value / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      dir="ltr"
      className={inputClass}
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === '' ? null : toCentimes(e.target.value));
      }}
    />
  );
}

export function useFormatMoney(): (centimes: number) => string {
  const { i18n } = useTranslation();
  return (c) => formatMoney(c, i18n.language as Language);
}

/** A panel over the screen with its own buttons. */
export function Sheet({ title, children, onClose, closeLabel }: { title: string; children: ReactNode; onClose: () => void; closeLabel?: string }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={onClose}>
      <div className="safe-bottom max-h-[85%] w-full overflow-y-auto rounded-t-3xl bg-card p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold">{title}</h3>
        {children}
        {closeLabel && (
          <Button className="mt-3 w-full" onClick={onClose}>
            {closeLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
