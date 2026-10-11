import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Outside the shop, when the owner has not allowed changes: a short note instead of actions that would fail. */
export function ViewOnlyNote() {
  const { t } = useTranslation();
  return (
    <div className="m-3 flex items-center gap-2 rounded-xl bg-accent-soft p-3 text-sm">
      <Eye className="h-5 w-5 shrink-0 text-accent" />
      {t('m.remote.viewOnly')}
    </div>
  );
}
