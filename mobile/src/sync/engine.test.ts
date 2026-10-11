import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDb } from './db';
import { SyncEngine, SyncError, type Call, type CallResult } from './engine';
import { getRow, getState, upsertRow, setState, setDebt, allRows } from './store';
import { memoryDb } from './testDb';

const DEVICE = 'ab12cd34-0000-4000-8000-000000000000';

/** A stand-in for the PC: applies each op once per op id (like applied_ops), maps temporary ids, and can be told to refuse. */
class FakePc {
  applied = new Map<string, { status: string; reason?: string; result?: Record<string, unknown> }>();
  ids = new Map<string, string>();
  received: { opId: string; type: string; payload: Record<string, unknown> }[] = [];
  pushes = 0;
  pulls = 0;
  receiptCounter = 0;
  down = false;
  revoked = false;
  conflictFor: (op: { type: string; payload: Record<string, unknown> }) => string | null = () => null;
  pages: unknown[] = [];

  call: Call = async (channel, input) => {
    if (this.down) throw new Error('unreachable');
    if (this.revoked) return { ok: false, error: { code: 'device_revoked' } };
    if (channel === 'sync.push') return this.push(input as { ops: { opId: string; type: string; payload: Record<string, unknown> }[] });
    if (channel === 'sync.pull') {
      this.pulls++;
      const page = this.pages.shift() ?? { cursor: 1, reset: false, more: false, tables: {}, deletes: {}, debts: [], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } };
      return { ok: true, data: page };
    }
    return { ok: false, error: { code: 'forbidden' } };
  };

  private remap<T>(v: T): T {
    return JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' && this.ids.has(x) ? this.ids.get(x) : x)) as T;
  }

  private push(input: { ops: { opId: string; type: string; payload: Record<string, unknown> }[] }): CallResult {
    this.pushes++;
    const results = input.ops.map((op) => {
      const payload = this.remap(op.payload);
      this.received.push({ opId: op.opId, type: op.type, payload });
      const stored = this.applied.get(op.opId);
      if (stored) return { opId: op.opId, ...stored };
      const conflict = this.conflictFor({ type: op.type, payload });
      let outcome: { status: string; reason?: string; result?: Record<string, unknown> };
      if (conflict) outcome = { status: 'conflict', reason: conflict };
      else outcome = { status: 'applied', result: this.apply(op.type, payload) };
      this.applied.set(op.opId, outcome);
      return { opId: op.opId, ...outcome };
    });
    return { ok: true, data: { results } };
  }

  private apply(type: string, p: Record<string, unknown>): Record<string, unknown> {
    const real = (): string => `real-${this.ids.size + 1}`;
    const map = (temp: unknown, id: string): string => {
      if (typeof temp === 'string') this.ids.set(temp, id);
      return id;
    };
    switch (type) {
      case 'sale': {
        this.receiptCounter++;
        return { saleId: map(p.tempId, real()), receiptNumber: `2026-${String(this.receiptCounter).padStart(6, '0')}` };
      }
      case 'customer_create':
        return { customerId: map(p.tempId, real()), reused: false };
      case 'stock_add_item':
        return { itemId: map(p.tempId, real()) };
      case 'stock_add_unit':
        return { unitId: map(p.tempId, real()), productId: map(p.tempProductId, real()) };
      case 'repair_create':
        return { repairId: map(p.tempId, real()), ticketNumber: 'R-0001' };
      default:
        return {};
    }
  }
}

interface Rig {
  db: LocalDb;
  pc: FakePc;
  engine: SyncEngine;
  clock: { now: Date };
  revokedCalls: number;
}

async function rig(): Promise<Rig> {
  const db = await memoryDb();
  const pc = new FakePc();
  const clock = { now: new Date('2026-10-10T10:00:00.000Z') };
  const r = { db, pc, clock, revokedCalls: 0 } as Rig;
  r.engine = new SyncEngine({ db, call: (channel, input) => pc.call(channel, input), deviceId: DEVICE, now: () => clock.now, onRevoked: () => void r.revokedCalls++ });
  return r;
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, deletedAt: null, createdAt: 'x', updatedAt: 'x', ...extra });

/** A phone that has pulled once: a phone model, one unit in stock, an accessory with 10, a customer. */
async function seed(r: Rig, over: { last?: string } = {}): Promise<void> {
  await r.db.batch([
    upsertRow('products', row('model-1', { kind: 'PHONE_MODEL', name: 'Galaxy A15', storage: '128GB', color: 'Noir', brandId: 'b1', salePrice: 6_000_000 })),
    upsertRow('phone_units', row('unit-1', { productId: 'model-1', imei1: '350000000000014', status: 'IN_STOCK', salePrice: 6_000_000 })),
    upsertRow('products', row('item-1', { kind: 'ITEM', name: 'Chargeur', quantity: 10, salePrice: 100_000 })),
    upsertRow('customers', row('cust-1', { name: 'Walid', phone: '0550000000', whatsapp: '' })),
    setDebt('cust-1', 50_000),
    setState('last_sync_at', over.last ?? r.clock.now.toISOString()),
    setState('cursor', '5'),
  ]);
}

