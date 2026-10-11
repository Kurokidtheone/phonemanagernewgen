// What an operation does to the phone's own copy, the moment it is made: the phone shows as sold, the quantity goes
// down. Each effect also records how to undo itself, for an op the PC does not apply (conflict or rejected).
import type { LocalDb, Statement } from './db';
import { getDebt, getRow, removeRow, setDebt, upsertRow, uuid, type Row } from './store';

export type OpType = 'sale' | 'stock_add_unit' | 'stock_add_item' | 'price_change' | 'customer_create' | 'customer_payment' | 'repair_create' | 'repair_status';
export const OP_TYPES: readonly OpType[] = ['sale', 'stock_add_unit', 'stock_add_item', 'price_change', 'customer_create', 'customer_payment', 'repair_create', 'repair_status'];

/** One thing to put back: a mirror row (or its absence), a customer's debt, or a local sale. */
export type Undo = { tbl: string; id: string; before: Row | null } | { debt: string; before: number } | { localSale: string };

/** A line for the "Not sent" list and the waiting marks. */
export interface Summary {
  kind: OpType;
  /** Plain text of what it was: "Sale T-AB12-3", "Customer Nadia". */
  label: string;
  amount?: number;
}

export interface Effect {
  statements: Statement[];
  undo: Undo[];
  summary: Summary;
  /** Temporary ids this op created (replaced by the real ones after the push). */
  tempIds: string[];
  /** What the screen gets back at once. */
  result: Record<string, unknown>;
}

export interface EffectContext {
  now: string;
  /** Next temporary receipt number ("T-AB12-3"), used for a sale. */
  receiptNumber: () => Promise<string>;
}

class Recorder {
  statements: Statement[] = [];
  undo: Undo[] = [];
  private seen = new Map<string, Row | null>();
  private debts = new Map<string, number>();
  constructor(private db: LocalDb) {}

