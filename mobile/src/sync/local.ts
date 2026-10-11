// Reads from the phone's own copy, answering the same channels as the PC with the same row shapes, so no screen has to
// know where its data came from. Only what the phone can do offline is here: everything else needs the shop PC.
import type { LocalDb } from './db';
import type { LocalSale } from './effects';
import { allDebts, allRows, getRow, getState, type Row } from './store';

/** Channels the local copy can answer. */
export const LOCAL_READS = new Set([
  'brands.list',
  'categories.list',
  'models.list',
  'units.list',
  'units.get',
  'items.list',
  'items.get',
  'customers.list',
  'customer.list',
  'employees.list',
  'stock.lookup',
  'stock.search',
  'repairs.list',
  'sales.get',
  'cash.state',
]);

/** The operations a phone can make without the PC: each one becomes an op in the outbox. */
type WriteSpec = { type: 'sale' | 'stock_add_unit' | 'stock_add_item' | 'price_change' | 'customer_create' | 'customer_payment' | 'repair_create' | 'repair_status'; payload?: (input: Record<string, unknown>) => Record<string, unknown> };
export const OFFLINE_WRITES: Record<string, WriteSpec> = {
  'sales.create': { type: 'sale' },
  'units.add': { type: 'stock_add_unit' },
  'items.create': { type: 'stock_add_item' },
  'customers.create': { type: 'customer_create' },
  'customer.create': { type: 'customer_create' },
  'customer.receivePayment': { type: 'customer_payment' },
  'repairs.create': { type: 'repair_create' },
  'repairs.setStatus': { type: 'repair_status' },
  'units.setPrice': { type: 'price_change', payload: (i) => ({ target: 'unit', id: i.id, salePrice: i.salePrice }) },
};

