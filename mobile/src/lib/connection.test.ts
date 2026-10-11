import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ApiError } from './client';
import { APP } from '@shared/app.config';
import { FakeSupabase } from '@shared/remote/fake';
import { formatPairCode, newPairCode, pairingChannel } from '@shared/remote/pairing';
import { newKey, newMailbox, openJson, sealJson, type Sealed, type WireRequest, type WireResponse } from '@shared/remote/wire';
import { endpointFor, getState, init, LAN_WATCH_MS, pair, pairRemote, reconnect, RETRY_REMOTE_MS, resetForTests, setInstalledBuild, setNetworkKindForTests } from './connection';
import { setTransport, type HttpRequest } from './http';
import { setLinkDepsForTests } from './mailbox';
import type { SavedRemote, SavedSession } from './storage';

// Preferences needs a phone: the tests keep the "saved" values in memory.
const store: { session: SavedSession | null; language: string | null } = { session: null, language: 'en' };
vi.mock('./storage', () => ({
  loadSession: async () => store.session,
  saveSession: async (s: SavedSession) => void (store.session = s),
  clearSession: async () => void (store.session = null),
  loadLanguage: async () => store.language,
  saveLanguage: async (l: string) => void (store.language = l),
}));

const saved = (over: Partial<SavedSession> = {}): SavedSession => ({ serverId: 'S1', host: '192.168.1.20', port: 4780, token: 'tok', deviceName: 'Phone', hosts: ['192.168.1.20'], storeName: 'Shop', ...over });
/** A phone that was paired in the shop and learned that outside access is on. */
const awayWithMailbox = (mode: 'full' | 'view' = 'full'): SavedSession => saved({ remote: REMOTE, remoteMode: mode });

const REMOTE: SavedRemote = { mailbox: newMailbox(), key: newKey(), deviceId: 'd1', url: 'https://fake.supabase.test', anonKey: 'anon-test-key' };

type MailboxState = 'ok' | 'shop_offline' | 'blocked' | 'down' | 'silent';
interface PcOptions {
  host?: string;
  apiVersion?: number;
  apk?: { versionName: string; versionCode: number; size: number } | null;
  role?: string | null;
  me?: { status: number; body: unknown };
  /** The shop network cannot be reached (the phone is away, or the PC is off). */
  down?: boolean;
  /** What /hello tells a phone in the shop about outside access. */
  remote?: { mode: 'off' | 'full' | 'view' };
  /** The mailbox, as the phone sees it from outside. */
  mailbox?: MailboxState;
  /** What the PC says through the mailbox about changes from outside. */
  writes?: boolean;
}

