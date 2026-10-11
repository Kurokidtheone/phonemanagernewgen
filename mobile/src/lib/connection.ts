// The connection to the shop PC as one small store: which screen the app is on (pairing, waiting, connected,
// not connected, update needed) and the saved session. Everything that can change it lives here.
import { useSyncExternalStore } from 'react';
import type { Language } from '@shared/app.config';
import type { MobileRole } from '@shared/schemas';
import { Network } from '@capacitor/network';
import { APP } from '@shared/app.config';
import { RemoteError } from '@shared/remote';
import { PAIRING_DEVICE_ID, pairingChannel, parsePairCode } from '@shared/remote/pairing';
import { ApiError, callChannel, callMe, callPair, lanBase, type Endpoint } from './client';
import { API_VERSION, candidatePrefixes, firstHello, HELLO_TIMEOUT_MS, hello, LAN_QUICK_MS, ownAddresses, scanSubnet, type Hello } from './discovery';
import { NetworkError } from './http';
import { closeLinks, linkFor, pairingLink } from './mailbox';
import { clearSession, loadLanguage, loadSession, saveLanguage, saveSession, type SavedSession } from './storage';
import { clearPin } from './pin';
import { clearMode, loadMode, saveMode, type Mode } from './mode';
import { startCore, wipeCore } from './standalone';
import { getSyncView, kickSync, loadIdentity, refreshSync, saveIdentity, startSync, stopSync } from '@/sync/runtime';

export type Phase = 'booting' | 'unpaired' | 'waiting' | 'connected' | 'offline' | 'update_app' | 'update_pc';

export interface ConnState {
  phase: Phase;
  language: Language | null;
  session: SavedSession | null;
  role: MobileRole | null;
  employeeId: string | null;
  /** True while looking for the PC. */
  searching: boolean;
  /** A newer phone app is on the PC: where to download it. */
  update: { versionName: string; url: string } | null;
  /** In the shop (the PC on the shop Wi-Fi), outside the shop (through the mailbox), or neither. */
  route: Route;
  /** Outside the shop: may this phone change things? Always true in the shop. */
  remoteWrites: boolean;
  /** Why the phone is not connected, when it is known: shop_offline, shop_blocked. */
  offlineReason: string | null;
  /** Connected to a shop PC, or running alone on this phone. Null until the first choice. */
  mode: Mode | null;
}

/** local = this phone's own core (stand-alone edition). */
export type Route = 'lan' | 'remote' | 'none' | 'local';

const INITIAL: ConnState = { phase: 'booting', language: null, session: null, role: null, employeeId: null, searching: false, update: null, route: 'none', remoteWrites: false, offlineReason: null, mode: null };
let state: ConnState = INITIAL;
const listeners = new Set<() => void>();
const set = (patch: Partial<ConnState>): void => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

// The version code of the app that is installed (the native side reports it), compared with the APK the PC holds.
let installedBuild = 0;
export const setInstalledBuild = (build: number): void => {
  installedBuild = Number.isFinite(build) ? build : 0;
};

/** "Update available" when the PC holds a newer APK than the installed app. */
export function updateFrom(hello: Hello, host: string, port: number): ConnState['update'] {
  if (!hello.apk || !installedBuild || hello.apk.versionCode <= installedBuild) return null;
  return { versionName: hello.apk.versionName, url: `http://${host}:${port}/app.apk` };
}

export const getState = (): ConnState => state;
export const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useConnection = (): ConnState => useSyncExternalStore(subscribe, getState);

export const resetForTests = (): void => {
  stopTimers();
  state = INITIAL;
};

