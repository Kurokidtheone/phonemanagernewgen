import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { init, resetForTests } from './connection';
import { setTransport } from './http';
import { addGroup, addImei, newDraft, toPurchaseInput } from './receive';

vi.mock('./storage', () => ({
  loadSession: async () => ({ serverId: 'S1', host: '192.168.1.20', port: 4780, token: 'tok', deviceName: 'P', hosts: [], storeName: 'Shop' }),
  saveSession: async () => undefined,
  clearSession: async () => undefined,
  loadLanguage: async () => 'en',
  saveLanguage: async () => undefined,
}));

beforeEach(() => resetForTests());
afterEach(() => {
  resetForTests();
  setTransport(null);
});

it('a failed save keeps the draft as it was, and the retry carries the same request id', async () => {
  let down = false;
  const bodies: { requestId: string; phoneLines: unknown[] }[] = [];
  let saved = 0;
  setTransport(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/hello') return { status: 200, data: { app: 'PSM', serverId: 'S1', storeName: 'Shop', appVersion: '1', apiVersion: 1 } };
    if (path === '/me') return { status: 200, data: { ok: true, data: { id: 'd', name: 'P', role: 'STOCK', employeeId: null } } };
    if (down) throw new Error('lost');
    if (path === '/api/purchases.create') {
      bodies.push(req.body as { requestId: string; phoneLines: unknown[] });
      saved += 1;
      return { status: 200, data: { ok: true, data: { id: 'purchase-1' } } };
    }
    return { status: 200, data: { ok: true, data: [] } };
  });
  await init();

  const { draft: d0, id } = addGroup({ ...newDraft(), supplierId: 's1' }, { productId: 'm1', label: 'A15', condition: 'NEW', cost: 100, salePrice: 200 });
  const draft = addImei(d0, id, '350000000000001');
  const before = JSON.stringify(draft);

  down = true;
  await expect(api('purchases.create', toPurchaseInput(draft) as never)).rejects.toMatchObject({ code: 'network' });
  expect(JSON.stringify(draft)).toBe(before); // nothing scanned is lost
  expect(saved).toBe(0);

  down = false;
  await api('purchases.create', toPurchaseInput(draft) as never);
  await api('purchases.create', toPurchaseInput(draft) as never); // a double tap
  expect(bodies).toHaveLength(2);
  expect(new Set(bodies.map((b) => b.requestId)).size).toBe(1); // the PC saves the first and ignores the second
  expect(bodies[0].phoneLines).toHaveLength(1);
});