/** The shop PC, as the phone sees it: directly on the shop network, or through the encrypted mailbox (a fake Supabase). */
function pc(options: PcOptions = {}) {
  const fake = new FakeSupabase();
  const state = { host: options.host ?? '192.168.1.20', role: options.role === undefined ? 'SELLER' : options.role, down: options.down ?? false, mailbox: (options.mailbox ?? 'ok') as MailboxState, writes: options.writes ?? false, calls: [] as string[], requests: [] as HttpRequest[], sent: [] as WireRequest[], fake };
  const answer = (path: string, req: HttpRequest, via: 'lan' | 'remote') => {
    if (path === '/hello') return { status: 200, data: { app: 'PSM', serverId: 'S1', storeName: 'Shop', appVersion: '1', apiVersion: options.apiVersion ?? 1, apk: options.apk ?? null, remote: options.remote } };
    if (path === '/pair') {
      const code = (req.body as { code: string }).code;
      return code === '123456'
        ? { status: 200, data: { token: 'tok', device: { id: 'd1', name: 'Phone', role: null, employeeId: null }, remote: { ...REMOTE } } }
        : { status: 403, data: { ok: false, error: { code: 'invalid_code', params: {} } } };
    }
    // Through the mailbox the key identifies the phone; on the shop network the token does.
    if (via === 'lan' && req.headers?.Authorization !== 'Bearer tok') return { status: 401, data: { ok: false, error: { code: 'unauthorized', params: {} } } };
    if (path === '/me') return options.me ? { status: options.me.status, data: options.me.body } : { status: 200, data: { ok: true, data: { id: 'd1', name: 'Phone', role: state.role, employeeId: null, remote: { writes: state.writes } } } };
    if (!state.role) return { status: 403, data: { ok: false, error: { code: 'forbidden', params: {} } } };
    return { status: 200, data: { ok: true, data: [] } };
  };
  // The PC end of the mailbox: opens each request the moment it is stored and answers like the desktop does.
  void fake.fetch(`${fake.config.url}/rest/v1/rpc/mb_beat`, { method: 'POST', headers: { apikey: fake.config.anonKey }, body: JSON.stringify({ p_mailbox: REMOTE.mailbox, p_shop_id: 'S', p_name: 'Shop' }) });
  fake.onSend = ({ mailbox, dir, body }) => {
    if (dir !== 0 || mailbox !== REMOTE.mailbox || state.mailbox === 'silent') return;
    const req = openJson<WireRequest>(REMOTE.key, mailbox, REMOTE.deviceId, JSON.parse(body) as Sealed);
    state.sent.push(req);
    const res = answer(req.path, { url: req.path, method: req.method as 'GET' | 'POST', body: req.body, timeoutMs: 0 }, 'remote');
    const reply: WireResponse = { id: req.id, status: res.status, body: res.data };
    const sealed = sealJson(REMOTE.key, mailbox, REMOTE.deviceId, reply);
    void fake.fetch(`${fake.config.url}/rest/v1/rpc/mb_send`, { method: 'POST', headers: { apikey: fake.config.anonKey }, body: JSON.stringify({ p_mailbox: mailbox, p_dir: 1, p_body: JSON.stringify(sealed) }) });
  };
  const apply = (): void => {
    if (state.mailbox === 'shop_offline') fake.ageLastSeen(REMOTE.mailbox, 120);
    fake.offline = state.mailbox === 'down';
    fake.block(REMOTE.mailbox, state.mailbox === 'blocked');
  };
  apply();
  setLinkDepsForTests({ fetchImpl: fake.fetch, socket: fake.Socket, pollMs: 20, minBackoffMs: 20 });
  setTransport(async (req: HttpRequest) => {
    const url = new URL(req.url);
    state.requests.push(req);
    state.calls.push(`${url.host}${url.pathname}`);
    const host = url.hostname;
    if (state.down || host !== state.host) throw new Error('unreachable');
    return answer(url.pathname, req, 'lan');
  });
  return Object.assign(state, {
    /** Change what the mailbox is doing now. */
    setMailbox(next: MailboxState) {
      state.mailbox = next;
      fake.offline = false;
      fake.block(REMOTE.mailbox, false);
      fake.ageLastSeen(REMOTE.mailbox, 0);
      apply();
    },
  });
}

beforeEach(() => {
  store.session = saved();
  store.language = 'en';
  resetForTests();
  setNetworkKindForTests(async () => 'wifi');
});
afterEach(() => {
  resetForTests();
  setTransport(null);
  setLinkDepsForTests(null);
  setNetworkKindForTests(null);
  vi.useRealTimers();
});

describe('starting and resuming', () => {
  it('connects on the last host and reads the role', async () => {
    pc();
    await init();
    expect(getState()).toMatchObject({ phase: 'connected', role: 'SELLER' });
  });

  it('shows pairing when nothing is saved', async () => {
    store.session = null;
    await init();
    expect(getState().phase).toBe('unpaired');
  });

  it('finds the PC again at a new address on the same /24 and saves it', async () => {
    pc({ host: '192.168.1.57' });
    await init();
    expect(getState().phase).toBe('connected');
    expect(store.session?.host).toBe('192.168.1.57');
  });

  it('shows "not connected" when the PC cannot be found', async () => {
    pc({ down: true });
    await init();
    expect(getState().phase).toBe('offline');
    expect(store.session?.token).toBe('tok'); // still paired: it recovers by itself
  });

  it('stops with "update the app" or "update the PC app" when the API version differs', async () => {
    pc({ apiVersion: 2 });
    await init();
    expect(getState().phase).toBe('update_app');
    resetForTests();
    store.session = saved();
    pc({ apiVersion: 0 });
    await init();
    expect(getState().phase).toBe('update_pc');
  });

  it('wipes the token and returns to pairing when the device was revoked', async () => {
    pc({ me: { status: 403, body: { ok: false, error: { code: 'device_revoked', params: {} } } } });
    await init();
    expect(getState().phase).toBe('unpaired');
    expect(store.session).toBeNull();
  });
});