const sale = (over: Record<string, unknown> = {}) => ({ paid: 100_000, customerId: null, lines: [{ productId: 'item-1', quantity: 1, unitPrice: 100_000 }], ...over });
const qty = async (r: Rig): Promise<number> => Number((await getRow(r.db, 'products', 'item-1'))?.quantity);

let r: Rig;
beforeEach(async () => {
  r = await rig();
  await seed(r);
});

describe('making an operation offline', () => {
  it('shows its effect on the local copy at once and queues it with a temporary receipt number', async () => {
    const out = await r.engine.enqueue('sale', sale({ lines: [{ unitId: 'unit-1', unitPrice: 6_000_000 }, { productId: 'item-1', quantity: 2, unitPrice: 100_000 }], paid: 6_200_000 }));
    expect(out.result).toMatchObject({ receiptNumber: 'T-AB12-1', creditUsed: 0 });
    expect((await getRow(r.db, 'phone_units', 'unit-1'))?.status).toBe('SOLD');
    expect(await qty(r)).toBe(8);
    const second = await r.engine.enqueue('sale', sale());
    expect(second.result.receiptNumber).toBe('T-AB12-2');
    expect(await r.engine.status()).toMatchObject({ pending: 2, notSent: 0 });
    const waiting = await r.engine.waitingIds();
    expect(waiting.has(String(out.result.id))).toBe(true);
  });

  it('a credit sale raises the customer s debt, and a payment lowers it', async () => {
    await r.engine.enqueue('sale', sale({ customerId: 'cust-1', paid: 0 }));
    expect((await r.engine.debts()).get('cust-1')).toBe(150_000);
    await r.engine.enqueue('customer_payment', { customerId: 'cust-1', amount: 70_000, method: 'CASH' });
    expect((await r.engine.debts()).get('cust-1')).toBe(80_000);
  });

  it('a new customer, a new accessory, a new phone with a new model and a repair all appear locally', async () => {
    const c = await r.engine.enqueue('customer_create', { name: 'Nadia', phone: '0661000000' });
    const i = await r.engine.enqueue('stock_add_item', { name: 'Coque', categoryId: 'cat', salePrice: 50_000 });
    const u = await r.engine.enqueue('stock_add_unit', { imei1: '350000000000022', condition: 'NEW', cost: 1, salePrice: 2, minPrice: 1, model: { brandId: 'b1', name: 'Redmi', storage: '64GB', color: 'Bleu' } });
    const rep = await r.engine.enqueue('repair_create', { customerId: c.result.id, brand: 'Samsung', model: 'A15', fault: 'Screen', estimatedPrice: 400_000 });
    expect(await getRow(r.db, 'customers', String(c.result.id))).toMatchObject({ name: 'Nadia' });
    expect(await getRow(r.db, 'products', String(i.result.id))).toMatchObject({ name: 'Coque', quantity: 0 });
    expect(await getRow(r.db, 'phone_units', String(u.result.id))).toMatchObject({ status: 'IN_STOCK' });
    expect((await allRows(r.db, 'products')).some((p) => p.name === 'Redmi' && p.kind === 'PHONE_MODEL')).toBe(true);
    expect(await getRow(r.db, 'repairs', String(rep.result.id))).toMatchObject({ status: 'RECEIVED' });
    await r.engine.enqueue('repair_status', { id: rep.result.id, status: 'DIAGNOSING' });
    expect((await getRow(r.db, 'repairs', String(rep.result.id)))?.status).toBe('DIAGNOSING');
    await r.engine.enqueue('price_change', { target: 'item', id: 'item-1', salePrice: 120_000 });
    expect((await getRow(r.db, 'products', 'item-1'))?.salePrice).toBe(120_000);
  });
});

