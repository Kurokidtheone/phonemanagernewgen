import { useQuery } from '@tanstack/react-query';
import { Minus, PauseCircle, Plus, ScanLine, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Badge, Button, Card, MoneyInput } from '@/components/ui';
import { api, type ApiResult } from '@/lib/api';
import { belowMinimum, cartSubtotal, lineTotal, useCart } from '@/lib/cart';
import { formatDateTime, useMoney, useSettings } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { QR_TOKEN_PATTERN } from '@shared/schemas';
import { useEnsureDay } from '@/components/EnsureDay';
import { QuickSale } from '@/components/QuickSale';
import { PaymentFlow } from './PaymentFlow';

type Unit = ApiResult<'units.list'>[number];
type Item = ApiResult<'items.list'>[number];
const SHOWN = 30;

/**
 * The till. Focus stays in the search field: a scan or Enter adds, F2 opens payment, Esc clears the
 * field. Phones and items share one cart; stock only changes when the sale is paid.
 */
export function NewSaleTab() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const settings = useSettings().data;
  const cart = useCart();
  const day = useEnsureDay();
  const searchRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [chip, setChip] = useState<string>(''); // '' all, 'phones', or a category id
  const [paying, setPaying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);

  const units = useQuery({ queryKey: ['units', 'list', 'IN_STOCK', '', ''], queryFn: () => api('units.list', { status: 'IN_STOCK' }) });
  const items = useQuery({ queryKey: ['items', 'list', '', false, false], queryFn: () => api('items.list', {}) });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api('categories.list') });

  const focusSearch = (): void => searchRef.current?.focus();
  const dialogOpen = paying || clearing || heldOpen || !!day.dialog;
  useEffect(() => {
    if (!dialogOpen) focusSearch();
  }, [dialogOpen]);

  const subtotal = cartSubtotal(cart.lines);
  const total = subtotal - cart.discount;

  // Selling needs an open cash day: the first payment of the day asks for the opening float.
  const startPay = (): void => day.ensure(() => setPaying(true));
  const startPayRef = useRef(startPay);
  startPayRef.current = startPay;

  // F2 opens payment from anywhere on the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F2' && !document.querySelector('[role="dialog"]') && useCart.getState().lines.length > 0) {
        e.preventDefault();
        startPayRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const q = text.trim().toLowerCase();
  const found = useMemo(() => {
    const phones = chip && chip !== 'phones' ? [] : (units.data ?? []).filter((u) => !q || `${u.name} ${u.model} ${u.storage} ${u.color} ${u.imei1 ?? ''} ${u.imei2 ?? ''}`.toLowerCase().includes(q));
    const accessories = chip === 'phones' ? [] : (items.data ?? []).filter((i) => (!chip || i.categoryId === chip) && (!q || `${i.name} ${i.barcode ?? ''}`.toLowerCase().includes(q)));
    return { phones: phones.slice(0, SHOWN), accessories: accessories.slice(0, SHOWN) };
  }, [units.data, items.data, q, chip]);

  const addUnit = (u: Unit): void => {
    const added = cart.addLine({
      unitId: u.id,
      productId: u.productId,
      name: [u.name, u.storage, u.color].filter(Boolean).join(' '),
      imei: u.imei1,
      quantity: 1,
      available: null,
      unitPrice: u.salePrice,
      minPrice: u.minPrice,
      discount: 0,
      // Phones: the shop's default for new or used phones (Settings > Sales rules).
      warrantyDays: u.condition === 'NEW' ? (settings?.warrantyNewDays ?? 0) : (settings?.warrantyUsedDays ?? 0),
    });
    if (added === 'duplicate') toast.error(t('sell.alreadyInCart'));
  };
  const addItem = (i: Item): void => {
    const inCart = cart.lines.find((l) => l.productId === i.id)?.quantity ?? 0;
    if (inCart + 1 > i.quantity && !settings?.allowNegativeStock) return void toast.error(t('sell.notEnoughStock', { name: i.name, count: i.quantity }));
    cart.addLine({ unitId: null, productId: i.id, name: i.name, imei: null, quantity: 1, available: i.quantity, unitPrice: i.salePrice, minPrice: i.minPrice, discount: 0, warrantyDays: i.defaultWarrantyDays || (settings?.warrantyAccessoryDays ?? 0) });
  };

  const onEnter = async (): Promise<void> => {
    const code = text.trim();
    if (!code) return;
    if (QR_TOKEN_PATTERN.test(code)) return setText(''); // a repair ticket QR: the app opens the ticket
    const unit = units.data?.find((u) => u.imei1 === code || u.imei2 === code);
    const item = items.data?.find((i) => i.barcode === code);
    if (unit) addUnit(unit);
    else if (item) addItem(item);
    else if (found.phones.length + found.accessories.length > 0) {
      // Typed search: Enter takes the first result.
      if (found.phones[0]) addUnit(found.phones[0]);
      else addItem(found.accessories[0]);
    } else {
      // Nothing matches. Say whether it is a phone that exists but is not for sale, or a code we do not know.
      const status = /^\d{15}$/.test(code) ? await api('units.imeiStatus', { imei: code }) : null;
      toast.error(status?.duplicate ? t('sell.notForSale', { status: t(`stock.status.${status.duplicate.status}`) }) : t('sell.unknownCode', { code }));
    }
    setText('');
  };

  return (
    <div
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
      // Keep the search field ready for the scanner: after a click on anything that is not a field, focus returns to it.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('input, select, textarea')) focusSearch();
      }}
    >
      <section>
        <div className="relative mb-3">
          <ScanLine size={20} className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-accent" aria-hidden />
          <input
            ref={searchRef}
            autoFocus
            className="input h-14 ps-12 text-lg"
            dir="auto"
            value={text}
            placeholder={t('sell.search')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void onEnter();
              } else if (e.key === 'Escape') setText('');
            }}
          />
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <Chip active={chip === ''} onClick={() => setChip('')}>{t('sell.all')}</Chip>
          <Chip active={chip === 'phones'} onClick={() => setChip('phones')}>{t('sell.phones')}</Chip>
          {categories.data?.filter((c) => c.kind !== 'PHONE').map((c) => (
            <Chip key={c.id} active={chip === c.id} onClick={() => setChip(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
        <div className="max-h-[calc(100vh-30rem)] min-h-[8rem] space-y-1.5 overflow-y-auto pe-1">
          {found.phones.map((u) => (
            <button key={u.id} type="button" onClick={() => addUnit(u)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-card px-4 py-2.5 text-start hover:border-accent">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{[u.name, u.storage, u.color].filter(Boolean).join(' · ')}</span>
                <span className="mono block text-xs text-muted" dir="ltr">{u.imei1 ?? t('stock.phones.noImei')} · {t(`stock.condition.${u.condition}`)}</span>
              </span>
              <b>{money(u.salePrice)}</b>
            </button>
          ))}
          {found.accessories.map((i) => (
            <button key={i.id} type="button" onClick={() => addItem(i)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-card px-4 py-2.5 text-start hover:border-accent">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{i.name}</span>
                <span className="block text-xs text-muted">{i.categoryName} · {t('stock.items.quantity')}: {i.quantity}</span>
              </span>
              <b>{money(i.salePrice)}</b>
            </button>
          ))}
          {found.phones.length + found.accessories.length === 0 && <p className="py-8 text-center text-sm text-muted">{t('sell.noResults')}</p>}
        </div>
        <div className="mt-4">
          <QuickSale onSaved={focusSearch} />
        </div>
      </section>

      <section>
        {cart.exchange && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3 text-sm">
            <span className="font-semibold text-accent">{t('sell.exchange.banner', { receipt: cart.exchange.receipt, amount: money(cart.exchange.credit) })}</span>
            <Button onClick={() => cart.setExchange(null)}>{t('sell.exchange.cancel')}</Button>
          </div>
        )}
        <Card className="flex flex-col">
          {cart.lines.length === 0 ? (
            <p className="py-12 text-center text-muted">{t('sell.emptyCart')}</p>
          ) : (
            <ul
              className="divide-y divide-line"
              onKeyDown={(e) => {
                // Enter in a cart field goes back to the search box, ready for the next scan.
                if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
                  e.preventDefault();
                  focusSearch();
                }
              }}
            >
              {cart.lines.map((l) => (
                <li key={l.key} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{l.name}</p>
                      {l.imei && <p className="mono text-xs text-muted" dir="ltr">{l.imei}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <b>{money(lineTotal(l))}</b>
                      <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" aria-label={t('common.remove')} onClick={() => cart.removeLine(l.key)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-[auto_1fr_1fr_5rem] items-end gap-2 text-xs">
                    {l.unitId ? (
                      <span />
                    ) : (
                      <div className="flex items-center gap-1">
                        <button type="button" className="rounded-md border border-line p-1.5" aria-label="-" onClick={() => cart.patchLine(l.key, { quantity: Math.max(1, l.quantity - 1) })}>
                          <Minus size={14} />
                        </button>
                        <span className="w-8 text-center text-sm font-bold">{l.quantity}</span>
                        <button
                          type="button"
                          className="rounded-md border border-line p-1.5 disabled:opacity-40"
                          aria-label="+"
                          disabled={!settings?.allowNegativeStock && l.available !== null && l.quantity >= l.available}
                          onClick={() => cart.patchLine(l.key, { quantity: l.quantity + 1 })}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                    <label className="block">
                      <span className="text-muted">{t('sell.price')}</span>
                      <span className={belowMinimum(l) ? 'block rounded-lg ring-2 ring-danger' : 'block'}>
                        <MoneyInput key={`p${l.key}`} value={l.unitPrice} onChange={(v) => cart.patchLine(l.key, { unitPrice: v ?? 0 })} />
                      </span>
                    </label>
                    <label className="block">
                      <span className="text-muted">{t('sell.lineDiscount')}</span>
                      <MoneyInput key={`d${l.key}`} value={l.discount || null} onChange={(v) => cart.patchLine(l.key, { discount: v ?? 0 })} />
                    </label>
                    <label className="block">
                      <span className="text-muted">{t('sell.warranty')}</span>
                      <input className="input" type="number" min={0} dir="ltr" value={l.warrantyDays} onChange={(e) => cart.patchLine(l.key, { warrantyDays: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
                    </label>
                  </div>
                  {belowMinimum(l) && (
                    <p className="mt-1">
                      <Badge tone="danger">{t('sell.belowMinimum', { amount: money(l.minPrice) })}</Badge>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <p className="flex justify-between"><span className="text-muted">{t('sell.subtotal')}</span><span>{money(subtotal)}</span></p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">{t('sell.discount')}</span>
              <div className="w-36"><MoneyInput key={`disc${cart.lines.length}${cart.held.length}`} value={cart.discount || null} onChange={(v) => cart.setDiscount(v ?? 0)} /></div>
            </div>
            <p className="flex justify-between text-2xl font-bold text-accent"><span>{t('sell.total')}</span><span>{money(Math.max(0, total))}</span></p>
          </div>
          <div className="mt-4 grid grid-cols-[auto_auto_auto_1fr] gap-2">
            <Button icon={PauseCircle} disabled={cart.lines.length === 0} onClick={() => cart.hold()}>
              {t('sell.hold')}
            </Button>
            <Button onClick={() => setHeldOpen(true)} disabled={cart.held.length === 0}>
              {t('sell.held', { count: cart.held.length })}
            </Button>
            <Button icon={X} disabled={cart.lines.length === 0} onClick={() => setClearing(true)}>
              {t('sell.clear')}
            </Button>
            <Button variant="primary" className="h-12 text-base" disabled={cart.lines.length === 0 || total < 0} onClick={startPay}>
              {t('sell.pay')} (F2)
            </Button>
          </div>
        </Card>
      </section>

      {day.dialog}
      {paying && <PaymentFlow onClose={() => setPaying(false)} />}
      {clearing && (
        <ConfirmDialog
          title={t('sell.clearTitle')}
          body={t('sell.clearBody')}
          confirmLabel={t('sell.clear')}
          onConfirm={() => {
            cart.clear();
            setClearing(false);
          }}
          onClose={() => setClearing(false)}
        />
      )}
      {heldOpen && (
        <Dialog title={t('sell.heldTitle')} hint={t('sell.heldHint')} onClose={() => setHeldOpen(false)}>
          <ul className="space-y-2">
            {cart.held.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <span className="min-w-0 text-sm">
                  <b>{formatDateTime(h.at, i18n.language)}</b>
                  <span className="block truncate text-muted">{h.lines.map((l) => l.name).join(', ')}</span>
                  <span className="font-semibold">{money(cartSubtotal(h.lines) - h.discount)}</span>
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => {
                      cart.resume(h.id);
                      setHeldOpen(false);
                    }}
                  >
                    {t('sell.resume')}
                  </Button>
                  <Button className="text-danger" onClick={() => cart.dropHeld(h.id)} aria-label={t('common.delete')}>
                    <Trash2 size={15} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${active ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-card text-muted hover:text-ink'}`}
    >
      {children}
    </button>
  );
}