// ---- timers: while waiting for approval or while offline, the app keeps trying by itself ----
let retryTimer: ReturnType<typeof setInterval> | null = null;
let waitTimer: ReturnType<typeof setInterval> | null = null;
let lanWatch: ReturnType<typeof setInterval> | null = null;
export const RETRY_MS = 4000;
/** Working from the local copy: looking for the PC every few seconds would only drain the battery. */
export const RETRY_OFFLINE_MS = 15_000;
/** Offline with an outside route saved: every attempt costs mobile data, so try less often. */
export const RETRY_REMOTE_MS = 10_000;
/** Outside the shop, how often the phone checks whether the shop network is back in reach. */
export const LAN_WATCH_MS = 30_000;
export const WAIT_MS = 2000;

function stopTimers(): void {
  if (retryTimer) clearInterval(retryTimer);
  if (waitTimer) clearInterval(waitTimer);
  if (lanWatch) clearInterval(lanWatch);
  retryTimer = waitTimer = lanWatch = null;
}

type NetworkKind = 'wifi' | 'cellular' | 'none' | 'unknown';
let networkKind: () => Promise<NetworkKind> = async () => {
  try {
    return (await Network.getStatus()).connectionType as NetworkKind;
  } catch {
    return 'unknown';
  }
};
/** Tests only. */
export const setNetworkKindForTests = (fn: (() => Promise<NetworkKind>) | null): void => {
  networkKind = fn ?? (async () => 'unknown');
};

/** Who this phone is while it cannot ask the PC: its role and employee, remembered with the local copy. */
let offlineIdentity: { role: MobileRole; employeeId: string | null } | null = null;

/** Starts the sync engine and its local copy for this pairing (on the phone only). */
async function ensureSync(session: SavedSession): Promise<void> {
  await startSync({
    deviceId: session.deviceId ?? session.remote?.deviceId ?? session.token.slice(0, 8),
    call: async (channel, input) => {
      const e = currentEndpoint();
      if (!e) throw new NetworkError('no_route');
      return callChannel(e, channel, input, 30_000);
    },
    hasRoute: () => state.phase === 'connected' && state.route !== 'none',
    onRevoked: () => revoked(),
  });
  await refreshSync();
  const known = await loadIdentity();
  offlineIdentity = known ? { role: known.role as MobileRole, employeeId: known.employeeId } : null;
}

/** Starts the phone's own core and opens the app on it: the owner, nothing to connect to. */
export async function startStandalone(): Promise<void> {
  const started = await startCore();
  if (!started.ok) {
    set({ phase: 'offline', route: 'none', mode: 'standalone', offlineReason: started.error.code });
    return;
  }
  set({ mode: 'standalone', phase: 'connected', route: 'local', role: 'OWNER', employeeId: null, searching: false, remoteWrites: true, offlineReason: null, session: null });
}

/** The first choice, after the language: connect to a shop PC, or use this phone alone. */
export async function chooseMode(mode: Mode): Promise<void> {
  await saveMode(mode);
  set({ mode });
  if (mode === 'standalone') await startStandalone();
}

export async function init(): Promise<void> {
  const [language, session, mode] = await Promise.all([loadLanguage(), loadSession(), loadMode()]);
  set({ language, session, mode: session ? 'connected' : mode });
  if (!session && mode === 'standalone') return startStandalone();
  if (!session) return set({ phase: 'unpaired' });
  await ensureSync(session);
  await reconnect();
}

export async function chooseLanguage(language: Language): Promise<void> {
  await saveLanguage(language);
  set({ language });
}

/** Where a request goes: the shop PC's address, or the encrypted mailbox. `api()` and every screen use this and never see the difference. */
export function endpointFor(session: SavedSession, route: Route): Endpoint {
  if (route === 'remote' && session.remote) return { base: '', token: session.token, link: linkFor(session.remote) };
  return { base: lanBase(session.host, session.port), token: session.token };
}
export const currentEndpoint = (): Endpoint | null => (state.session ? endpointFor(state.session, state.route) : null);

