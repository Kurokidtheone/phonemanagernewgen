import { describe, expect, it } from 'vitest';
import { addItem, addUnit, amountPaid, CartError, cartTotal, needsCustomer, newCart, remaining, remove, setCustomer, setPayment, setPrice, setQuantity, toSaleInput } from './cart';

const phone = { id: 'u1', name: 'Galaxy A15', imei: '350000000000001', unitPrice: 6_000_000, minPrice: 5_500_000 };
const charger = { id: 'p1', name: 'Chargeur', imei: null, unitPrice: 100_000, minPrice: 80_000, available: 3 };

describe('the phone cart', () => {
  it('adds a scanned IMEI as one line and refuses the same unit twice', () => {
    const c = addUnit(newCart(), phone);
    expect(c.lines).toHaveLength(1);
    expect(() => addUnit(c, phone)).toThrowError(CartError);
  });

  it('adds an accessory barcode one more each scan, up to the stock', () => {
    let c = addItem(newCart(), charger);
    c = addItem(c, charger);
    c = addItem(c, charger);
    expect(c.lines[0].quantity).toBe(3);
    expect(() => addItem(c, charger)).toThrowError(CartError);
    expect(cartTotal(c)).toBe(300_000);
  });

  it('lets the price go down to the minimum and no lower', () => {
    const c = addUnit(newCart(), phone);
    expect(setPrice(c, 'u1', 5_800_000).lines[0].unitPrice).toBe(5_800_000);
    expect(setPrice(c, 'u1', 1).lines[0].unitPrice).toBe(5_500_000);
    expect(setPrice(c, 'u1', 9_000_000).lines[0].unitPrice).toBe(9_000_000);
  });

  it('removes a line, and an accessory quantity of 0 removes it too', () => {
    let c = addItem(addUnit(newCart(), phone), charger);
    c = remove(c, 'u1');
    expect(c.lines.map((l) => l.id)).toEqual(['p1']);
    expect(setQuantity(c, 'p1', 0).lines).toEqual([]);
  });

  it('is fully paid unless a smaller amount is typed, and then a customer is needed', () => {
    const c = addUnit(newCart(), phone);
    expect(amountPaid(c)).toBe(6_000_000);
    expect(needsCustomer(c)).toBe(false);
    const partial = setPayment(c, { paid: 4_000_000 });
    expect(remaining(partial)).toBe(2_000_000);
    expect(needsCustomer(partial)).toBe(true);
    expect(amountPaid(setPayment(c, { paid: 99_000_000 }))).toBe(6_000_000);
  });

  it('keeps its request id for a retry and takes a new one whenever anything changes', () => {
    const c = setCustomer(setPayment(addUnit(newCart(), phone), { paid: 1_000_000 }), { id: 'c1', name: 'Walid', phone: '0550' });
    const retry = toSaleInput(c);
    expect(toSaleInput(c).requestId).toBe(retry.requestId);
    expect(toSaleInput(setPayment(c, { paid: 2_000_000 })).requestId).not.toBe(retry.requestId);
    expect(toSaleInput(addItem(c, charger)).requestId).not.toBe(retry.requestId);
    expect(retry).toMatchObject({ customerId: 'c1', paid: 1_000_000, paymentMethod: 'CASH', lines: [{ unitId: 'u1', unitPrice: 6_000_000 }] });
  });
});
