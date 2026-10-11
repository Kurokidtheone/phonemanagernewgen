import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Badge, Button, Skeleton } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAction, useMoney } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { pickFile } from '@/lib/files';

/**
 * Import accessories from an Excel file: choose the file, read the preview (every row checked, the
 * errors named), then import the valid rows. The error report can be saved as an Excel file.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const [path, setPath] = useState<string | null>(null);
  const preview = useQuery({ queryKey: ['import', 'preview', path], queryFn: () => api('import.itemsPreview', { path: path! }), enabled: !!path, retry: false });
  const data = preview.data;

  const run = useAction(() => api('import.itemsCommit', { path: path! }), {
    success: t('import.done'),
    invalidate: [['items'], ['categories']],
    onDone: onClose,
  });
  const template = async (): Promise<void> => {
    try {
      const result = await api('import.template');
      if (result.saved) toast.ok(t('import.templateSaved'));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };
  const errorReport = async (): Promise<void> => {
    if (!data) return;
    const rows = data.rows.filter((r) => r.errors.length > 0).map((r) => [r.line, r.name, r.category, r.barcode, r.quantity, r.cost / 100, r.price / 100, r.errors.map((e) => t(`import.errors.${e}`)).join('; ')]);
    try {
      const result = await api('file.exportXlsx', { title: t('import.errorReport'), headers: [t('import.line'), t('stock.items.name'), t('stock.items.category'), t('stock.items.barcode'), t('stock.items.quantity'), t('stock.items.cost'), t('stock.items.price'), t('import.problem')], rows, moneyColumns: [5, 6] });
      if (result.saved) toast.ok(t('analytics.exported'));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  return (
    <Dialog wide title={t('import.title')} hint={t('import.hint')} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-3">
        <Button icon={FileSpreadsheet} onClick={() => void pickFile(t('import.choose'), ['xlsx']).then((chosen) => chosen && setPath(chosen))}>
          {t('import.choose')}
        </Button>
        <Button icon={Download} onClick={() => void template()}>
          {t('import.template')}
        </Button>
        <span className="text-xs text-muted">{t('import.columns')}</span>
      </div>

      {preview.isError && <p className="text-sm text-danger">{errorText(t, preview.error)}</p>}
      {path && preview.isLoading && <Skeleton className="h-40" />}
      {data && (
        <>
          <p className="text-sm font-semibold">
            <span className="text-ok">{t('import.valid', { count: data.valid })}</span>
            {data.invalid > 0 && <span className="ms-4 text-danger">{t('import.invalid', { count: data.invalid })}</span>}
            {data.newCategories.length > 0 && <span className="ms-4 text-muted">{t('import.newCategories', { names: data.newCategories.join(', ') })}</span>}
          </p>
          <div className="max-h-[40vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-paper text-muted">
                <tr>
                  <th className="px-3 py-2 text-start">{t('import.line')}</th>
                  <th className="px-3 py-2 text-start">{t('stock.items.name')}</th>
                  <th className="px-3 py-2 text-start">{t('stock.items.category')}</th>
                  <th className="px-3 py-2 text-start">{t('stock.items.barcode')}</th>
                  <th className="px-3 py-2 text-end">{t('stock.items.quantity')}</th>
                  <th className="px-3 py-2 text-end">{t('stock.items.cost')}</th>
                  <th className="px-3 py-2 text-end">{t('stock.items.price')}</th>
                  <th className="px-3 py-2 text-start">{t('sell.history.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.line} className={`border-t border-line ${r.errors.length ? 'bg-danger/5' : ''}`}>
                    <td className="px-3 py-1.5">{r.line}</td>
                    <td className="px-3 py-1.5 font-semibold">{r.name || '—'}</td>
                    <td className="px-3 py-1.5">
                      {r.category || '—'} {r.newCategory && r.errors.length === 0 && <Badge tone="accent">{t('import.new')}</Badge>}
                    </td>
                    <td className="mono px-3 py-1.5 text-xs" dir="ltr">{r.barcode ?? '—'}</td>
                    <td className="px-3 py-1.5 text-end">{r.quantity}</td>
                    <td className="px-3 py-1.5 text-end">{money(r.cost)}</td>
                    <td className="px-3 py-1.5 text-end">{money(r.price)}</td>
                    <td className="px-3 py-1.5">
                      {r.errors.length === 0 ? <Badge tone="ok">OK</Badge> : <span className="text-xs text-danger">{r.errors.map((e) => t(`import.errors.${e}`)).join(' · ')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={data.valid === 0 || run.isPending} onClick={() => run.mutate(undefined)}>
              {t('import.confirm', { count: data.valid })}
            </Button>
            {data.invalid > 0 && (
              <Button icon={FileSpreadsheet} onClick={() => void errorReport()}>
                {t('import.errorReport')}
              </Button>
            )}
            <Button className="ms-auto" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