/** The token is no longer valid (revoked, or the PC forgot it): forget it and go back to pairing. */
export async function revoked(): Promise<void> {
  stopTimers();
  closeLinks();
  offlineIdentity = null;
  await clearPin();
  await stopSync(true); // the local copy goes too: this phone is no longer allowed to hold the shop's data
  await clearSession();
  set({ session: null, role: null, employeeId: null, phase: 'unpaired', searching: false, route: 'none', remoteWrites: false, offlineReason: null });
}

/** A request could not reach the PC (or the mailbox says the shop is offline): look for the best route again. */
export function networkFailed(): void {
  if (state.mode === 'standalone') return; // no PC to find
  if (state.phase !== 'connected') return; // while waiting for approval, the waiting loop keeps polling by itself
  void reconnect();
}

function goOffline(reason: string | null): void {
  stopTimers();
  // With a local copy the phone keeps working: reads come from it and changes wait in the outbox. The header says so.
  const role = state.role ?? offlineIdentity?.role ?? null;
  if (getSyncView().ready && role) {
    set({ phase: 'connected', route: 'none', role, employeeId: state.employeeId ?? offlineIdentity?.employeeId ?? null, searching: false, offlineReason: reason, remoteWrites: true });
    retryTimer = setInterval(() => void reconnect(), RETRY_OFFLINE_MS);
    return;
  }
  set({ phase: 'offline', route: 'none', searching: false, offlineReason: reason });
  retryTimer = setInterval(() => void reconnect(), outsideOn(state.session) ? RETRY_REMOTE_MS : RETRY_MS);
}

/** The phone has a mailbox and the PC said outside access is on. */
const outsideOn = (s: SavedSession | null): boolean => !!s?.remote && !!s.remoteMode && s.remoteMode !== 'off';

function checkVersion(h: Hello): Phase | null {
  if (h.apiVersion > API_VERSION) return 'update_app';
  if (h.apiVersion < API_VERSION) return 'update_pc';
  return null;
}

let reconnecting: Promise<void> | null = null;

/** App start, app resume, Retry, Wi-Fi back, any network error: pick the route. One at a time. */
export function reconnect(): Promise<void> {
  reconnecting ??= doReconnect().finally(() => {
    reconnecting = null;
  });
  return reconnecting;
}

/**
 * Route choice. 1) the shop PC on its last address, a 1.5 s /hello. 2) On Wi-Fi, search the network (its address may
 * have changed). 3) Otherwise the mailbox, if the PC said outside access is on while the phone was in the shop. 4) Not connected.
 */
async function doReconnect(): Promise<void> {
  const saved = state.session;
  if (!saved) return;
  if (state.phase !== 'connected') set({ searching: true });
  let current = saved;

  // A phone linked from another network has no shop address: it only has the mailbox.
  let answer: Hello | null = saved.host ? await hello(saved.host, saved.port, LAN_QUICK_MS) : null;
  if (answer && answer.serverId !== saved.serverId) answer = null;
  if (!answer && saved.host && (await networkKind()) === 'wifi') {
    const host = await searchNetwork(saved);
    if (host) {
      current = { ...saved, host };
      await saveSession(current);
      set({ session: current });
      answer = await hello(host, saved.port, HELLO_TIMEOUT_MS);
    }
  }
  if (answer) return connectLan(current, answer);

  if (outsideOn(saved)) return connectRemote(current);
  goOffline(null);
}

async function connectLan(session: SavedSession, answer: Hello): Promise<void> {
  const tooOld = checkVersion(answer);
  if (tooOld) {
    stopTimers();
    set({ phase: tooOld, searching: false });
    return;
  }
  // While in the shop, learn whether the PC allows outside access (off, full or view only).
  const mode = answer.remote?.mode ?? 'off';
  let current = session;
  if (mode !== session.remoteMode) {
    current = { ...session, remoteMode: mode };
    await saveSession(current);
    set({ session: current });
  }
  set({ update: updateFrom(answer, current.host, current.port) });
  await identify(current, answer.storeName, 'lan');
}