export class NeedsPcError extends Error {
  constructor() {
    super('needs_shop_pc');
  }
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const live = (rows: Row[]): Row[] => rows.filter((r) => !r.deletedAt);
const byName = (a: Row, b: Row): number => s(a.name).localeCompare(s(b.name));

export async function lastUpdated(db: LocalDb): Promise<string | null> {
  return getState(db, 'last_sync_at');
}

export async function readLocal(db: LocalDb, channel: string, input: unknown): Promise<unknown> {
  const arg = (input ?? {}) as Record<string, unknown>;
  const [products, brands, categories] = await Promise.all([allRows(db, 'products'), allRows(db, 'brands'), allRows(db, 'categories')]);
  const brandName = (id: unknown): string | null => (id ? s(brands.find((b) => b.id === id)?.name) || null : null);
  const categoryName = (id: unknown): string => s(categories.find((c) => c.id === id)?.name);

  const itemRow = (p: Row) => ({
    id: p.id, name: s(p.name), categoryId: s(p.categoryId), categoryName: categoryName(p.categoryId), brandId: (p.brandId as string | null) ?? null, brandName: brandName(p.brandId), barcode: (p.barcode as string | null) ?? null,
    quantity: n(p.quantity), avgCost: typeof p.avgCost === 'number' ? p.avgCost : null, salePrice: n(p.salePrice), minPrice: n(p.minPrice), lowStockThreshold: n(p.lowStockThreshold),
    defaultWarrantyDays: n(p.defaultWarrantyDays), isRepairPart: !!p.isRepairPart, isLow: n(p.lowStockThreshold) > 0 && n(p.quantity) <= n(p.lowStockThreshold),
  });
  const unitRow = (u: Row) => {
    const m = products.find((p) => p.id === u.productId);
    const stocked = s(u.createdAt);
    return {
      id: u.id, productId: s(u.productId), brandId: (m?.brandId as string | null) ?? null, brandName: brandName(m?.brandId), name: s(m?.name), model: s(m?.model), storage: s(m?.storage), color: s(m?.color),
      imei1: (u.imei1 as string | null) ?? null, imei2: (u.imei2 as string | null) ?? null, condition: s(u.condition) || 'NEW', batteryHealth: (u.batteryHealth as number | null) ?? null, grade: (u.grade as string | null) ?? null,
      cost: typeof u.cost === 'number' ? u.cost : null, salePrice: n(u.salePrice), minPrice: n(m?.minPrice), defaultWarrantyDays: n(m?.defaultWarrantyDays), status: s(u.status) || 'IN_STOCK', notes: s(u.notes), stockedAt: stocked,
      ageDays: stocked ? Math.max(0, Math.floor((Date.now() - new Date(stocked).getTime()) / 86_400_000)) : 0,
    };
  };

  switch (channel) {
    case 'brands.list':
      return [...brands].sort(byName);
    case 'categories.list':
      return [...categories].sort(byName);
    case 'models.list':
      return live(products)
        .filter((p) => p.kind === 'PHONE_MODEL')
        .sort(byName)
        .map((p) => ({ id: p.id, brandId: (p.brandId as string | null) ?? null, brandName: brandName(p.brandId), name: s(p.name), model: s(p.model), storage: s(p.storage), color: s(p.color), salePrice: n(p.salePrice), minPrice: n(p.minPrice), avgCost: typeof p.avgCost === 'number' ? p.avgCost : null }));
    case 'items.list':
      return live(products)
        .filter((p) => p.kind === 'ITEM')
        .map(itemRow)
        .filter((i) => !arg.lowStockOnly || i.isLow)
        .filter((i) => !arg.categoryId || i.categoryId === arg.categoryId)
        .sort((a, b) => a.name.localeCompare(b.name));
    case 'items.get': {
      const p = products.find((x) => x.id === arg.id && x.kind === 'ITEM');
      if (!p) throw new NeedsPcError();
      return itemRow(p);
    }
    case 'units.list': {
      const rows = live(await allRows(db, 'phone_units')).map(unitRow);
      return rows.filter((u) => (!arg.status || u.status === arg.status) && (!arg.brandId || u.brandId === arg.brandId) && (!arg.condition || u.condition === arg.condition));
    }
    case 'units.get': {
      const u = await getRow(db, 'phone_units', s(arg.id));
      if (!u) throw new NeedsPcError();
      return { ...unitRow(u), timeline: [] };
    }
    case 'customers.list': {
      const debts = await allDebts(db);
      return live(await allRows(db, 'customers')).sort(byName).map((c) => ({ ...c, balance: debts.get(c.id) ?? 0 }));
    }
    case 'customer.list': {
      const debts = await allDebts(db);
      let rows = live(await allRows(db, 'customers')).map((c) => ({ id: c.id, name: s(c.name), phone: s(c.phone), whatsapp: s(c.whatsapp), totalBought: 0, balance: debts.get(c.id) ?? 0, lastVisit: null, oldestUnpaid: null, overdue: false }));
      if (arg.inDebt) rows = rows.filter((c) => c.balance > 0);
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    case 'employees.list':
      return live(await allRows(db, 'employees')).sort(byName).map((e) => ({ ...e, phone: '', monthlySalary: 0, commissionSalesBp: 0, commissionRepairsBp: 0 }));
    case 'stock.lookup': {
      const code = s(arg.code).trim();
      const item = live(products).find((p) => p.kind === 'ITEM' && p.barcode === code);
      if (item) return { type: 'item', id: item.id };
      const unit = live(await allRows(db, 'phone_units')).find((u) => u.imei1 === code || u.imei2 === code);
      return unit ? { type: 'unit', id: unit.id } : null;
    }
    case 'stock.search': {
      const q = s(arg.q).toLowerCase();
      const units = live(await allRows(db, 'phone_units')).map(unitRow).filter((u) => u.status === 'IN_STOCK' && `${u.name} ${u.model} ${u.brandName ?? ''} ${u.imei1 ?? ''} ${u.imei2 ?? ''}`.toLowerCase().includes(q));
      const items = live(products).filter((p) => p.kind === 'ITEM').map(itemRow).filter((i) => `${i.name} ${i.barcode ?? ''} ${i.brandName ?? ''}`.toLowerCase().includes(q));
      return { units: units.slice(0, 30), items: items.slice(0, 30) };
    }
    case 'repairs.list': {
      const customers = await allRows(db, 'customers');
      const employees = await allRows(db, 'employees');
      return (await allRows(db, 'repairs'))
        .filter((r) => !arg.status || r.status === arg.status)
        .sort((a, b) => s(b.receivedAt).localeCompare(s(a.receivedAt)))
        .map((r) => {
          const c = customers.find((x) => x.id === r.customerId);
          return {
            id: r.id, ticketNumber: s(r.ticketNumber), status: s(r.status), customerId: s(r.customerId), customerName: s(c?.name), customerPhone: s(c?.phone), brand: s(r.brand), model: s(r.model), imei: (r.imei as string | null) ?? null,
            fault: s(r.fault), receivedAt: s(r.receivedAt), dueAt: (r.dueAt as string | null) ?? null, deliveredAt: (r.deliveredAt as string | null) ?? null, estimatedPrice: n(r.estimatedPrice), finalPrice: (r.finalPrice as number | null) ?? null,
            employeeId: (r.employeeId as string | null) ?? null, technicianName: s(employees.find((e) => e.id === r.employeeId)?.name) || null, paid: n(r.deposit), overdue: false,
          };
        });
    }
    case 'sales.get': {
      const rows = await db.all<{ json: string }>('SELECT json FROM local_sales WHERE id = ?', [s(arg.id)]);
      if (!rows[0]) throw new NeedsPcError();
      const sale = JSON.parse(rows[0].json) as LocalSale;
      return {
        id: sale.id, receiptNumber: sale.receiptNumber, date: sale.date, subtotal: sale.total, discount: 0, total: sale.total, paid: sale.paid, tradeInValue: 0, paymentMethod: 'CASH', status: 'COMPLETED', customerId: sale.customerId,
        customerName: sale.customerName, customerPhone: sale.customerPhone, customerWhatsapp: sale.customerWhatsapp, employeeName: null, remaining: sale.remaining, returnedValue: 0, returns: [],
        lines: sale.lines.map((l) => ({ ...l, unitPrice: l.lineTotal, discount: 0, returnedQuantity: 0 })), payments: [], tradeIn: null, profit: null, waiting: sale.waiting, tempReceipt: sale.tempReceipt,
      };
    }
    case 'cash.state':
      return { open: true, sessionId: null, lastCounted: 0 };
    default:
      throw new NeedsPcError();
  }
}