describe('limits', () => {
  it('refuses new offline work when the last sync is more than 7 days old', async () => {
    r.clock.now = new Date('2026-10-18T10:00:01.000Z'); // 8 days later
    await expect(r.engine.enqueue('sale', sale())).rejects.toMatchObject({ code: 'offline_too_old' });
    r.clock.now = new Date('2026-10-17T09:00:00.000Z'); // just under 7 days
    await expect(r.engine.enqueue('sale', sale())).resolves.toBeTruthy();
    expect(await qty(r)).toBe(9); // the refused one changed nothing
  });

  it('uses the limit the PC sent with the pull', async () => {
    await r.db.batch([setState('max_stale_days', '2')]);
    r.clock.now = new Date('2026-10-13T10:00:00.000Z');
    await expect(r.engine.enqueue('sale', sale())).rejects.toMatchObject({ code: 'offline_too_old', params: { days: 2 } });
  });

  it('refuses more than 500 waiting ops, and work before the first sync', async () => {
    await r.db.batch([setState('max_outbox', '3')]);
    for (let i = 0; i < 3; i++) await r.engine.enqueue('price_change', { target: 'item', id: 'item-1', salePrice: 100_000 + i });
    await expect(r.engine.enqueue('price_change', { target: 'item', id: 'item-1', salePrice: 1 })).rejects.toMatchObject({ code: 'outbox_full' });
    const fresh = await rig();
    await expect(fresh.engine.enqueue('sale', sale())).rejects.toBeInstanceOf(SyncError);
    await expect(fresh.engine.enqueue('sale', sale())).rejects.toMatchObject({ code: 'not_synced_yet' });
  });
});

