// The phone as a second till: scan into a cart, pay, receipt. The sale is one request with a client-made id.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Printer, ScanLine, Search, Send, Share2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SALE_METHODS } from '@shared/schemas';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { MoneyField, ScreenHeader, useFormatMoney } from '@/components/common';
import { SwipeRow } from '@/components/SwipeRow';
import { api, errorText, type ApiResult } from '@/lib/api';
import { addItem, addUnit, CartError, cartCount, cartTotal, needsCustomer, remaining, remove, setCustomer, setPayment, setPrice, setQuantity, toSaleInput, type Cart } from '@/lib/cart';
import { clearCart, getCart, setCart, useCart } from '@/lib/cartStore';
import { useConnection } from '@/lib/connection';
import { PrintButton } from '@/components/PrintButton';
import { minimalSettings, printSale, shareSale } from '@/lib/documents';
import { formatDateTime, listRefresh, useCanWrite, useStoreName } from '@/lib/hooks';
import { ViewOnlyNote } from '@/components/ViewOnly';
import { openScanner, ScanError } from '@/lib/scanner';
import { toast } from '@/lib/toast';
import { openWhatsapp } from '@/lib/whatsapp';
import { CustomerPicker } from './CustomerPicker';

type View = { name: 'cart' } | { name: 'pay' } | { name: 'receipt'; id: string } | { name: 'today' };

export function SellHome() {
  const [view, setView] = useState<View>({ name: 'cart' });
  const canWrite = useCanWrite();
  if (!canWrite) return <div data-accent="blue"><ViewOnlyNote /></div>; // outside the shop, selling is a change
  if (view.name === 'pay') return <Payment onBack={() => setView({ name: 'cart' })} onSold={(id) => setView({ name: 'receipt', id })} />;
  if (view.name === 'receipt') return <ReceiptScreen id={view.id} onNew={() => setView({ name: 'cart' })} />;
  if (view.name === 'today') return <Today onBack={() => setView({ name: 'cart' })} onOpen={(id) => setView({ name: 'receipt', id })} />;
  return <CartScreen onPay={() => setView({ name: 'pay' })} onToday={() => setView({ name: 'today' })} />;
}

const asScanFailure = (t: ReturnType<typeof useTranslation>['t'], err: unknown): string => (err instanceof ScanError ? t(err.reason === 'denied' ? 'm.scan.denied' : 'm.scan.unsupported') : errorText(t, err));