/** The mailbox: is the shop PC alive (mb_seen within a minute)? Then ask who this phone is. */
async function connectRemote(session: SavedSession): Promise<void> {
  set({ update: null }); // the app is only handed out on the shop network
  try {
    await linkFor(session.remote!).check();
  } catch (err) {
    if (err instanceof RemoteError) return goOffline(err.code === 'shop_offline' || err.code === 'mailbox_unknown' ? 'shop_offline' : err.code === 'mailbox_blocked' ? 'shop_blocked' : null);
    return goOffline(null);
  }
  await identify(session, session.storeName, 'remote');
}

/** The phone's own /24 first, then the networks of the last known addresses. */
async function searchNetwork(saved: SavedSession): Promise<string | null> {
  const own = await ownAddresses().catch(() => []);
  for (const prefix of candidatePrefixes(own, saved.host, saved.hosts)) {
    const found = await scanSubnet(prefix, saved.port, saved.serverId, { skip: [saved.host] });
    if (found) return found;
  }
  return null;
}

/** /me tells the role. No role yet: the manager has not approved this phone. */
async function identify(session: SavedSession, storeName: string, route: Route): Promise<void> {
  try {
    const me = await callMe(endpointFor(session, route));
    if (!me.ok) {
      const code = me.error.code;
      if (code === 'unauthorized' || code === 'device_revoked') return revoked();
      // Reached the PC but it refused: say why instead of retrying blindly.
      return goOffline(code === 'shop_offline' || code === 'shop_blocked' ? code : null);
    }
    const next = { ...session, storeName, deviceName: me.data.name };
    await saveSession(next);
    stopTimers();
    if (!me.data.role) {
      set({ session: next, phase: 'waiting', searching: false, role: null, route });
      return startWaiting();
    }
    set({ session: next, role: me.data.role, employeeId: me.data.employeeId, phase: 'connected', searching: false, route, remoteWrites: route === 'lan' ? true : (me.data.remote?.writes ?? false), offlineReason: null });
    offlineIdentity = { role: me.data.role, employeeId: me.data.employeeId };
    void saveIdentity(me.data.role, me.data.employeeId);
    void kickSync(); // now there is a route: send what waits, then pull what changed
    // Outside the shop: now and then look whether the shop network is in reach again, and move to it.
    if (route === 'remote' && next.host) {
      lanWatch = setInterval(() => {
        void hello(next.host, next.port, LAN_QUICK_MS).then((h) => {
          if (h && h.serverId === next.serverId) void reconnect();
        });
      }, LAN_WATCH_MS);
    }
  } catch (err) {
    if (err instanceof NetworkError) return goOffline(null);
    throw err;
  }
}

/** After pairing: poll until an /api call stops answering "forbidden", then read the role. */
export function startWaiting(): void {
  if (waitTimer) return;
  const poll = async (): Promise<void> => {
    const session = state.session;
    if (!session || state.phase !== 'waiting') return stopTimers();
    try {
      const endpoint = endpointFor(session, state.route === 'remote' ? 'remote' : 'lan');
      const res = await callChannel(endpoint, 'brands.list', {});
      if (!res.ok && res.error.code === 'forbidden') return;
      if (!res.ok && (res.error.code === 'unauthorized' || res.error.code === 'device_revoked')) return void (await revoked());
      stopTimers();
      const me = await callMe(endpoint);
      if (me.ok && me.data.role) {
        set({ role: me.data.role, employeeId: me.data.employeeId, phase: 'connected', route: state.route === 'remote' ? 'remote' : 'lan', remoteWrites: state.route === 'remote' ? (me.data.remote?.writes ?? false) : true });
        offlineIdentity = { role: me.data.role, employeeId: me.data.employeeId };
        void saveIdentity(me.data.role, me.data.employeeId);
        void kickSync();
      }
    } catch {
      /* the PC is briefly unreachable: the next poll tries again */
    }
  };
  waitTimer = setInterval(() => void poll(), WAIT_MS);
  void poll();
}