describe('after a network failure', () => {
  it('switches to the not-connected screen on any failed request, and recovers without pairing again', async () => {
    vi.useFakeTimers();
    const lanState = pc();
    await init();
    expect(getState().phase).toBe('connected');

    lanState.down = true; // Wi-Fi off
    await expect(api('brands.list')).rejects.toMatchObject({ code: 'network' });
    await reconnect(); // the route is looked for again; nothing answers
    expect(getState().phase).toBe('offline');

    lanState.down = false; // Wi-Fi back
    await vi.advanceTimersByTimeAsync(5000);
    expect(getState().phase).toBe('connected');
    expect(store.session?.token).toBe('tok');
  });

  it('device_revoked on an api call forgets the token', async () => {
    pc();
    await init();
    setTransport(async () => ({ status: 403, data: { ok: false, error: { code: 'device_revoked', params: {} } } }));
    await expect(api('brands.list')).rejects.toBeInstanceOf(ApiError);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(getState().phase).toBe('unpaired');
    expect(store.session).toBeNull();
  });

  it('reconnect() runs once at a time', async () => {
    const lanState = pc();
    await init();
    lanState.calls.length = 0;
    await Promise.all([reconnect(), reconnect(), reconnect()]);
    expect(lanState.calls.filter((c) => c.endsWith('/hello'))).toHaveLength(1);
  });
});

