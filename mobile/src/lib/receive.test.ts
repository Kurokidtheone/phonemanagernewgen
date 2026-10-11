import { describe, expect, it } from 'vitest';
import { addGroup, addImei, addItem, draftTotal, hasImei, isEmpty, newDraft, phoneCount, removeImei, toPurchaseInput, withoutEmptyGroups } from './receive';

const group = { productId: 'm1', label: 'Galaxy A15', condition: 'NEW' as const, cost: 4_000_000, salePrice: 6_000_000 };

describe('the receive draft', () => {
  it('turns each scanned IMEI into a line with the prices typed once', () => {
    const { draft: d0, id } = addGroup(newDraft(), group);
    const d = ['350000000000001', '350000000000002', '350000000000003'].reduce((acc, imei) => addImei(acc, id, imei), d0);
    expect(phoneCount(d)).toBe(3);
    const input = toPurchaseInput(d);
    expect(input.phoneLines).toHaveLength(3);
    expect(input.phoneLines.every((l) => l.cost === 4_000_000 && l.salePrice === 6_000_000 && l.productId === 'm1' && l.condition === 'NEW')).toBe(true);
    expect(draftTotal(d)).toBe(12_000_000);
  });

  it('refuses the same IMEI twice, even in another model group', () => {
    const { draft: d0, id } = addGroup(newDraft(), group);
    const d1 = addImei(d0, id, '350000000000001');
    const { draft: d2, id: other } = addGroup(d1, { ...group, productId: 'm2' });
    expect(hasImei(d2, '350000000000001')).toBe(true);
    expect(() => addImei(d2, other, '350000000000001')).toThrowError('duplicate');
  });

  it('adds accessories to the total, merging the same item at the same cost', () => {
    let d = addItem(newDraft(), { productId: 'i1', name: 'Chargeur', quantity: 5, unitCost: 50_000 });
    d = addItem(d, { productId: 'i1', name: 'Chargeur', quantity: 3, unitCost: 50_000 });
    d = addItem(d, { productId: 'i1', name: 'Chargeur', quantity: 1, unitCost: 60_000 });
    expect(d.items.map((l) => l.quantity)).toEqual([8, 1]);
    expect(draftTotal(d)).toBe(8 * 50_000 + 60_000);
    expect(toPurchaseInput(d).itemLines).toHaveLength(2);
  });

  it('removes an IMEI and drops empty groups when reviewing', () => {
    const { draft: d0, id } = addGroup(newDraft(), group);
    const d = removeImei(addImei(d0, id, '350000000000001'), '350000000000001');
    expect(isEmpty(d)).toBe(true);
    expect(withoutEmptyGroups(d).phones).toEqual([]);
  });

  it('keeps one request id for the whole draft, so a retry is the same purchase', () => {
    const { draft: d0, id } = addGroup({ ...newDraft(), supplierId: 's1', paid: 100 }, group);
    const d = addImei(d0, id, '350000000000001');
    const first = toPurchaseInput(d, new Date('2026-01-01T10:00:00Z'));
    const retry = toPurchaseInput(d, new Date('2026-01-01T10:05:00Z'));
    expect(retry.requestId).toBe(first.requestId);
    expect(first.requestId.length).toBeGreaterThanOrEqual(8);
    expect(newDraft().requestId).not.toBe(d.requestId);
    expect(first).toMatchObject({ supplierId: 's1', paid: 100 });
  });
});
