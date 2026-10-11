// Money is stored as an integer number of centimes. Never use floats for amounts.
import { APP, type Language } from './app.config';

/** "2400", "2 400,50", "2.400,5" or 2400.5 -> centimes. Returns null when it is not a number. */
export function toCentimes(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = input.trim().replace(/[\s\u00a0]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Both present: the last one is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  } else if (lastDot > -1 && s.length - lastDot === 4 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "2.400" typed as thousands
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** 240000 -> "2.400 دج" (or "2.400,00 دج" with decimals). */
export function formatMoney(centimes: number, lang: Language = 'ar', opts: { decimals?: boolean } = {}): string {
  const negative = centimes < 0;
  const abs = Math.abs(centimes);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = (abs % 100).toString().padStart(2, '0');
  const showCents = opts.decimals ?? abs % 100 !== 0;
  const symbol = lang === 'ar' ? APP.currency.ar : APP.currency.latin;
  return `${negative ? '-' : ''}${whole}${showCents ? ',' + cents : ''} ${symbol}`;
}

/** Split an amount by percent without losing a centime. Returns [share, rest]. */
export function splitPercent(centimes: number, percent: number): [number, number] {
  const share = Math.round((centimes * percent) / 100);
  return [share, centimes - share];
}
