// The phone without the PC: reads from its own copy, changes through the outbox, and the sync when the PC is back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { getState, init, reconnect, resetForTests, setNetworkKindForTests } from './connection';
import { setTransport, type HttpRequest } from './http';
import type { SavedSession } from './storage';
import type { LocalDb } from '@/sync/db';
import { getEngine, stopSync, startSync, getSyncView } from '@/sync/runtime';
import { getRow, setState, upsertRow, setDebt } from '@/sync/store';
import { memoryDb } from '@/sync/testDb';

const store: { session: SavedSession | null } = { session: null };
vi.mock('./storage', () => ({
  loadSession: async () => store.session,
  saveSession: async (s: SavedSession) => void (store.session = s),
  clearSession: async () => void (store.session = null),
  loadLanguage: async () => 'en',
  saveLanguage: async () => undefined,
}));

const saved: SavedSession = { serverId: 'S1', host: '192.168.1.20', port: 4780, token: 'tok', deviceId: 'ab12cd34', deviceName: 'Phone', hosts: ['192.168.1.20'], storeName: 'Shop' };
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, deletedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: 'x', ...extra });

let db: LocalDb;
let pcUp: boolean;
let pushes: { ops: { type: string; payload: Record<string, unknown> }[] }[];
let asked: unknown[];

async function seed(lastSync = new Date().toISOString()): Promise<void> {
  await db.batch([
    upsertRow('categories', row('cat', { name: 'Chargeurs', kind: 'ACCESSORY' })),
    upsertRow('products', row('item-1', { kind: 'ITEM', name: 'Chargeur', categoryId: 'cat', quantity: 10, salePrice: 100_000, minPrice: 0, lowStockThreshold: 2 })),
    upsertRow('customers', row('cust-1', { name: 'Walid', phone: '0550000000', whatsapp: '' })),
    setDebt('cust-1', 40_000),
    setState('last_sync_at', lastSync),
    setState('role', 'SELLER'),
    setState('employee_id', ''),
  ]);
}

beforeEach(async () => {
  store.session = { ...saved };
  resetForTests();
  setNetworkKindForTests(async () => 'cellular');
  db = await memoryDb();
  pcUp = false;
  pushes = [];
  asked = [];
  await startSync({ database: db, deviceId: 'ab12cd34', hasRoute: () => getState().phase === 'connected' && getState().route !== 'none', onRevoked: async () => undefined, call: async (channel, input) => {
    const { callChannel, lanBase } = await import('./client');
    return callChannel({ base: lanBase(saved.host, saved.port), token: 'tok' }, channel, input);
  } });
  setTransport(async (req: HttpRequest) => {
    if (!pcUp) throw new Error('unreachable');
    const url = new URL(req.url);
    if (url.pathname === '/hello') return { status: 200, data: { app: 'PSM', serverId: 'S1', storeName: 'Shop', appVersion: '1', apiVersion: 1, apk: null } };
    if (url.pathname === '/me') return { status: 200, data: { ok: true, data: { id: 'd1', name: 'Phone', role: 'SELLER', employeeId: null, remote: { writes: true } } } };
    if (url.pathname === '/api/sync.push') {
      const body = req.body as { ops: { opId: string; type: string; payload: Record<string, unknown> }[] };
      pushes.push(body);
      return { status: 200, data: { ok: true, data: { results: body.ops.map((o, i) => ({ opId: o.opId, status: 'applied', reason: null, result: { saleId: `real-${i}`, receiptNumber: `2026-00000${i + 1}` } })) } } };
    }
    if (url.pathname === '/api/sync.pull') return { status: 200, data: { ok: true, data: { cursor: 8, reset: false, more: false, tables: { products: [{ id: 'item-1', kind: 'ITEM', name: 'Chargeur', categoryId: 'cat', quantity: 7, salePrice: 100_000, deletedAt: null }] }, deletes: {}, debts: [], limits: { maxStaleDays: 7, maxOutbox: 500, serverTime: '' } } } };
    if (url.pathname === '/api/sales.get') {
      asked.push(req.body);
      return { status: 200, data: { ok: true, data: { id: 'real-0', receiptNumber: '2026-000001' } } };
    }
    return { status: 200, data: { ok: true, data: [] } };
  });
});
afterEach(async () => {
  await stopSync(false);
  resetForTests();
  setTransport(null);
  setNetworkKindForTests(null);
  vi.useRealTimers();
});

