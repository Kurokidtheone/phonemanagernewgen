// The Stock tab: receive stock, count stock, and the recent counts.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Pill, Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { setDraft, startDraft, useDraft } from '@/lib/draftStore';
import { ViewOnlyNote } from '@/components/ViewOnly';
import { formatDateTime, listRefresh, useCanWrite } from '@/lib/hooks';
import { isEmpty, phoneCount } from '@/lib/receive';
import { Counting, CountResult, StartCount } from './Count';
import { Receive } from './Receive';

type View = { name: 'home' } | { name: 'receive' } | { name: 'start' } | { name: 'counting'; id: string } | { name: 'result'; id: string };

export function StockHome() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const draft = useDraft();
  const canWrite = useCanWrite();
  const [view, setView] = useState<View>({ name: 'home' });
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api('stockCount.list'), refetchInterval: listRefresh });
  const home = (): void => setView({ name: 'home' });

  if (view.name === 'receive') return <Receive onExit={home} />;
  if (view.name === 'start') return <StartCount onBack={home} onStarted={(id) => setView({ name: 'counting', id })} />;
  if (view.name === 'counting') return <Counting id={view.id} onBack={home} onFinish={() => setView({ name: 'result', id: view.id })} />;
  if (view.name === 'result') return <CountResult id={view.id} onBack={home} onContinue={() => setView({ name: 'counting', id: view.id })} />;

  const hasDraft = canWrite && !!draft && (!isEmpty(draft) || !!draft.supplierId);
  return (
    <div className="h-full" data-accent="green">
      <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['counts'] })}>
        <div className="space-y-3 p-3">
          {hasDraft && (
            <div className="rounded-2xl border border-accent bg-accent-faint p-4">
              <div className="font-semibold">{t('m.stock.draft')}</div>
              <div className="text-sm text-muted">{t('m.stock.draftHint', { phones: phoneCount(draft), items: draft.items.length })}</div>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" className="flex-1" onClick={() => setView({ name: 'receive' })}>
                  {t('m.count.resume')}
                </Button>
                <Button onClick={() => setDraft(null)}>{t('m.stock.discard')}</Button>
              </div>
            </div>
          )}
          {canWrite ? (
            <>
          <Button
            variant="primary"
            icon={PackagePlus}
            className="min-h-[64px] w-full text-lg"
            onClick={() => {
              if (!draft) startDraft();
              setView({ name: 'receive' });
            }}
          >
            {t('m.stock.receive')}
          </Button>
          <Button icon={ClipboardCheck} className="min-h-[64px] w-full text-lg" onClick={() => setView({ name: 'start' })}>
            {t('m.stock.count')}
          </Button>
            </>
          ) : (
            <ViewOnlyNote />
          )}
        </div>
        <h3 className="px-4 pb-1 pt-3 font-semibold">{t('m.stock.counts')}</h3>
        {(counts.data ?? []).length === 0 && <Empty>{t('m.stock.noCounts')}</Empty>}
        {(counts.data ?? []).map((c) => (
          <Row
            key={c.id}
            onClick={() => setView(c.status === 'OPEN' && canWrite ? { name: 'counting', id: c.id } : { name: 'result', id: c.id })}
            title={`${t(`stock.counts.scopes.${c.scope}`, { name: c.categoryName ?? '' })}`}
            subtitle={`${formatDateTime(c.startedAt, i18n.language)}${c.startedBy ? ` · ${c.startedBy}` : ''}`}
            right={
              <div>
                <Pill tone={c.status === 'OPEN' ? 'accent' : c.applied ? 'ok' : 'neutral'}>{t(c.status === 'OPEN' ? 'm.stock.open' : c.applied ? 'm.stock.applied' : 'm.stock.closed')}</Pill>
                {c.missing + c.unexpected + c.differences > 0 && <div className="mt-1 text-xs text-danger">{t('m.stock.missingShort', { n: c.missing })}</div>}
              </div>
            }
          />
        ))}
      </Refreshable>
    </div>
  );
}
