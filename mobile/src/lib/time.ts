/** "2 hours ago", in the app's language. */
export function ago(iso: string | null, lang: string, never: string): string {
  if (!iso) return never;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang, { numeric: 'auto' });
  if (minutes < 1) return rtf.format(0, 'minute');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / (60 * 24)), 'day');
}
