import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLicense } from '@/lib/hooks';

/** Thin strip above the page while the app runs on a trial, or after the trial ended. */
export function LicenseBanner() {
  const { t } = useTranslation();
  const license = useLicense().data;
  if (!license || license.state === 'licensed' || license.state === 'unconfigured') return null;
  const expired = license.state === 'expired';
  return (
    <div className={`flex items-center justify-center gap-3 px-4 py-1.5 text-sm font-semibold ${expired ? 'bg-danger text-white' : 'bg-accent-soft text-ink'}`} data-accent="orange">
      <span>{expired ? t(license.reason === 'clock_changed' ? 'license.clockChanged' : 'license.expired') : t('license.trial', { days: license.daysLeft ?? 0 })}</span>
      <Link to="/settings#license" className="underline">
        {t('license.activate')}
      </Link>
    </div>
  );
}
