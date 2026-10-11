// The stand-alone edition on the web side: the first choice, the "local" route, the manager password and the way out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: kv.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void kv.set(key, value),
    remove: async ({ key }: { key: string }) => void kv.delete(key),
  },
}));
const store: { session: unknown } = { session: null };
vi.mock('./storage', () => ({
  loadSession: async () => store.session,
  saveSession: async (s: unknown) => void (store.session = s),
  clearSession: async () => void (store.session = null),
  loadLanguage: async () => 'en',
  saveLanguage: async () => undefined,
}));

const { api, ApiError } = await import('./api');
const { chooseMode, getState, init, moveToShopPc, resetApp, resetForTests } = await import('./connection');
const { setCoreForTests } = await import('./standalone');
const { answerUnlock, requestUnlock, unlockRequested } = await import('./unlock');

interface Call {
  channel: string;
  payload: string;
}
let calls: Call[];
let started: number;
let wiped: number;
let locked: boolean;
let startFails = false;

beforeEach(() => {
  kv.clear();
  store.session = null;
  calls = [];
  started = 0;
  wiped = 0;
  locked = false;
  startFails = false;
  resetForTests();
  setCoreForTests({
    start: async () => {
      started++;
      return { result: JSON.stringify(startFails ? { ok: false, error: { code: 'io', params: {} } } : { ok: true, data: null }) };
    },
    run: async ({ channel, payload }) => {
      calls.push({ channel, payload });
      if (channel === 'auth.unlock') {
        locked = false;
        return { result: JSON.stringify({ ok: true, data: null }) };
      }
      if (channel === 'finance.summary' && locked) return { result: JSON.stringify({ ok: false, error: { code: 'locked', params: {} } }) };
      if (channel === 'brands.create') return { result: JSON.stringify({ ok: false, error: { code: 'duplicate_name', params: { name: 'X' } } }) };
      return { result: JSON.stringify({ ok: true, data: channel === 'brands.list' ? [{ id: 'b1', name: 'Samsung' }] : { netProfit: 1 } }) };
    },
    exportBackup: async () => ({ result: '{"ok":true,"data":null}', path: '/cache/x.zip' }),
    restoreBackup: async () => ({ cancelled: true }),
    lastExported: async () => ({ value: '' }),
    wipe: async () => {
      wiped++;
      return { result: '{"ok":true,"data":null}' };
    },
    shareFile: async () => undefined,
    shareBase64: async () => undefined,
  });
});
afterEach(() => {
  setCoreForTests(null);
  resetForTests();
});

describe('the first choice', () => {
  it('asks when nothing is saved: no mode, not paired', async () => {
    await init();
    expect(getState()).toMatchObject({ phase: 'unpaired', mode: null });
    expect(started).toBe(0);
  });

  it('"Use this phone alone" starts the core, opens the app as the owner on the local route, and is remembered', async () => {
    await init();
    await chooseMode('standalone');
    expect(getState()).toMatchObject({ phase: 'connected', mode: 'standalone', route: 'local', role: 'OWNER', remoteWrites: true });
    expect(kv.get('mode')).toBe('standalone');
    resetForTests();
    await init(); // the next launch goes straight in
    expect(getState()).toMatchObject({ phase: 'connected', route: 'local', mode: 'standalone' });
    expect(started).toBe(2);
  });

  it('"Connect to my shop PC" keeps the pairing flow and starts no core', async () => {
    await init();
    await chooseMode('connected');
    expect(getState()).toMatchObject({ phase: 'unpaired', mode: 'connected' });
    expect(started).toBe(0);
  });

  it('shows "not connected" with the reason when the core cannot start', async () => {
    startFails = true;
    await init();
    await chooseMode('standalone');
    expect(getState()).toMatchObject({ phase: 'offline', offlineReason: 'io' });
  });
});

describe('the local route', () => {
  beforeEach(async () => {
    await init();
    await chooseMode('standalone');
  });

  it('answers the same channels with the same data, as JSON through the plugin', async () => {
    expect(await api('brands.list')).toEqual([{ id: 'b1', name: 'Samsung' }]);
    expect(calls.at(-1)).toEqual({ channel: 'brands.list', payload: 'null' });
    await api('customers.create', { name: 'Walid', phone: '' } as never);
    expect(JSON.parse(calls.at(-1)!.payload)).toEqual({ name: 'Walid', phone: '' });
  });

  it('turns an error envelope into an ApiError with its code and params', async () => {
    await expect(api('brands.create', { name: 'X' })).rejects.toMatchObject({ code: 'duplicate_name', params: { name: 'X' } });
    await expect(api('brands.create', { name: 'X' })).rejects.toBeInstanceOf(ApiError);
  });

  it('never goes near the network: no sync, no route search', async () => {
    const { networkFailed } = await import('./connection');
    networkFailed();
    expect(getState()).toMatchObject({ phase: 'connected', route: 'local' });
  });

  it('asks for the manager password on a protected section, then makes the call again', async () => {
    locked = true;
    const pending = api('finance.summary', { from: 'a', to: 'b' } as never);
    await vi.waitFor(() => expect(unlockRequested()).toBe(true));
    answerUnlockWhenAsked();
    await expect(pending).resolves.toEqual({ netProfit: 1 });
    expect(calls.filter((c) => c.channel === 'finance.summary')).toHaveLength(2);
  });

  it('gives up cleanly when the password is not given', async () => {
    locked = true;
    const pending = api('finance.summary', { from: 'a', to: 'b' } as never);
    await vi.waitFor(() => expect(unlockRequested()).toBe(true));
    answerUnlock(false);
    await expect(pending).rejects.toMatchObject({ code: 'locked' });
  });
});

/** The unlock sheet unlocks through the core, then answers the request. */
function answerUnlockWhenAsked(): void {
  void (async () => {
    const { runLocal } = await import('./standalone');
    await runLocal('auth.unlock', { password: 'secret' });
    answerUnlock(true);
  })();
}

describe('leaving stand-alone mode', () => {
  it('moving to a shop PC erases this phone s own data and goes to pairing', async () => {
    await init();
    await chooseMode('standalone');
    await moveToShopPc();
    expect(wiped).toBe(1);
    expect(getState()).toMatchObject({ phase: 'unpaired', mode: 'connected', route: 'none' });
    expect(kv.get('mode')).toBe('connected');
  });

  it('"Reset app" forgets the choice, so the first screen asks again', async () => {
    store.session = { serverId: 'S', host: '1.2.3.4', port: 1, token: 't', deviceName: 'P', hosts: [], storeName: 'S' };
    kv.set('mode', 'connected');
    setCoreForTests(null);
    await resetApp();
    expect(getState()).toMatchObject({ phase: 'unpaired', mode: null });
    expect(kv.get('mode')).toBeUndefined();
    expect(store.session).toBeNull();
  });

  it('unlock requests are answered once', async () => {
    const first = requestUnlock();
    const second = requestUnlock();
    answerUnlock(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });
});
