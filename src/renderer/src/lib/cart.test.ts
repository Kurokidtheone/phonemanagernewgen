import { beforeEach, describe, expect, it } from 'vitest';
import { useCart, type CartLine } from '@/lib/cart';

// The till's cart is kept in the window, apart from the database. After a backup restore or a new
// database, its lines would point at units and products that may not exist: reset forgets them.
const phone: Omit<CartLine, 'key'> = {
  unitId: 'unit-1', productId: 'model-1', name: 'Galaxy A25', imei: '350212001158382', quantity: 1,
  available: null, unitPrice: 4_100_000, minPrice: 0, discount: 0, warrantyDays: 365,
};
const caseItem: Omit<CartLine, 'key'> = { ...phone, unitId: null, productId: 'case-1', name: 'Coque', imei: null, available: 10, unitPrice: 60_000 };

describe('the till cart', () => {
  beforeEach(() => useCart.getState().reset());

  it('takes a phone unit once, and counts an accessory up', () => {
    const cart = useCart.getState();
    expect(cart.addLine(phone)).toBe('added');
    expect(cart.addLine(phone)).toBe('duplicate');
    cart.addLine(caseItem);
    cart.addLine(caseItem);
    expect(useCart.getState().lines.map((l) => [l.name, l.quantity])).toEqual([['Galaxy A25', 1], ['Coque', 2]]);
  });

  it('reset forgets the cart, the held sales and an exchange in progress', () => {
    const cart = useCart.getState();
    cart.addLine(phone);
    cart.hold();
    cart.addLine(caseItem);
    cart.setDiscount(10_000);
    cart.setExchange({ saleId: 's1', receipt: '2026-000001', customerId: null, reason: '', lines: [], credit: 0 });
    expect(useCart.getState().held).toHaveLength(1);

    useCart.getState().reset();
    const after = useCart.getState();
    expect([after.lines, after.held, after.discount, after.exchange]).toEqual([[], [], 0, null]);
  });

  it('clear empties the screen but keeps the held sales', () => {
    const cart = useCart.getState();
    cart.addLine(phone);
    cart.hold();
    cart.addLine(caseItem);
    useCart.getState().clear();
    expect([useCart.getState().lines.length, useCart.getState().held.length]).toEqual([0, 1]);
  });
});