describe('the phone without the PC', () => {
  it('stays usable from its own copy: "connected" with no route, reads answered locally', async () => {
    await seed();
    await init();
    expect(getState()).toMatchObject({ phase: 'connected', route: 'none', role: 'SELLER' });
    const items = await api('items.list', {});
    expect(items).toMatchObject([{ name: 'Chargeur', quantity: 10, categoryName: 'Chargeurs', isLow: false }]);
    expect(await api('customers.list')).toMatchObject([{ name: 'Walid', balance: 40_000 }]);
    expect(await api('stock.lookup', { code: 'nothing' })).toBeNull();
  });

  it('without any local copy it still shows "not connected"', async () => {
    await init();
    expect(getState().phase).toBe('offline');
  });

  it('a sale goes through the outbox: it shows at once with a temporary number, and the stock goes down', async () => {
    await seed();
    await init();
    const made = await api('sales.create', { paid: 100_000, paymentMethod: 'CASH', requestId: 'r-0000001', lines: [{ productId: 'item-1', quantity: 2, unitPrice: 100_000 }] });
    expect(made.receiptNumber).toBe('T-AB12-1');
    expect((await api('items.list', {}))[0].quantity).toBe(8);
    const receipt = await api('sales.get', { id: made.id });
    expect(receipt).toMatchObject({ receiptNumber: 'T-AB12-1', total: 200_000, paid: 100_000, remaining: 100_000 });
    await vi.waitFor(() => expect(getSyncView().pending).toBe(1));
    expect([...getSyncView().waiting]).toContain(made.id);
  });

  it('says plainly what needs the shop PC', async () => {
    await seed();
    await init();
    for (const channel of ['purchases.create', 'returns.create', 'overview.get', 'stockCount.start', 'repairs.printSlip'] as const) {
      await expect((api as (c: string, i: unknown) => Promise<unknown>)(channel, {})).rejects.toMatchObject({ code: 'needs_shop_pc' });
    }
  });

  it('a phone 8 days out of date refuses a new sale and says why', async () => {
    await seed(new Date(Date.now() - 8 * 86_400_000).toISOString());
    await init();
    await expect(api('sales.create', { paid: 100_000, paymentMethod: 'CASH', requestId: 'r-0000002', lines: [{ productId: 'item-1', quantity: 1, unitPrice: 100_000 }] })).rejects.toMatchObject({ code: 'offline_too_old' });
    expect((await api('items.list', {}))[0].quantity).toBe(10);
  });

  it('when the PC comes back the outbox is sent and the copy is refreshed, without anyone pressing anything', async () => {
    await seed();
    await init();
    const made = await api('sales.create', { paid: 100_000, paymentMethod: 'CASH', requestId: 'r-0000003', lines: [{ productId: 'item-1', quantity: 3, unitPrice: 100_000 }] });
    await vi.waitFor(() => expect(getSyncView().pending).toBe(1));
    pcUp = true;
    await reconnect();
    await vi.waitFor(async () => expect((await getEngine()!.status()).pending).toBe(0));
    expect(getState()).toMatchObject({ phase: 'connected', route: 'lan' });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].ops[0]).toMatchObject({ type: 'sale' });
    // The temporary id still works for the screen that holds it: it is swapped for the real one before the PC is asked.
    const receipt = await api('sales.get', { id: made.id });
    expect(asked).toEqual([{ id: 'real-0' }]);
    expect(receipt).toMatchObject({ receiptNumber: '2026-000001' });
    expect((await getRow(db, 'products', 'item-1'))?.quantity).toBe(7); // the PC's number, from the pull
  });
});
