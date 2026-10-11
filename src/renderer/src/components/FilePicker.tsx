// A button that opens the native file dialog, with the chosen file's name next to it.
import { Paperclip, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { baseName, pickFile } from '@/lib/files';
import { Button } from './ui';

export function FilePicker({ value, onChange, extensions, label }: { value: string | null; onChange: (path: string | null) => void; extensions: string[]; label?: string }) {
  const { t } = useTranslation();
  const choose = async (): Promise<void> => {
    const path = await pickFile(label ?? t('common.chooseFile'), extensions);
    if (path) onChange(path);
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button icon={Paperclip} onClick={() => void choose()}>
        {label ?? t('common.chooseFile')}
      </Button>
      <span className="min-w-0 truncate text-sm text-muted" dir="ltr">
        {value ? baseName(value) : t('common.noFile')}
      </span>
      {value && <Button variant="ghost" icon={X} onClick={() => onChange(null)} aria-label={t('common.remove')} />}
    </div>
  );
}
