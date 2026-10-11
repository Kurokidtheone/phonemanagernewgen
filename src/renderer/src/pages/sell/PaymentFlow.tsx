import { useQuery } from '@tanstack/react-query';
import { Smartphone, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/Dialog';
import { Button, Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { belowMinimum, cartSubtotal, useCart } from '@/lib/cart';
import { useAction, useAuth, useMoney, useSettings } from '@/lib/hooks';
import { ReceiptDialog } from './ReceiptDialog';
import { TradeInDialog, type TradeIn } from './TradeInDialog';

const METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;
const ROUND_STEPS_DA = [100, 500, 1000, 5000];
const SELLER_KEY = 'psm-seller';
const readSeller = (): string => {
  try {
    return localStorage.getItem(SELLER_KEY) ?? '';
  } catch {
    return '';
  }
};

/**
 * Payment, then receipt. The amount field starts at the exact total, so F2 then Enter completes a
 * cash sale. "Received" can exceed the total (the change is shown); only what is due is paid.
 */
export function PaymentFlow({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const cart = useCart();
  const hasPassword = useAuth().data?.hasPassword ?? false;
  const askSeller = useSettings().data?.askSeller ?? false;
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api('customers.list') });
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api('employees.list') });

  const exchange = cart.exchange;
  const [customerId, setCustomerId] = useState<string | null>(exchange?.customerId ?? null);
  const [search, setSearch] = useState('');
  // With "ask for the seller on every sale" nothing is remembered: the seller is chosen each time.
  const [employeeId, setEmployeeId] = useState(() => (askSeller ? '' : readSeller()));
  const [received, setReceived] = useState<number | null>(null); // null = exactly what is due
  const [round, setRound] = useState(0);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [tradeIn, setTradeIn] = useState<TradeIn | null>(null);
  const [password, setPassword] = useState('');
  const [sub, setSub] = useState<'trade' | 'customer' | null>(null);
  const [soldId, setSoldId] = useState<string | null>(null);

  const subtotal = cartSubtotal(cart.lines);
  const net = subtotal - cart.discount - (tradeIn?.value ?? 0);
  // In an exchange the returned value pays first; only the difference is collected (or paid back).
  const credit = exchange ? Math.min(exchange.credit, Math.max(0, net)) : 0;
  const cashBack = exchange ? exchange.credit - credit : 0;
  const due = Math.max(0, net) - credit;
  const got = received ?? due;
  const paid = Math.min(got, due);
  const change = Math.max(0, got - due);
  const remaining = due - paid;
  const customer = customers.data?.find((c) => c.id === customerId);
  const needsCustomer = remaining > 0 || !!tradeIn;
  const needsOverride = cart.lines.some(belowMinimum);
  const valid = net >= 0 && (!askSeller || !!employeeId) && (!needsCustomer || !!customerId) && (!needsOverride || !hasPassword || !!password);

  const matches = (customers.data ?? []).filter((c) => !search.trim() || `${c.name} ${c.phone}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 5);
  const roundUps = [...new Set(ROUND_STEPS_DA.map((s) => Math.ceil(due / (s * 100)) * s * 100).filter((v) => v > due))];

  const save = useAction(
    () => {
      try {
        localStorage.setItem(SELLER_KEY, employeeId);
      } catch {
        /* the seller is only a convenience */
      }
      const sale = {
        customerId,
        employeeId: employeeId || null,
        discount: cart.discount,
        paid,
        paymentMethod: method,
        lines: cart.lines.map((l) => ({ unitId: l.unitId ?? undefined, productId: l.unitId ? undefined : l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, warrantyDays: l.warrantyDays })),
        tradeIn: tradeIn?.input ?? null,
        managerPassword: needsOverride && password ? password : undefined,
      };
      if (!exchange) return api('sales.create', sale);
      return api('returns.create', { saleId: exchange.saleId, reason: exchange.reason, lines: exchange.lines, exchange: sale }).then((r) => r.exchange!);
    },
    {
      success: t('sell.saved'),
      invalidate: [['units'], ['items'], ['models'], ['sales'], ['customers'], ['customer'], ['returns']],
      onDone: (sale) => {
        cart.clear();
        setSoldId(sale.id);
      },
    },
  );

  if (soldId) return <ReceiptDialog saleId={soldId} justSold onClose={onClose} />;

  return (
    <>
      <Dialog wide title={t('sell.paymentTitle')} onClose={() => !sub && onClose()} onSubmit={() => valid && save.mutate(undefined)} submitLabel={t('sell.complete')} busy={save.isPending || !valid}>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-xl bg-paper p-3 text-sm">
          <dt className="text-muted">{t('sell.subtotal')}</dt>
          <dd className="text-end">{money(subtotal)}</dd>
          {cart.discount > 0 && (
            <>
              <dt className="text-muted">{t('sell.discount')}</dt>
              <dd className="text-end">-{money(cart.discount)}</dd>
            </>
          )}
          {tradeIn && (
            <>
              <dt className="text-muted">{t('sell.tradeIn')}: {tradeIn.label}</dt>
              <dd className="text-end">-{money(tradeIn.value)}</dd>
            </>
          )}
          {credit > 0 && (
            <>
              <dt className="text-muted">{t('sell.exchange.credit')}</dt>
              <dd className="text-end">-{money(credit)}</dd>
            </>
          )}
          <dt className="text-lg font-bold">{exchange ? t('sell.exchange.difference') : t('sell.total')}</dt>
          <dd className="text-end text-lg font-bold text-accent">{money(due)}</dd>
          {cashBack > 0 && (
            <>
              <dt className="text-muted">{t('sell.exchange.cashBack')}</dt>
              <dd className="text-end font-semibold">{money(cashBack)}</dd>
            </>
          )}
        </dl>
        {net < 0 && <p className="text-sm text-danger">{t('errors.trade_in_exceeds_total')}</p>}

        <div className="grid grid-cols-2 gap-4">
          <Field label={t('sell.amountReceived')}>
            <MoneyInput key={`r${round}${due}`} autoFocus value={got} onChange={(v) => setReceived(v ?? 0)} />
          </Field>
          <Field label={t('sell.method')}>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`sell.methods.${m}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setReceived(null);
              setRound((r) => r + 1);
            }}
          >
            {t('sell.exact')}
          </Button>
          {roundUps.map((v) => (
            <Button
              key={v}
              onClick={() => {
                setReceived(v);
                setRound((r) => r + 1);
              }}
            >
              {money(v)}
            </Button>
          ))}
          <span className="ms-auto text-sm">
            {change > 0 && (
              <>
                {t('sell.change')}: <b>{money(change)}</b>
              </>
            )}
          </span>
        </div>
        <p className={`text-lg font-bold ${remaining > 0 ? 'text-danger' : 'text-ok'}`}>
          {t('sell.remaining')}: {money(remaining)}
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t('sell.customer')} error={needsCustomer && !customerId ? t(tradeIn ? 'sell.customerForTradeIn' : 'sell.customerForDebt') : undefined}>
            {customer ? (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                <span>
                  <b>{customer.name}</b> <span className="text-muted">{customer.phone}</span>
                  {customer.balance > 0 && <span className="block text-danger">{t('sell.owes', { amount: money(customer.balance) })}</span>}
                </span>
                <button type="button" className="rounded-md p-1 text-muted hover:bg-paper" aria-label={t('common.remove')} onClick={() => setCustomerId(null)}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div>
                <div className="flex gap-2">
                  <Input
                    value={search}
                    placeholder={t('sell.customerSearch')}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter picks the only match instead of completing the sale.
                      if (e.key === 'Enter' && search.trim()) {
                        e.preventDefault();
                        if (matches.length === 1) setCustomerId(matches[0].id);
                      }
                    }}
                  />
                  <Button icon={UserPlus} onClick={() => setSub('customer')} aria-label={t('sell.newCustomer')} />
                </div>
                {search.trim() && (
                  <ul className="mt-1 rounded-lg border border-line">
                    {matches.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="flex w-full justify-between px-3 py-1.5 text-start text-sm hover:bg-paper" onClick={() => setCustomerId(c.id)}>
                          <span>{c.name}</span>
                          <span className="text-muted" dir="ltr">{c.phone}</span>
                        </button>
                      </li>
                    ))}
                    {matches.length === 0 && <li className="px-3 py-1.5 text-sm text-muted">{t('common.noMatch')}</li>}
                  </ul>
                )}
              </div>
            )}
          </Field>
          <Field label={t('sell.seller')} required={askSeller} error={askSeller && !employeeId ? t('sell.sellerRequired') : undefined}>
            <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">{askSeller ? t('sell.chooseSeller') : t('sell.noSeller')}</option>
              {employees.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button icon={tradeIn ? X : Smartphone} onClick={() => (tradeIn ? (setTradeIn(null), setReceived(null)) : setSub('trade'))}>
            {tradeIn ? t('sell.removeTradeIn') : t('sell.addTradeIn')}
          </Button>
        </div>

        {needsOverride && (
          <div className="rounded-xl border border-danger/40 bg-danger/5 p-3">
            <p className="mb-2 text-sm font-semibold text-danger">{t('sell.overrideNeeded')}</p>
            {hasPassword ? (
              <Field label={t('lock.password')} required>
                <Input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
              </Field>
            ) : (
              <p className="text-sm text-muted">{t('sell.overrideNoPassword')}</p>
            )}
          </div>
        )}
      </Dialog>
      {sub === 'trade' && (
        <TradeInDialog
          onClose={() => setSub(null)}
          onSave={(t2) => {
            setTradeIn(t2);
            setReceived(null);
            setSub(null);
          }}
        />
      )}
      {sub === 'customer' && <CustomerDialog onClose={() => setSub(null)} onCreated={(id) => (setCustomerId(id), setSub(null))} />}
    </>
  );
}

function CustomerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const save = useAction(() => api('customers.create', { name, phone, whatsapp: '', address: '', notes: '' }), {
    success: t('sell.customerSaved'),
    invalidate: [['customers']],
    onDone: (c) => onCreated(c.id),
  });
  return (
    <Dialog title={t('sell.newCustomer')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !name.trim()}>
      <Field label={t('sell.customerName')} required>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('sell.customerPhone')}>
        <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
    </Dialog>
  );
}