function CartScreen({ onPay, onToday }: { onPay: () => void; onToday: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const cart = useCart();
  const [q, setQ] = useState('');
  const query = q.trim();
  const results = useQuery({ queryKey: ['search', 'sell', query], queryFn: () => api('stock.search', { q: query }), enabled: query.length >= 2 });

  /** Adds by what a scan or a tap points to. Returns what to tell the user. */
  const addById = async (target: { type: 'unit' | 'item'; id: string }): Promise<{ ok: boolean; message: string }> => {
    try {
      const current = getCart();
      if (target.type === 'unit') {
        const u = await api('units.get', { id: target.id });
        if (u.status !== 'IN_STOCK') return { ok: false, message: t('m.sell.notForSale', { status: t(`stock.status.${u.status}`) }) };
        const name = [u.name, u.storage, u.color].filter(Boolean).join(' ');
        setCart(addUnit(current, { id: u.id, name, imei: u.imei1, unitPrice: u.salePrice, minPrice: u.minPrice }));
        return { ok: true, message: t('m.sell.added', { name }) };
      }
      const i = await api('items.get', { id: target.id });
      setCart(addItem(current, { id: i.id, name: i.name, imei: null, unitPrice: i.salePrice, minPrice: i.minPrice, available: i.quantity }));
      return { ok: true, message: t('m.sell.added', { name: i.name }) };
    } catch (err) {
      if (err instanceof CartError) return { ok: false, message: err.code === 'duplicate' ? t('m.sell.already') : t('m.sell.notEnough', { n: 0 }) };
      return { ok: false, message: errorText(t, err) };
    }
  };

  /** Scan phones (IMEI) and accessories (barcode) one after another. */
  const scan = async (): Promise<void> => {
    try {
      await openScanner({
        title: t('m.tabs.sell'),
        onRead: async (code) => {
          const hit = await api('stock.lookup', { code });
          if (!hit) return { ok: false, message: t('m.sell.unknown') };
          return addById(hit);
        },
      });
    } catch (err) {
      toast(asScanFailure(t, err));
    }
  };

  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <div className="flex gap-2 p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
          <input className={`${inputClass} ps-10`} placeholder={t('m.sell.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="primary" icon={ScanLine} onClick={() => void scan()}>
          {t('m.sell.scan')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.length >= 2 ? (
          <>
            {(results.data?.units ?? [])
              .filter((u) => u.status === 'IN_STOCK')
              .map((u) => (
                <Row
                  key={u.id}
                  title={[u.name, u.storage, u.color].filter(Boolean).join(' ')}
                  subtitle={<span dir="ltr">{u.imei1 ?? ''}</span>}
                  right={money(u.salePrice)}
                  onClick={() =>
                    void addById({ type: 'unit', id: u.id }).then((r) => {
                      toast(r.message);
                      if (r.ok) setQ('');
                    })
                  }
                />
              ))}
            {(results.data?.items ?? []).map((i) => (
              <Row
                key={i.id}
                title={i.name}
                subtitle={`${i.quantity}`}
                right={money(i.salePrice)}
                onClick={() =>
                  void addById({ type: 'item', id: i.id }).then((r) => {
                    toast(r.message);
                    if (r.ok) setQ('');
                  })
                }
              />
            ))}
          </>
        ) : cart.lines.length === 0 ? (
          <Empty>{t('m.sell.empty')}</Empty>
        ) : (
          <>
            <p className="px-4 pb-1 text-xs text-muted">{t('m.sell.swipe')}</p>
            {cart.lines.map((l) => (
              <SwipeRow key={`${l.kind}-${l.id}`} label={t('m.receive.remove')} onRemove={() => setCart(remove(cart, l.id))}>
                <LineEditor cart={cart} lineId={l.id} />
              </SwipeRow>
            ))}
          </>
        )}
      </div>

      <div className="border-t border-line bg-card p-3">
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onToday}>
            {t('m.sell.today')}
          </Button>
        </div>
        <Button variant="primary" className="mt-2 w-full" disabled={cart.lines.length === 0} onClick={onPay}>
          {t('sell.pay')} · {money(cartTotal(cart))} · {t('m.sell.lines', { n: cartCount(cart) })}
        </Button>
      </div>
    </div>
  );
}

function LineEditor({ cart, lineId }: { cart: Cart; lineId: string }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const line = cart.lines.find((l) => l.id === lineId)!;
  const [editing, setEditing] = useState(false);
  const [price, setLocalPrice] = useState<number | null>(line.unitPrice);
  const apply = (): void => {
    if (price !== null) setCart(setPrice(cart, line.id, price));
    setEditing(false);
  };
  return (
    <div className="px-4 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{line.name}</div>
          {line.imei && (
            <div dir="ltr" className="mono text-start text-xs text-muted">
              {line.imei}
            </div>
          )}
        </div>
        <button className="min-h-touch shrink-0 rounded-lg px-2 font-semibold text-accent" onClick={() => setEditing((v) => !v)}>
          {money(line.unitPrice * line.quantity)}
        </button>
      </div>
      {line.kind === 'item' && (
        <div className="mt-1 flex items-center gap-3">
          <button className="h-12 w-12 rounded-xl border border-line text-xl" onClick={() => setCart(setQuantity(cart, line.id, line.quantity - 1))}>
            −
          </button>
          <span className="w-8 text-center text-lg font-semibold">{line.quantity}</span>
          <button
            className="h-12 w-12 rounded-xl border border-line text-xl"
            onClick={() => {
              try {
                setCart(setQuantity(cart, line.id, line.quantity + 1));
              } catch {
                toast(t('m.sell.notEnough', { n: line.available }));
              }
            }}
          >
            +
          </button>
          <span className="text-sm text-muted">× {money(line.unitPrice)}</span>
        </div>
      )}
      {editing && (
        <div className="mt-2 space-y-2">
          <Field label={t('sell.price')}>
            <MoneyField value={price} onChange={setLocalPrice} />
          </Field>
          {line.minPrice > 0 && <div className="text-xs text-muted">{t('m.sell.minPrice', { amount: money(line.minPrice) })}</div>}
          <Button variant="primary" className="w-full" onClick={apply}>
            {t('common.confirm')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Payment({ onBack, onSold }: { onBack: () => void; onSold: (id: string) => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const cart = useCart();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cashState = useQuery({ queryKey: ['cash', 'state'], queryFn: () => api('cash.state'), refetchInterval: listRefresh });
  const total = cartTotal(cart);
  const left = remaining(cart);
  const noSession = cashState.data !== undefined && !cashState.data.open;

  const confirm = async (): Promise<void> => {
    if (needsCustomer(cart) && !cart.customerId) return setError(t('sell.customerForDebt'));
    setBusy(true);
    setError('');
    try {
      const sale = await api('sales.create', toSaleInput(cart));
      clearCart();
      void client.invalidateQueries();
      toast(t('sell.saved'));
      onSold(sale.id);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : '';
      setError(code === 'no_cash_session' ? t('m.sell.noSession') : `${t('m.sell.failed')} (${errorText(t, err)})`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <ScreenHeader title={t('m.sell.payTitle')} onBack={onBack} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {noSession && <div className="rounded-xl bg-danger/15 p-3 text-danger">{t('m.sell.noSession')}</div>}
        <Row title={t('sell.total')} right={<span className="text-xl font-bold">{money(total)}</span>} />
        <Row title={t('sell.customer')} right={cart.customerName || t('m.sell.customerNone')} onClick={() => setPicking(true)} />
        {cart.customerId && (
          <button className="text-sm text-muted underline" onClick={() => setCart(setCustomer(cart, null))}>
            {t('m.sell.customerNone')}
          </button>
        )}
        <Field label={t('m.sell.paidNow')}>
          <MoneyField value={cart.paid === null ? total : cart.paid} onChange={(v) => setCart(setPayment(cart, { paid: Math.min(v ?? 0, total) }))} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Button onClick={() => setCart(setPayment(cart, { paid: null }))}>{t('m.sell.exact')}</Button>
          <Button onClick={() => setCart(setPayment(cart, { paid: Math.floor(total / 2) }))}>{t('m.sell.half')}</Button>
          <Button onClick={() => setCart(setPayment(cart, { paid: 0 }))}>{t('m.sell.nothing')}</Button>
        </div>
        <Field label={t('sell.method')}>
          <select className={inputClass} value={cart.method} onChange={(e) => setCart(setPayment(cart, { method: e.target.value as Cart['method'] }))}>
            {SALE_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`sell.methods.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Row title={t('sell.remaining')} right={<span className={left > 0 ? 'text-xl font-bold text-danger' : 'text-xl font-bold'}>{money(left)}</span>} />
        {left > 0 && !cart.customerId && <div className="text-sm text-danger">{t('sell.customerForDebt')}</div>}
        {error && <div className="rounded-xl bg-danger/15 p-3 text-danger">{error}</div>}
      </div>
      <div className="border-t border-line bg-card p-3">
        <Button variant="primary" className="w-full" busy={busy} disabled={noSession} onClick={() => void confirm()}>
          {busy ? t('m.sell.selling') : t('m.sell.confirm')}
        </Button>
      </div>
      {picking && (
        <CustomerPicker
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setCart(setCustomer(cart, c));
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

type Sale = ApiResult<'sales.get'>;

function ReceiptScreen({ id, onNew }: { id: string; onNew: () => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const [busy, setBusy] = useState(false);
  const outside = useConnection().route === 'remote';
  const alone = useConnection().route === 'local';
  const canWrite = useCanWrite();
  const store = useStoreName();
  const sale = useQuery({ queryKey: ['sale', id], queryFn: () => api('sales.get', { id }) });
  const s = sale.data;

  const print = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('sales.printReceipt', { id });
      toast(t('m.sell.printed'));
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  const shareImage = async (toCustomer: boolean): Promise<void> => {
    if (!s) return;
    try {
      const settings = await api('settings.get');
      await shareSale(t, i18n.language, s, settings, money, toCustomer ? s.customerWhatsapp || s.customerPhone || undefined : undefined);
    } catch (err) {
      toast(errorText(t, err));
    }
  };
  // The phone's own Bluetooth printer. A connected phone is not offered the PC's settings, so it prints the shop's name only.
  const printOnPhone = async (): Promise<void> => {
    if (!s) return;
    await printSale(t, i18n.language, s, alone ? await api('settings.get') : minimalSettings(store), money);
  };
  const whatsapp = (): void => {
    if (!s) return;
    void openWhatsapp(s.customerWhatsapp || s.customerPhone || '', receiptText(t, i18n.language, s, money)).catch((err) => toast(errorText(t, err)));
  };

  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <ScreenHeader title={t('sell.receiptTitle', { number: s?.receiptNumber ?? '' })} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s && (
          <>
            <div className="flex items-center gap-2 p-4 text-ok">
              <Check className="h-6 w-6" /> {t('sell.saved')}
            </div>
            {(s as { waiting?: boolean }).waiting && (
              <div className="mx-4 mb-2 rounded-xl bg-accent-soft p-3 text-sm">
                <b>{t('m.sync.waitingMark')}</b> · {t('m.sync.finalNumber')}
              </div>
            )}
            {s.lines.map((l, i) => (
              <Row key={i} title={`${[l.name, l.storage, l.color].filter(Boolean).join(' ')}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`} subtitle={l.imei1 ? <span dir="ltr">{l.imei1}</span> : undefined} right={money(l.lineTotal)} />
            ))}
            <Row title={t('sell.total')} right={<b>{money(s.total)}</b>} />
            <Row title={t('sell.paid')} right={money(s.paid)} />
            {s.remaining > 0 && <Row title={t('sell.remaining')} right={<b className="text-danger">{money(s.remaining)}</b>} />}
            {s.customerName && <Row title={t('sell.customer')} right={s.customerName} />}
          </>
        )}
      </div>
      <div className="space-y-2 border-t border-line bg-card p-3">
        {alone ? (
          <>
            {/* On a phone alone there is no counter printer: the receipt goes out as a picture, WhatsApp first. */}
            <Button variant="primary" icon={Send} className="w-full" disabled={!s} onClick={() => void shareImage(true)}>
              {t('sell.whatsapp')}
            </Button>
            <PrintButton always className="w-full" disabled={!s} make={printOnPhone} />
            <Button icon={Share2} className="w-full" disabled={!s} onClick={() => void shareImage(false)}>
              {t('m.alone.share')}
            </Button>
          </>
        ) : (
          <>
        {/* Outside the shop the customer is not at the counter: WhatsApp comes first, and printing (a change) only when allowed. */}
        {outside && (
          <Button variant="primary" icon={Send} className="w-full" disabled={!s} onClick={whatsapp}>
            {t('sell.whatsapp')}
          </Button>
        )}
        <PrintButton disabled={!s} make={printOnPhone} />
        {canWrite && (
          <Button variant={outside ? undefined : 'primary'} icon={Printer} className="w-full" busy={busy} onClick={() => void print()}>
            {t('m.sell.printCounter')}
          </Button>
        )}
        {!outside && (
          <Button icon={Send} className="w-full" disabled={!s} onClick={whatsapp}>
            {t('sell.whatsapp')}
          </Button>
        )}
          </>
        )}
        <Button icon={ArrowLeft} className="w-full" onClick={onNew}>
          {t('sell.newSale')}
        </Button>
      </div>
    </div>
  );
}

/** The same summary as the desktop's WhatsApp message. */
function receiptText(t: ReturnType<typeof useTranslation>['t'], lang: string, s: Sale, money: (c: number) => string): string {
  const lines = s.lines.map((l) => `• ${[l.name, l.storage, l.color].filter(Boolean).join(' ')}${l.quantity > 1 ? ` × ${l.quantity}` : ''} — ${money(l.lineTotal)}`);
  return [
    `${t('sell.receipt.number')}: ${s.receiptNumber} (${new Date(s.date).toLocaleDateString(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang)})`,
    ...lines,
    `${t('sell.total')}: ${money(s.total)}`,
    `${t('sell.paid')}: ${money(s.paid)}`,
    ...(s.remaining > 0 ? [`${t('sell.remaining')}: ${money(s.remaining)}`] : []),
    // Made without the PC: the number above is temporary.
    ...((s as { waiting?: boolean }).waiting ? [t('m.sync.finalNumber')] : []),
  ].join('\n');
}

function Today({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const money = useFormatMoney();
  const client = useQueryClient();
  const range = (): { from: string; to: string } => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000 - 1).toISOString() };
  };
  const list = useQuery({ queryKey: ['sales', 'mine'], queryFn: () => api('sales.mine', range()), refetchInterval: listRefresh });
  const [busy, setBusy] = useState('');
  const canWrite = useCanWrite();
  const reprint = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await api('sales.printReceipt', { id });
      toast(t('m.sell.printed'));
    } catch (err) {
      toast(errorText(t, err));
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="flex h-full flex-col" data-accent="blue">
      <ScreenHeader title={t('m.sell.today')} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => client.invalidateQueries({ queryKey: ['sales', 'mine'] })}>
          {(list.data ?? []).length === 0 && <Empty>{t('m.sell.todayEmpty')}</Empty>}
          {(list.data ?? []).map((s) => (
            <div key={s.id} className="border-b border-line">
              <Row onClick={() => onOpen(s.id)} title={s.itemsSummary ?? s.receiptNumber} subtitle={`${s.receiptNumber} · ${formatDateTime(s.date, i18n.language)}`} right={money(s.total)} />
              {canWrite && (
                <div className="px-4 pb-2">
                  <Button icon={Printer} className="w-full" busy={busy === s.id} onClick={() => void reprint(s.id)}>
                    {t('sell.reprint')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Refreshable>
      </div>
    </div>
  );
}