describe('pairing', () => {
  const input = { hosts: ['10.9.9.9', '192.168.1.20'], port: 4780, code: '123456', serverId: 'S1', deviceName: 'Test phone' };

  it('waits for the manager, polls until the PC stops answering forbidden, then shows the role', async () => {
    vi.useFakeTimers();
    store.session = null;
    const lanState = pc({ role: null });
    await pair(input);
    expect(getState().phase).toBe('waiting');
    expect(store.session).toMatchObject({ host: '192.168.1.20', token: 'tok', serverId: 'S1', hosts: input.hosts });

    await vi.advanceTimersByTimeAsync(2100);
    expect(getState().phase).toBe('waiting'); // still forbidden

    lanState.role = 'STOCK'; // the manager saves the device form on the PC
    await vi.advanceTimersByTimeAsync(2100);
    expect(getState()).toMatchObject({ phase: 'connected', role: 'STOCK' });
  });

  it('refuses a wrong code with the PC error', async () => {
    store.session = null;
    pc();
    await expect(pair({ ...input, code: '000000' })).rejects.toMatchObject({ code: 'invalid_code' });
    expect(store.session).toBeNull();
  });

  it('says the PC was not found when no address answers', async () => {
    store.session = null;
    pc({ down: true });
    await expect(pair(input)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a PC with another serverId', async () => {
    store.session = null;
    pc();
    await expect(pair({ ...input, serverId: 'OTHER' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('update check', () => {
  const apk = { versionName: '1.1.0', versionCode: 200, size: 5_000_000 };

  it('offers the download when the PC holds a newer APK than the installed app', async () => {
    setInstalledBuild(100);
    pc({ apk });
    await init();
    expect(getState().phase).toBe('connected');
    expect(getState().update).toEqual({ versionName: '1.1.0', url: 'http://192.168.1.20:4780/app.apk' });
  });

  it('says nothing when the app is up to date, newer, or the PC holds no APK', async () => {
    for (const [installed, held] of [[200, apk], [300, apk], [100, null]] as const) {
      resetForTests();
      store.session = saved();
      setInstalledBuild(installed);
      pc({ apk: held });
      await init();
      expect(getState().update, `${installed} vs ${held?.versionCode}`).toBeNull();
    }
  });

  it('follows the PC to its new address', async () => {
    setInstalledBuild(100);
    pc({ host: '192.168.1.57', apk });
    await init();
    expect(getState().update?.url).toBe('http://192.168.1.57:4780/app.apk');
  });
});

describe('the second route: through the mailbox', () => {
  const inShop = { mode: 'full' as const };

  it('learns in the shop that outside access is on, and keeps using the shop network', async () => {
    store.session = saved({ remote: REMOTE });
    pc({ remote: inShop });
    await init();
    expect(getState()).toMatchObject({ phase: 'connected', route: 'lan', remoteWrites: true });
    expect(store.session?.remoteMode).toBe('full');
    expect(store.session?.remote).toEqual(REMOTE); // the mailbox and key given at pairing are kept
    expect(endpointFor(store.session!, 'lan')).toEqual({ base: 'http://192.168.1.20:4780', token: 'tok' });
    expect(endpointFor(store.session!, 'remote').link).toBeTruthy();
  });

  it('forgets that outside access is on when the owner switches it off', async () => {
    store.session = awayWithMailbox();
    pc({ remote: { mode: 'off' } });
    await init();
    expect(store.session?.remoteMode).toBe('off');
    resetForTests();
    pc({ down: true });
    await init();
    expect(getState()).toMatchObject({ phase: 'offline', route: 'none' }); // off: no mailbox attempt
  });

  it('uses the shop network when the PC answers within 1.5 s, even though outside access is on', async () => {
    store.session = awayWithMailbox();
    const lan = pc({ remote: inShop });
    await init();
    expect(getState().route).toBe('lan');
    expect(lan.fake.calls.filter((c) => c.fn !== 'mb_beat')).toEqual([]); // the mailbox was never touched
  });

  it('uses the mailbox when the shop network does not answer, and tells whether changes are allowed', async () => {
    store.session = awayWithMailbox();
    pc({ down: true, writes: false });
    await init();
    expect(getState()).toMatchObject({ phase: 'connected', route: 'remote', remoteWrites: false, role: 'SELLER' });

    resetForTests();
    store.session = awayWithMailbox();
    pc({ down: true, writes: true });
    await init();
    expect(getState()).toMatchObject({ route: 'remote', remoteWrites: true });
  });

  it('on mobile data goes straight to the mailbox without searching the shop network', async () => {
    setNetworkKindForTests(async () => 'cellular');
    store.session = awayWithMailbox();
    const lan = pc({ down: true });
    await init();
    expect(getState().route).toBe('remote');
    expect(lan.calls.filter((c) => /^192\.168\./.test(c) && !c.startsWith('192.168.1.20:'))).toEqual([]); // no /24 scan
  });

  it('on Wi-Fi outside the shop it searches the network first, then falls back to the mailbox', async () => {
    store.session = awayWithMailbox();
    const lan = pc({ down: true });
    await init();
    expect(getState().route).toBe('remote');
    expect(lan.calls.filter((c) => /^192\.168\.1\./.test(c)).length).toBeGreaterThan(100);
  });

  it('screens use the same api(): a request goes out as an encrypted message, never over HTTP, and nothing readable is stored', async () => {
    store.session = awayWithMailbox();
    const away = pc({ down: true });
    await init();
    away.requests.length = 0;
    away.sent.length = 0;
    await api('brands.list');
    expect(away.requests.filter((r) => !/192\.168/.test(r.url))).toEqual([]);
    expect(away.sent.map((r) => r.path)).toEqual(['/api/brands.list']);
    const bodies = away.fake.calls.filter((c) => c.fn === 'mb_send').map((c) => String(c.args.p_body)).join('');
    expect(bodies).not.toContain('brands.list');
    expect(bodies).not.toContain('tok'); // the token is not even sent
  });

  it('shows "the shop PC is off" when it has not beaten for a minute, and recovers by itself when it is back', async () => {
    vi.useFakeTimers();
    store.session = awayWithMailbox();
    const away = pc({ down: true, mailbox: 'shop_offline' });
    await init();
    expect(getState()).toMatchObject({ phase: 'offline', offlineReason: 'shop_offline' });
    expect(away.sent).toHaveLength(0); // nothing is even sent

    away.setMailbox('ok'); // the owner opens the app on the PC
    await vi.advanceTimersByTimeAsync(RETRY_REMOTE_MS + 100);
    expect(getState()).toMatchObject({ phase: 'connected', route: 'remote', offlineReason: null });
  });

  it('notices when the PC goes off while the phone is connected through the mailbox', async () => {
    store.session = awayWithMailbox();
    const away = pc({ down: true });
    await init();
    expect(getState().route).toBe('remote');
    away.setMailbox('shop_offline');
    await expect(api('brands.list')).rejects.toMatchObject({ code: 'shop_offline' });
    await reconnect();
    expect(getState()).toMatchObject({ phase: 'offline', offlineReason: 'shop_offline' });
  });

  it('says shop_timeout when the PC is alive but does not answer in time', async () => {
    store.session = awayWithMailbox();
    const away = pc({ down: true });
    await init();
    away.setMailbox('silent');
    setLinkDepsForTests({ fetchImpl: away.fake.fetch, socket: away.fake.Socket, pollMs: 10, timeoutMs: 100 });
    store.session = awayWithMailbox();
    await expect(api('brands.list')).rejects.toMatchObject({ code: 'shop_timeout' });
    expect(getState().phase).toBe('connected'); // a slow answer does not drop the connection
  });

  it('shows a blocked shop without forgetting the pairing', async () => {
    store.session = awayWithMailbox();
    pc({ down: true, mailbox: 'blocked' });
    await init();
    expect(getState()).toMatchObject({ phase: 'offline', offlineReason: 'shop_blocked' });
    expect(store.session?.token).toBe('tok'); // still paired: it works in the shop
  });

  it('is not connected (and says nothing specific) when neither route answers', async () => {
    store.session = awayWithMailbox();
    pc({ down: true, mailbox: 'down' });
    await init();
    expect(getState()).toMatchObject({ phase: 'offline', offlineReason: null, route: 'none' });
  });

  it('without a saved mailbox behaves exactly as before: not connected', async () => {
    pc({ down: true });
    await init();
    expect(getState()).toMatchObject({ phase: 'offline', route: 'none' });
  });

  it('moves from the shop network to the mailbox when the shop network drops, without showing "not connected"', async () => {
    store.session = awayWithMailbox();
    const home = pc({ remote: inShop });
    await init();
    expect(getState().route).toBe('lan');
    const phases: string[] = [];
    home.down = true; // walked out of Wi-Fi range
    const watch = setInterval(() => phases.push(getState().phase), 1);
    await expect(api('brands.list')).rejects.toMatchObject({ code: 'network' });
    await reconnect();
    clearInterval(watch);
    expect(getState()).toMatchObject({ phase: 'connected', route: 'remote' });
    expect(phases).not.toContain('offline');
  });

  it('while outside, moves back to the shop network when it comes within reach', async () => {
    vi.useFakeTimers();
    store.session = awayWithMailbox();
    const away = pc({ down: true });
    await init();
    expect(getState().route).toBe('remote');
    away.down = false; // walked into the shop
    await vi.advanceTimersByTimeAsync(LAN_WATCH_MS + 100);
    expect(getState().route).toBe('lan');
  });

  it('pairing only ever happens on the shop network, and keeps the mailbox and key it is given there', async () => {
    store.session = null;
    pc({ down: true });
    await expect(pair({ hosts: ['192.168.1.20'], port: 4780, code: '123456', deviceName: 'x' })).rejects.toMatchObject({ code: 'not_found' }); // only LAN addresses are tried

    resetForTests();
    pc({ remote: { mode: 'view' } });
    await pair({ hosts: ['192.168.1.20'], port: 4780, code: '123456', deviceName: 'x', serverId: 'S1' });
    expect(store.session).toMatchObject({ remote: REMOTE, remoteMode: 'view' });
  });
});

describe('linking from another network', () => {
  /** The shop PC listening on the private mailbox of a code, answering /pair once. */
  async function shopWithCode(role: string | null = null) {
    const fake = new FakeSupabase();
    const code = newPairCode();
    const channel = await pairingChannel(code);
    const url = (fn: string) => `${fake.config.url}/rest/v1/rpc/${fn}`;
    const call = (fn: string, args: object) => fake.fetch(url(fn), { method: 'POST', headers: { apikey: fake.config.anonKey }, body: JSON.stringify(args) });
    await call('mb_beat', { p_mailbox: channel.mailbox, p_shop_id: 'S', p_name: 'Shop' });
    await call('mb_beat', { p_mailbox: REMOTE.mailbox, p_shop_id: 'S', p_name: 'Shop' });
    const pairs: unknown[] = [];
    fake.onSend = ({ mailbox, dir, body }) => {
      if (dir !== 0) return;
      const isPairing = mailbox === channel.mailbox;
      const key = isPairing ? channel.key : REMOTE.key;
      const device = isPairing ? 'pairing' : REMOTE.deviceId;
      const req = openJson<WireRequest>(key, mailbox, device, JSON.parse(body) as Sealed);
      let res: WireResponse;
      if (isPairing) {
        pairs.push(req.body);
        res = { id: req.id, status: 200, body: { token: 'tok', device: { id: 'd1', name: 'Far phone' }, serverId: 'S1', storeName: 'Shop', mode: 'full', remote: { ...REMOTE } } };
      } else res = { id: req.id, status: 200, body: req.path === '/me' ? { ok: true, data: { id: 'd1', name: 'Far phone', role, employeeId: null, remote: { writes: true } } } : { ok: true, data: [] } };
      void call('mb_send', { p_mailbox: mailbox, p_dir: 1, p_body: JSON.stringify(sealJson(key, mailbox, device, res)) });
    };
    setLinkDepsForTests({ fetchImpl: fake.fetch, socket: fake.Socket, pollMs: 20, minBackoffMs: 20 });
    return { fake, code, pairs };
  }

  beforeEach(() => {
    store.session = null;
    (APP as { remote: { url: string; anonKey: string } }).remote = { url: 'https://fake.supabase.test', anonKey: 'anon-test-key' };
  });
  afterEach(() => {
    (APP as { remote: { url: string; anonKey: string } }).remote = { url: '', anonKey: '' };
  });

  it('pairs with the code alone: no shop address, the mailbox and key come back, and the phone waits for approval', async () => {
    const shop = await shopWithCode();
    setTransport(async () => {
      throw new Error('no http at all');
    });
    await pairRemote({ code: formatPairCode(shop.code).toLowerCase(), deviceName: 'Far phone' });
    expect(shop.pairs).toEqual([{ deviceName: 'Far phone' }]);
    expect(store.session).toMatchObject({ host: '', port: 0, token: 'tok', serverId: 'S1', remote: REMOTE, remoteMode: 'full' });
    expect(getState()).toMatchObject({ phase: 'waiting', route: 'remote' });
  });

  it('then connects through the mailbox once the manager gives it a role, and never tries the shop network', async () => {
    vi.useFakeTimers();
    const shop = await shopWithCode('OWNER');
    const http: string[] = [];
    setTransport(async (req) => {
      http.push(req.url);
      throw new Error('unreachable');
    });
    await pairRemote({ code: shop.code, deviceName: 'Far phone' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(getState()).toMatchObject({ phase: 'connected', role: 'OWNER', route: 'remote', remoteWrites: true });
    resetForTests();
    await init(); // app restart
    expect(getState()).toMatchObject({ phase: 'connected', route: 'remote' });
    expect(http).toEqual([]);
  });

  it('refuses a wrong code with a clear error and saves nothing', async () => {
    await shopWithCode();
    await expect(pairRemote({ code: newPairCode(), deviceName: 'x' })).rejects.toMatchObject({ code: 'remote_not_found' });
    await expect(pairRemote({ code: 'abc', deviceName: 'x' })).rejects.toMatchObject({ code: 'bad_code' });
    expect(store.session).toBeNull();
  });

  it('says so when the phone has no internet', async () => {
    const shop = await shopWithCode();
    shop.fake.offline = true;
    await expect(pairRemote({ code: shop.code, deviceName: 'x' })).rejects.toMatchObject({ code: 'no_internet' });
  });
});