  async get(tbl: string, id: string): Promise<Row | null> {
    const key = `${tbl}:${id}`;
    if (this.seen.has(key)) return this.seen.get(key) ?? null;
    return getRow(this.db, tbl, id);
  }
  async put(tbl: string, row: Row): Promise<void> {
    const key = `${tbl}:${row.id}`;
    if (!this.seen.has(key)) this.undo.push({ tbl, id: row.id, before: await getRow(this.db, tbl, row.id) });
    this.seen.set(key, row);
    this.statements.push(upsertRow(tbl, row));
  }
  async debt(customerId: string): Promise<number> {
    return this.debts.get(customerId) ?? getDebt(this.db, customerId);
  }
  async setDebt(customerId: string, balance: number): Promise<void> {
    if (!this.debts.has(customerId)) this.undo.push({ debt: customerId, before: await getDebt(this.db, customerId) });
    this.debts.set(customerId, balance);
    this.statements.push(setDebt(customerId, balance));
  }
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

interface SaleLine {
  unitId?: string;
  productId?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
}

/** The local sale record shown on the receipt screen (same fields as the PC's sale detail that the phone reads). */
export interface LocalSale {
  id: string;
  receiptNumber: string;
  tempReceipt: string;
  date: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerWhatsapp: string | null;
  lines: { name: string; storage: string; color: string; imei1: string | null; quantity: number; lineTotal: number }[];
  total: number;
  paid: number;
  remaining: number;
  /** Still waiting for the PC to number it. */
  waiting: boolean;
}

export async function buildEffect(db: LocalDb, type: OpType, p: Record<string, unknown>, ctx: EffectContext): Promise<Effect> {
  const rec = new Recorder(db);
  const finish = (summary: Summary, tempIds: string[], result: Record<string, unknown>): Effect => ({ statements: rec.statements, undo: rec.undo, summary, tempIds, result });

  switch (type) {
    case 'sale': {
      const lines = (p.lines as SaleLine[] | undefined) ?? [];
      const tempId = str(p.tempId) || uuid();
      const receipt = str(p.tempReceipt) || (await ctx.receiptNumber());
      const detail: LocalSale['lines'] = [];
      let subtotal = 0;
      for (const l of lines) {
        const qty = num(l.quantity, 1);
        const lineTotal = num(l.unitPrice) * qty - num(l.discount);
        subtotal += lineTotal;
        if (l.unitId) {
          const unit = await rec.get('phone_units', l.unitId);
          const model = unit ? await rec.get('products', str(unit.productId)) : null;
          if (unit) await rec.put('phone_units', { ...unit, status: 'SOLD', updatedAt: ctx.now });
          detail.push({ name: str(model?.name), storage: str(model?.storage), color: str(model?.color), imei1: unit ? ((unit.imei1 as string | null) ?? null) : null, quantity: 1, lineTotal });
        } else if (l.productId) {
          const item = await rec.get('products', l.productId);
          // May go below zero: the PC allows it for an offline sale and flags it.
          if (item) await rec.put('products', { ...item, quantity: num(item.quantity) - qty, updatedAt: ctx.now });
          detail.push({ name: str(item?.name), storage: '', color: '', imei1: null, quantity: qty, lineTotal });
        }
      }
      const total = subtotal - num(p.discount);
      const paid = num(p.paid);
      const customerId = (p.customerId as string | null | undefined) ?? null;
      const customer = customerId ? await rec.get('customers', customerId) : null;
      if (customerId && total - paid > 0) await rec.setDebt(customerId, (await rec.debt(customerId)) + (total - paid));
      const local: LocalSale = {
        id: tempId,
        receiptNumber: receipt,
        tempReceipt: receipt,
        date: ctx.now,
        customerId,
        customerName: customer ? str(customer.name) : null,
        customerPhone: customer ? str(customer.phone) : null,
        customerWhatsapp: customer ? str(customer.whatsapp) : null,
        lines: detail,
        total,
        paid,
        remaining: Math.max(0, total - paid),
        waiting: true,
      };
      rec.undo.push({ localSale: tempId });
      rec.statements.push({ sql: 'INSERT OR REPLACE INTO local_sales (id, json) VALUES (?, ?)', params: [tempId, JSON.stringify(local)] });
      return finish({ kind: type, label: receipt, amount: total }, [tempId], { id: tempId, receiptNumber: receipt, creditUsed: 0 });
    }

    case 'stock_add_unit': {
      const unitId = str(p.tempId) || uuid();
      let productId = str(p.productId);
      const tempIds = [unitId];
      if (!productId) {
        const m = (p.model as { brandId?: string | null; name?: string; model?: string; storage?: string; color?: string } | undefined) ?? {};
        // The same model if the phone already knows it, otherwise a model of its own (replaced after the push).
        const known = (await allProducts(db)).find((r) => r.kind === 'PHONE_MODEL' && r.name === m.name && str(r.storage) === str(m.storage) && str(r.color) === str(m.color) && (r.brandId ?? null) === (m.brandId ?? null));
        if (known) productId = known.id;
        else {
          productId = str(p.tempProductId) || uuid();
          tempIds.push(productId);
          await rec.put('products', {
            id: productId, kind: 'PHONE_MODEL', brandId: m.brandId ?? null, categoryId: '', name: str(m.name), model: str(m.model), storage: str(m.storage), color: str(m.color), barcode: null,
            salePrice: num(p.salePrice), minPrice: num(p.minPrice), quantity: 0, lowStockThreshold: 0, isRepairPart: 0, defaultWarrantyDays: 0, deletedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
          });
        }
      }
      await rec.put('phone_units', {
        id: unitId, productId, imei1: str(p.imei1), imei2: (p.imei2 as string | null) ?? null, condition: str(p.condition, 'NEW'), batteryHealth: (p.batteryHealth as number | null) ?? null, grade: (p.grade as string | null) ?? null,
        cost: num(p.cost), salePrice: num(p.salePrice), status: 'IN_STOCK', notes: str(p.notes), deletedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
      });
      return finish({ kind: type, label: str(p.imei1) }, tempIds, { id: unitId, productId });
    }

    case 'stock_add_item': {
      const id = str(p.tempId) || uuid();
      await rec.put('products', {
        id, kind: 'ITEM', brandId: (p.brandId as string | null) ?? null, categoryId: str(p.categoryId), name: str(p.name), model: '', storage: '', color: '', barcode: (p.barcode as string | null) ?? null,
        salePrice: num(p.salePrice), minPrice: num(p.minPrice), avgCost: num(p.avgCost), quantity: 0, lowStockThreshold: num(p.lowStockThreshold), isRepairPart: p.isRepairPart ? 1 : 0, defaultWarrantyDays: num(p.defaultWarrantyDays),
        deletedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
      });
      return finish({ kind: type, label: str(p.name) }, [id], { id });
    }

    case 'price_change': {
      const tbl = p.target === 'unit' ? 'phone_units' : 'products';
      const row = await rec.get(tbl, str(p.id));
      if (row) await rec.put(tbl, { ...row, salePrice: num(p.salePrice), updatedAt: ctx.now });
      return finish({ kind: type, label: row ? str(row.name) || str(row.imei1) : str(p.id), amount: num(p.salePrice) }, [], {});
    }

    case 'customer_create': {
      const id = str(p.tempId) || uuid();
      await rec.put('customers', { id, name: str(p.name), phone: str(p.phone), whatsapp: str(p.whatsapp), address: str(p.address), notes: str(p.notes), deletedAt: null, createdAt: ctx.now, updatedAt: ctx.now });
      return finish({ kind: type, label: str(p.name) }, [id], { id, name: str(p.name), phone: str(p.phone), whatsapp: str(p.whatsapp), balance: 0 });
    }

    case 'customer_payment': {
      const customerId = str(p.customerId);
      const before = await rec.debt(customerId);
      const amount = num(p.amount);
      await rec.setDebt(customerId, Math.max(0, before - amount));
      const customer = await rec.get('customers', customerId);
      return finish({ kind: type, label: str(customer?.name), amount }, [], { groupId: uuid(), before, after: Math.max(0, before - amount), applied: [], credit: Math.max(0, amount - before) });
    }

    case 'repair_create': {
      const id = str(p.tempId) || uuid();
      const customer = await rec.get('customers', str(p.customerId));
      const ticket = str(p.tempTicket) || (await ctx.receiptNumber()).replace(/^T-/, 'TR-');
      await rec.put('repairs', {
        id, ticketNumber: ticket, customerId: str(p.customerId), employeeId: (p.employeeId as string | null) ?? null, brand: str(p.brand), model: str(p.model), imei: (p.imei as string | null) ?? null, fault: str(p.fault),
        status: 'RECEIVED', receivedAt: ctx.now, dueAt: (p.dueAt as string | null) ?? null, deliveredAt: null, estimatedPrice: num(p.estimatedPrice), finalPrice: null, deposit: num(p.deposit), createdAt: ctx.now, updatedAt: ctx.now,
      });
      return finish({ kind: type, label: `${str(p.brand)} ${str(p.model)} · ${str(customer?.name)}`.trim() }, [id], { id, ticketNumber: ticket, qrToken: '' });
    }

    case 'repair_status': {
      const row = await rec.get('repairs', str(p.id));
      if (row) await rec.put('repairs', { ...row, status: str(p.status), updatedAt: ctx.now });
      return finish({ kind: type, label: `${str(row?.ticketNumber)} → ${str(p.status)}` }, [], {});
    }
  }
}

async function allProducts(db: LocalDb): Promise<Row[]> {
  return (await db.all<{ json: string }>("SELECT json FROM mirror WHERE tbl = 'products'")).map((r) => JSON.parse(r.json) as Row);
}

/** The statements that put the phone's copy back as it was before an op that the PC did not apply. */
export function undoStatements(undo: Undo[]): Statement[] {
  const out: Statement[] = [];
  for (const u of [...undo].reverse()) {
    if ('localSale' in u) out.push({ sql: 'DELETE FROM local_sales WHERE id = ?', params: [u.localSale] });
    else if ('debt' in u) out.push(setDebt(u.debt, u.before));
    else out.push(u.before ? upsertRow(u.tbl, u.before) : removeRow(u.tbl, u.id));
  }
  return out;
}

/** Which temporary id became which real id, from the PC's answer for an op. */
export function idMapFrom(type: OpType, result: Record<string, unknown>, payload: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  const set = (temp: unknown, real: unknown): void => {
    if (typeof temp === 'string' && typeof real === 'string' && temp !== real) map[temp] = real;
  };
  switch (type) {
    case 'sale':
      set(payload.tempId, result.saleId);
      break;
    case 'stock_add_unit':
      set(payload.tempId, result.unitId);
      set(payload.tempProductId, result.productId);
      break;
    case 'stock_add_item':
      set(payload.tempId, result.itemId);
      break;
    case 'customer_create':
      set(payload.tempId, result.customerId);
      break;
    case 'repair_create':
      set(payload.tempId, result.repairId);
      break;
    default:
      break;
  }
  return map;
}