export interface PairInput {
  hosts: string[];
  port: number;
  code: string;
  /** From the QR: the PC must be this one. Absent when the address was typed by hand. */
  serverId?: string;
  deviceName: string;
}

export class PairError extends Error {
  constructor(public code: 'not_found' | string) {
    super(code);
  }
}

/** Finds the PC among the addresses, then redeems the code. Resolves once the phone is saved and waiting for approval. */
export async function pair(input: PairInput): Promise<void> {
  const found = await firstHello(input.hosts, input.port, input.serverId);
  if (!found) throw new PairError('not_found');
  const res = await callPair(found.host, input.port, input.code, input.deviceName).catch((err) => {
    if (err instanceof NetworkError) throw new PairError('not_found');
    throw err;
  });
  if (!res.ok) throw new ApiError(res.error.code, res.error.params);
  const session: SavedSession = {
    serverId: found.hello.serverId,
    host: found.host,
    port: input.port,
    token: res.data.token,
    deviceName: res.data.device.name,
    deviceId: res.data.device.id,
    hosts: input.hosts,
    storeName: found.hello.storeName,
    remote: res.data.remote,
    remoteMode: found.hello.remote?.mode ?? 'off',
  };
  await saveSession(session);
  await ensureSync(session);
  stopTimers();
  set({ session, role: null, phase: 'waiting', searching: false, route: 'lan' });
  startWaiting();
}

/** Linking from another network: the code the PC shows names a private mailbox; the PC answers there, once. */
export async function pairRemote(input: { code: string; deviceName: string }): Promise<void> {
  const code = parsePairCode(input.code);
  if (!code) throw new PairError('bad_code');
  const config = { url: APP.remote.url, anonKey: APP.remote.anonKey };
  if (!config.url || !config.anonKey) throw new PairError('not_configured');
  const link = pairingLink(await pairingChannel(code), config, PAIRING_DEVICE_ID);
  try {
    await link.check();
    const res = await link.request('POST', '/pair', { deviceName: input.deviceName });
    const body = res.body as { ok?: boolean; error?: { code: string; params?: Record<string, string | number> }; token?: string; device?: { name: string }; serverId?: string; storeName?: string; mode?: 'off' | 'full' | 'view'; remote?: SavedSession['remote'] } | null;
    if (res.status !== 200 || !body?.token || !body.remote || !body.serverId) throw new ApiError(body?.error?.code ?? 'unexpected', body?.error?.params ?? {});
    const session: SavedSession = { serverId: body.serverId, host: '', port: 0, token: body.token, deviceId: body.remote.deviceId, deviceName: body.device?.name ?? input.deviceName, hosts: [], storeName: body.storeName ?? '', remote: body.remote, remoteMode: body.mode ?? 'full' };
    await saveSession(session);
    await ensureSync(session);
    stopTimers();
    set({ session, role: null, phase: 'waiting', searching: false, route: 'remote', remoteWrites: false });
    startWaiting();
  } catch (err) {
    if (err instanceof RemoteError) throw new PairError(err.code === 'no_internet' ? 'no_internet' : 'remote_not_found');
    if (err instanceof NetworkError) throw new PairError('no_internet');
    throw err;
  } finally {
    link.close();
  }
}

/**
 * "Reset app": wipes the local copy and the pairing and goes back to the first choice. It is the only way from
 * connected mode to stand-alone. Stand-alone data stays on the phone until it is moved to a shop PC.
 */
export async function resetApp(): Promise<void> {
  await revoked();
  await clearMode();
  set({ mode: null });
}

/** Stand-alone -> connected, after the owner confirmed the shop PC has the data: this phone's own data is erased. */
export async function moveToShopPc(): Promise<void> {
  await wipeCore();
  await clearMode();
  await saveMode('connected');
  set({ mode: 'connected', phase: 'unpaired', route: 'none', role: null, employeeId: null, session: null });
}

/** "Pair again": forget this PC. */
export const forget = (): Promise<void> => revoked();
