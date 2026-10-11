// The sale in progress on the phone: scanned phones and accessories, the customer and the payment.
// Every change gives the cart a new request id; a pure retry keeps it. The PC sells once per id.
import { uuid } from './receive';

export interface CartLine {
  /** unit id for a phone, product id for an accessory */
  id: string;
  kind: 'unit' | 'item';
  name: string;
  imei: string | null;
  /** Centimes per unit. */
  unitPrice: number;
  minPrice: number;
  quantity: number;
  /** Accessories: what is in stock. */
  available: number;
}
export interface Cart {
  requestId: string;
  lines: CartLine[];
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  paid: number | null;
  method: 'CASH' | 'CCP' | 'BARIDIMOB' | 'OTHER';
}

export const newCart = (): Cart => ({ requestId: uuid(), lines: [], customerId: null, customerName: '', customerPhone: '', paid: null, method: 'CASH' });

const touch = (c: Cart, patch: Partial<Cart>): Cart => ({ ...c, ...patch, requestId: uuid() });

export const cartTotal = (c: Cart): number => c.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
export const hasUnit = (c: Cart, id: string): boolean => c.lines.some((l) => l.kind === 'unit' && l.id === id);
export const cartCount = (c: Cart): number => c.lines.reduce((n, l) => n + l.quantity, 0);

export class CartError extends Error {
  constructor(public code: 'duplicate' | 'stock') {
    super(code);
  }
}

export function addUnit(c: Cart, line: Omit<CartLine, 'kind' | 'quantity' | 'available'>): Cart {
  if (hasUnit(c, line.id)) throw new CartError('duplicate');
  return touch(c, { lines: [...c.lines, { ...line, kind: 'unit', quantity: 1, available: 1 }] });
}

/** Scanning the same accessory again adds one more, up to what is in stock. */
export function addItem(c: Cart, line: Omit<CartLine, 'kind' | 'quantity'>): Cart {
  const same = c.lines.find((l) => l.kind === 'item' && l.id === line.id);
  if (same) return setQuantity(c, same.id, same.quantity + 1);
  if (line.available < 1) throw new CartError('stock');
  return touch(c, { lines: [...c.lines, { ...line, kind: 'item', quantity: 1 }] });
}

export function setQuantity(c: Cart, id: string, quantity: number): Cart {
  const line = c.lines.find((l) => l.kind === 'item' && l.id === id);
  if (!line) return c;
  if (quantity > line.available) throw new CartError('stock');
  if (quantity < 1) return remove(c, id);
  return touch(c, { lines: c.lines.map((l) => (l === line ? { ...l, quantity } : l)) });
}

/** The price can go down to the minimum price, never below, and never to nothing. */
export const clampPrice = (line: CartLine, price: number): number => Math.max(price, line.minPrice, 1);
export const setPrice = (c: Cart, id: string, price: number): Cart => touch(c, { lines: c.lines.map((l) => (l.id === id ? { ...l, unitPrice: clampPrice(l, price) } : l)) });
export const remove = (c: Cart, id: string): Cart => touch(c, { lines: c.lines.filter((l) => l.id !== id) });
export const setCustomer = (c: Cart, customer: { id: string; name: string; phone: string } | null): Cart =>
  touch(c, { customerId: customer?.id ?? null, customerName: customer?.name ?? '', customerPhone: customer?.phone ?? '' });
export const setPayment = (c: Cart, patch: { paid?: number | null; method?: Cart['method'] }): Cart => touch(c, patch);

export const remaining = (c: Cart): number => Math.max(0, cartTotal(c) - (c.paid ?? cartTotal(c)));
/** Fully paid unless the seller typed a smaller amount. */
export const amountPaid = (c: Cart): number => Math.min(c.paid ?? cartTotal(c), cartTotal(c));
export const needsCustomer = (c: Cart): boolean => amountPaid(c) < cartTotal(c);

/** The body of the sales.create channel: the same sale service the desktop uses. */
export function toSaleInput(c: Cart) {
  return {
    customerId: c.customerId,
    paid: amountPaid(c),
    paymentMethod: c.method,
    requestId: c.requestId,
    lines: c.lines.map((l) => (l.kind === 'unit' ? { unitId: l.id, unitPrice: l.unitPrice } : { productId: l.id, quantity: l.quantity, unitPrice: l.unitPrice })),
  };
}