describe('syncing', () => {
  it('pushes in order, gives final receipt numbers, and clears the waiting marks', async () => {
    const a = await r.engine.enqueue('sale', sale());
    const b = await r.engine.enqueue('sale', sale());
    expect(await r.engine.sync()).toBe('done');
    expect(r.pc.received.map((x) => x.type)).toEqual(['sale', 'sale']);
    const local = await r.db.all<{ json: string }>('SELECT json FROM local_sales ORDER BY json');
    const numbers = local.map((x) => JSON.parse(x.json) as { receiptNumber: string; tempReceipt: string; waiting: boolean });
    expect(numbers.map((n) => n.receiptNumber).sort()).toEqual(['2026-000001', '2026-000002']);
    expect(numbers.every((n) => !n.waiting && n.tempReceipt.startsWith('T-AB12-'))).toBe(true); // the temporary number stays
    expect((await r.engine.status()).pending).toBe(0);
    expect((await r.engine.waitingIds()).size).toBe(0);
    expect(a.opId).not.toBe(b.opId);
    expect(await getState(r.db, 'last_sync_at')).toBe(r.clock.now.toISOString());
  });

  it('an unreachable PC leaves everything queued, and the retry sends the same ids so nothing is doubled', async () => {
    const out = await r.engine.enqueue('sale', sale());
    r.pc.down = true;
    expect(await r.engine.sync()).toBe('unreachable');
    expect((await r.engine.status()).pending).toBe(1);
    expect(await qty(r)).toBe(9);
    r.pc.down = false;
    await r.engine.sync();
    await r.engine.sync();
    expect((await r.engine.status()).pending).toBe(0);
    expect(r.pc.applied.size).toBe(1);
    expect(r.pc.receiptCounter).toBe(1);
    expect(out.opId).toBe(r.pc.received[0].opId);
  });

  it('a push that was applied but whose answer was lost is sent again and applied once', async () => {
    await r.engine.enqueue('sale', sale());
    // The answer never arrives (airplane mode): the PC applied it, the phone does not know.
    const real = r.pc.call;
    r.pc.call = async (channel, input) => {
      const res = await real(channel, input);
      if (channel === 'sync.push') throw new Error('connection lost');
      return res;
    };
    expect(await r.engine.sync()).toBe('unreachable');
    r.pc.call = real;
    expect(await r.engine.sync()).toBe('done');
    expect(r.pc.receiptCounter).toBe(1);
    expect((await r.engine.status()).pending).toBe(0);
  });

  it('sends batches of 50 and later ops follow the real ids of earlier ones', async () => {
    const c = await r.engine.enqueue('customer_create', { name: 'Nadia', phone: '0661000000' });
    for (let i = 0; i < 55; i++) await r.engine.enqueue('sale', sale({ customerId: c.result.id }));
    expect(await r.engine.sync()).toBe('done');
    expect(r.pc.pushes).toBeGreaterThanOrEqual(2);
    const last = r.pc.received.at(-1)!;
    expect(last.payload.customerId).toBe('real-1'); // the temporary id never reached the PC in the last batch
  });

  it('a conflict puts the local copy back and lists the op as not sent', async () => {
    r.pc.conflictFor = (op) => (op.type === 'sale' ? 'imei_already_sold' : null);
    r.pc.pages = [{ cursor: 6, reset: false, more: false, tables: {}, deletes: {}, debts: [{ customerId: 'cust-1', balance: 50_000 }], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } }];
    await r.engine.enqueue('sale', sale({ lines: [{ unitId: 'unit-1', unitPrice: 6_000_000 }], paid: 0, customerId: 'cust-1' }));
    expect((await getRow(r.db, 'phone_units', 'unit-1'))?.status).toBe('SOLD');
    expect((await r.engine.debts()).get('cust-1')).toBe(6_050_000);
    await r.engine.sync();
    expect((await getRow(r.db, 'phone_units', 'unit-1'))?.status).toBe('IN_STOCK');
    expect((await r.engine.debts()).get('cust-1')).toBe(50_000);
    expect((await r.db.all('SELECT * FROM local_sales'))).toHaveLength(0);
    const notSent = await r.engine.notSent();
    expect(notSent).toHaveLength(1);
    expect(notSent[0]).toMatchObject({ status: 'CONFLICT', last_error: 'imei_already_sold', type: 'sale' });
    expect((await r.engine.status()).notSent).toBe(1);
    await r.engine.dismiss(notSent[0].op_id);
    expect((await r.engine.status()).notSent).toBe(0);
  });

  it('two syncs at once never overlap', async () => {
    await r.engine.enqueue('sale', sale());
    let inFlight = 0;
    let maxInFlight = 0;
    const real = r.pc.call;
    r.pc.call = async (channel, input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await real(channel, input);
      } finally {
        inFlight--;
      }
    };
    await Promise.all([r.engine.sync(), r.engine.sync(), r.engine.sync()]);
    expect(maxInFlight).toBe(1);
    expect(r.pc.receiptCounter).toBe(1);
  });

  it('a pull replaces the local copy with the PC s, but never while ops are waiting', async () => {
    r.pc.pages = [{ cursor: 9, reset: false, more: false, tables: { products: [{ id: 'item-1', kind: 'ITEM', name: 'Chargeur', quantity: 7, salePrice: 100_000 }] }, deletes: { customers: ['cust-1'] }, debts: [{ customerId: 'cust-1', balance: 1 }], limits: { maxStaleDays: 3, maxOutbox: 100, serverTime: '' } }];
    r.pc.down = false;
    await r.engine.sync();
    expect(await qty(r)).toBe(7);
    expect(await getRow(r.db, 'customers', 'cust-1')).toBeNull();
    expect(await getState(r.db, 'cursor')).toBe('9');
    expect(await getState(r.db, 'max_stale_days')).toBe('3');

    // An op is made while a pull is on its way: that page must not wipe its effect.
    await r.db.batch([upsertRow('products', row('item-1', { kind: 'ITEM', name: 'Chargeur', quantity: 10 })), setState('max_stale_days', '7')]);
    r.pc.pages = [{ cursor: 12, reset: false, more: false, tables: { products: [{ id: 'item-1', kind: 'ITEM', name: 'Chargeur', quantity: 99 }] }, deletes: {}, debts: [], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } }];
    const real = r.pc.call;
    let made = false;
    r.pc.call = async (channel, input) => {
      if (channel === 'sync.pull' && !made) {
        made = true;
        await r.engine.enqueue('sale', sale());
      }
      return real(channel, input);
    };
    await r.engine.sync();
    expect(await qty(r)).not.toBe(99); // the sale was pushed first, the stale page was not applied over it
  });

  it('pulls page after page until the PC says there is no more, and a reset starts over', async () => {
    const page = (cursor: number, more: boolean, rows: string[]) => ({ cursor, reset: false, more, tables: { brands: rows.map((id) => ({ id, name: id })) }, deletes: {}, debts: [], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } });
    r.pc.pages = [page(100, true, ['a']), page(200, true, ['b']), page(250, false, ['c'])];
    await r.engine.sync();
    expect(r.pc.pulls).toBe(3);
    expect((await allRows(r.db, 'brands')).map((b) => b.id).sort()).toEqual(['a', 'b', 'c']);
    expect(await getState(r.db, 'cursor')).toBe('250');

    r.pc.pulls = 0;
    r.pc.pages = [{ cursor: 0, reset: true, more: false, tables: {}, deletes: {}, debts: [], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } }, page(10, false, ['z'])];
    await r.engine.sync();
    expect((await allRows(r.db, 'brands')).map((b) => b.id)).toEqual(['z']);
    expect(await getRow(r.db, 'products', 'item-1')).toBeNull(); // the old copy is gone
  });
});

describe('protecting the local copy', () => {
  it('device_revoked wipes the database and tells the app', async () => {
    await r.engine.enqueue('sale', sale());
    r.pc.revoked = true;
    expect(await r.engine.sync()).toBe('revoked');
    expect(r.revokedCalls).toBe(1);
    for (const t of ['mirror', 'outbox', 'debts', 'sync_state', 'local_sales']) expect(await r.db.all(`SELECT * FROM ${t}`)).toHaveLength(0);
  });
});
