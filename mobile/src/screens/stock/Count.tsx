// Count stock: start (or join) a count for a scope, scan what is on the shelf, see the result, and (owner) apply.
// Every scan goes to the PC as it happens, so two phones can count the same scope together.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanLine, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { COUNT_SCOPES } from '@shared/schemas';
import { Button, Empty, Field, inputClass, Pill, Refreshable, Row } from '@/components/ui';
import { ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { api, errorText, type ApiResult } from '@/lib/api';
import { countRefresh, useCanWrite } from '@/lib/hooks';
import { useConnection } from '@/lib/connection';
import { openScanner, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';
import { ItemPicker, type ItemChoice } from './pickers';

type Scope = (typeof COUNT_SCOPES)[number];

export function StartCount({ onStarted, onBack }: { onStarted: (id: string) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('PHONES');
  const [categoryId, setCategoryId] = useState('');
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api('categories.list') });
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api('stockCount.start', scope === 'CATEGORY' ? { scope, categoryId } : { scope });
      if (r.joined) toast(t('m.count.joined'));
      onStarted(r.id);
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const options: { id: Scope; label: string }[] = [
    { id: 'PHONES', label: t('m.count.scopePhones') },
    { id: 'ITEMS', label: t('m.count.scopeItems') },
    { id: 'CATEGORY', label: t('m.count.scopeCategory') },
  ];
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader title={t('m.count.title')} onBack={onBack} />
      <div className="space-y-3 p-3">
        <h3 className="font-semibold">{t('m.count.scope')}</h3>
        {options.map((o) => (
          <button key={o.id} className={`flex min-h-[56px] w-full items-center rounded-xl border px-4 text-start text-base ${scope === o.id ? 'border-accent bg-accent-soft font-semibold' : 'border-line bg-card'}`} onClick={() => setScope(o.id)}>
            {o.label}
          </button>
        ))}
        {scope === 'CATEGORY' && (
          <Field label={t('m.count.chooseCategory')}>
            <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="" />
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Button variant="primary" className="w-full" busy={busy} disabled={scope === 'CATEGORY' && !categoryId} onClick={() => void start()}>
          {t('m.count.start')}
        </Button>
      </div>
    </div>
  );
}

/** The count in progress: scan, and watch the totals other phones add to. */
export function Counting({ id, onFinish, onBack }: { id: string; onFinish: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [item, setItem] = useState<ItemChoice | null>(null);
  const [qty, setQty] = useState('');
  const view = useQuery({ queryKey: ['count', id], queryFn: () => api('stockCount.get', { id }), refetchInterval: countRefresh });
  const r = view.data;
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['count', id] });

  const scanPhones = async (): Promise<void> => {
    try {
      await openScanner({
        title: t('m.count.scanPhones'),
        imei: true,
        onRead: async (code) => {
          const out = await api('stockCount.scanUnit', { countId: id, code });
          const name = out.unit ? [out.unit.name, out.unit.storage, out.unit.color].filter(Boolean).join(' ') : code;
          if (out.status === 'counted') return { ok: true, message: `${t('m.count.counted_ok')}: ${name}` };
          if (out.status === 'already') return { ok: false, message: `${t('m.count.already')}: ${name}` };
          return { ok: false, message: `${out.reason ? t(`m.count.reason_${out.reason}`) : ''}: ${name}` };
        },
      });
    } catch (err) {
      toast(err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));
    }
    void refresh();
  };

  const saveQty = async (): Promise<void> => {
    if (!item || qty === '') return;
    try {
      await api('stockCount.countItem', { countId: id, productId: item.id, quantity: Number.parseInt(qty, 10) });
      toast(t('m.count.qtySaved', { name: item.name, qty }));
      setItem(null);
      setQty('');
      void refresh();
    } catch (err) {
      toast(errorText(t, err));
    }
  };

  const phonesInScope = r?.scope !== 'ITEMS';
  const itemsInScope = r?.scope !== 'PHONES';
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader title={t('m.count.title')} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={refresh}>
          <div className="space-y-3 p-3">
            {r && (
              <div className="rounded-2xl border border-line bg-card p-4">
                {phonesInScope && <div className="text-xl font-bold">{t('m.count.counted', { n: r.counted })}</div>}
                {itemsInScope && <div className="text-lg">{t('m.count.itemsCounted', { n: r.itemsCounted })}</div>}
                <div className="mt-1 text-sm text-muted">{t('m.count.live')}</div>
              </div>
            )}
            {phonesInScope && (
              <Button variant="primary" icon={ScanLine} className="min-h-[64px] w-full text-lg" onClick={() => void scanPhones()}>
                {t('m.count.scanPhones')}
              </Button>
            )}
            {itemsInScope && (
              <Button icon={Search} className="w-full" onClick={() => setPicking(true)}>
                {t('m.count.scanItem')}
              </Button>
            )}
            <Button className="w-full" onClick={onFinish}>
              {t('m.count.finish')}
            </Button>
          </div>
        </Refreshable>
      </div>

      {picking && !item && (
        <Sheet title={t('m.count.scanItem')} onClose={() => setPicking(false)} closeLabel={t('common.cancel')}>
          <ItemPicker
            onPick={(i) => {
              setItem(i);
              setPicking(false);
            }}
          />
        </Sheet>
      )}
      {item && (
        <Sheet title={t('m.count.quantityTitle')} onClose={() => setItem(null)}>
          <div className="space-y-3">
            <div className="font-semibold">{item.name}</div>
            <input dir="ltr" className={`${inputClass} text-2xl`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} autoFocus />
            <Button variant="primary" className="w-full" disabled={qty === ''} onClick={() => void saveQty()}>
              {t('m.count.saveQty')}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

type Result = ApiResult<'stockCount.get'>;

/** Missing, unexpected and accessory differences, with totals at cost for the owner. Apply is the owner's. */
export function CountResult({ id, onBack, onContinue }: { id: string; onBack: () => void; onContinue: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const canWrite = useCanWrite();
  const owner = useConnection().role === 'OWNER' && canWrite;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = useQuery({ queryKey: ['count', id], queryFn: () => api('stockCount.get', { id }), refetchInterval: countRefresh });
  const r: Result | undefined = view.data;
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['count', id] });

  const run = async (job: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await job();
      setConfirm(false);
      await client.invalidateQueries();
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  const decide = (unitId: string, action: 'WRITE_OFF' | 'KEEP'): Promise<void> => run(() => api('stockCount.decide', { countId: id, unitId, action }));

  const unitTitle = (u: { name: string; storage: string; color: string }): string => [u.name, u.storage, u.color].filter(Boolean).join(' ');
  return (
    <div className="flex h-full flex-col" data-accent="green">
      <ScreenHeader title={t('m.count.result')} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={refresh}>
          {r && (
            <div className="pb-6">
              <h3 className="px-4 pb-1 pt-3 font-semibold">
                {t('m.count.missing')} ({r.missing.length})
              </h3>
              {r.missing.length === 0 && <Empty>{t('m.count.none')}</Empty>}
              {r.missing.map((u) => (
                <div key={u.id} className="border-b border-line">
                  <Row title={unitTitle(u)} subtitle={<span dir="ltr">{u.imei ?? ''}</span>} right={'cost' in u && typeof u.cost === 'number' ? money(u.cost) : undefined} />
                  {r.status === 'CLOSED' && owner && (
                    <div className="flex gap-2 px-4 pb-3">
                      {u.decision ? (
                        <Pill tone={u.decision === 'WRITE_OFF' ? 'danger' : 'ok'}>{t(u.decision === 'WRITE_OFF' ? 'm.count.writtenOff' : 'm.count.kept')}</Pill>
                      ) : (
                        <>
                          <Button variant="danger" className="flex-1" disabled={busy} onClick={() => void decide(u.id, 'WRITE_OFF')}>
                            {t('m.count.writeOff')}
                          </Button>
                          <Button className="flex-1" disabled={busy} onClick={() => void decide(u.id, 'KEEP')}>
                            {t('m.count.keep')}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {'missingCost' in r && typeof r.missingCost === 'number' && r.missing.length > 0 && <Row title={t('m.count.missingCost')} right={money(r.missingCost)} />}

              <h3 className="px-4 pb-1 pt-4 font-semibold">
                {t('m.count.unexpected')} ({r.unexpected.length})
              </h3>
              {r.unexpected.length === 0 && <Empty>{t('m.count.none')}</Empty>}
              {r.unexpected.map((u, i) => (
                <Row key={i} title={u.unit ? unitTitle(u.unit) : u.code} subtitle={<span dir="ltr">{u.unit?.imei ?? u.code}</span>} right={<Pill tone="danger">{t(`m.count.reason_${u.reason}`)}</Pill>} />
              ))}

              <h3 className="px-4 pb-1 pt-4 font-semibold">
                {t('m.count.differences')} ({r.differences.length})
              </h3>
              {r.differences.length === 0 && <Empty>{t('m.count.none')}</Empty>}
              {r.differences.map((d) => (
                <Row key={d.productId} title={d.name} subtitle={`${t('m.count.system')} ${d.system} · ${t('m.count.countedQty')} ${d.counted}`} right={<span className="font-bold text-danger">{d.difference > 0 ? `+${d.difference}` : d.difference}</span>} />
              ))}
              {'differenceCost' in r && typeof r.differenceCost === 'number' && r.differences.length > 0 && <Row title={t('m.count.diffCost')} right={money(r.differenceCost)} />}

              <div className="space-y-2 p-4">
                {r.status === 'OPEN' ? (
                  <>
                    {canWrite && (
                      <Button className="w-full" onClick={onContinue}>
                        {t('m.count.resume')}
                      </Button>
                    )}
                    {owner ? (
                      <>
                        <Button variant="primary" className="w-full" disabled={busy} onClick={() => setConfirm(true)}>
                          {t('m.count.apply')}
                        </Button>
                        <Button className="w-full" disabled={busy} onClick={() => void run(() => api('stockCount.close', { id }))}>
                          {t('m.count.closeOnly')}
                        </Button>
                      </>
                    ) : (
                      <p className="text-center text-muted">{t('m.count.ownerApplies')}</p>
                    )}
                  </>
                ) : (
                  <p className="text-center text-muted">{t('m.count.closedInfo')}</p>
                )}
              </div>
            </div>
          )}
        </Refreshable>
      </div>
      {confirm && (
        <Sheet title={t('m.count.applyTitle')} onClose={() => setConfirm(false)}>
          <p className="mb-4 text-muted">{t('m.count.applyBody')}</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" className="flex-1" busy={busy} onClick={() => void run(() => api('stockCount.apply', { id }))}>
              {t('m.count.apply')}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
