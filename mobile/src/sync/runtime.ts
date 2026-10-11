// The sync engine as the app uses it: one engine for the paired PC, a small store the screens subscribe to, and the
// triggers that make it run (app start, resume, network change, a new op, every 60 seconds while the app is open).
import { Capacitor } from '@capacitor/core';
import { useSyncExternalStore } from 'react';
import type { LocalDb } from './db';
import { SyncEngine, type Call, type SyncOutcome, type SyncStatus } from './engine';
import { getState, setState } from './store';

export interface SyncView extends SyncStatus {
  /** The local copy exists: the app can work without the PC. */
  ready: boolean;
  /** Temporary ids of what is waiting to be sent. */
  waiting: ReadonlySet<string>;
}

const EMPTY: SyncView = { pending: 0, notSent: 0, lastSyncAt: null, syncing: false, ready: false, waiting: new Set() };
let view: SyncView = EMPTY;
const listeners = new Set<() => void>();
const publish = (next: SyncView): void => {
  view = next;
  listeners.forEach((l) => l());
};

export const getSyncView = (): SyncView => view;
export const subscribeSync = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useSync = (): SyncView => useSyncExternalStore(subscribeSync, getSyncView);

let engine: SyncEngine | null = null;
let db: LocalDb | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
export const SYNC_EVERY_MS = 60_000;

export const getEngine = (): SyncEngine | null => engine;
export const getLocalDb = (): LocalDb | null => db;

export async function refreshSync(): Promise<void> {
  return refresh();
}

async function refresh(): Promise<void> {
  if (!engine) return publish(EMPTY);
  const [status, waiting] = await Promise.all([engine.status(), engine.waitingIds()]);
  publish({ ...status, ready: status.lastSyncAt !== null, waiting });
}

export interface StartOptions {
  deviceId: string;
  call: Call;
  /** Is there a route to the PC right now (the shop network or the mailbox)? */
  hasRoute: () => boolean;
  onRevoked: () => void | Promise<void>;
  /** Tests: an engine on an in-memory database. */
  database?: LocalDb;
}

let hasRoute: () => boolean = () => false;

/** Opens the local database and starts the engine. Does nothing off the phone (no native SQLite in a browser). */
export async function startSync(o: StartOptions): Promise<void> {
  if (engine) return;
  if (!o.database && !Capacitor.isNativePlatform()) return;
  db = o.database ?? (await (await import('./nativeDb')).openNativeDb());
  hasRoute = o.hasRoute;
  engine = new SyncEngine({
    db,
    call: o.call,
    deviceId: o.deviceId,
    onRevoked: async () => {
      await stopSync(false);
      await o.onRevoked();
    },
    onChange: () => void refresh(),
  });
  await refresh();
  timer = setInterval(() => void kickSync(), SYNC_EVERY_MS);
}

/** Wipes the local copy and stops (the PC revoked this phone, or the owner chose "Pair again"). */
export async function stopSync(wipe = true): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (engine && wipe) await engine.wipe();
  engine = null;
  if (db) await db.close().catch(() => undefined);
  db = null;
  publish(EMPTY);
}

/** Runs a sync now if there is a route to the PC. Safe to call from anywhere, any number of times. */
export function kickSync(): Promise<SyncOutcome | 'no_route'> {
  if (!engine) return Promise.resolve('no_route');
  if (!hasRoute()) return Promise.resolve('no_route');
  return engine.sync();
}

/** What the phone remembers about itself for working offline: its role and employee. */
export async function saveIdentity(role: string, employeeId: string | null): Promise<void> {
  if (!db) return;
  await db.batch([setState('role', role), setState('employee_id', employeeId ?? '')]);
}
export async function loadIdentity(): Promise<{ role: string; employeeId: string | null } | null> {
  if (!db) return null;
  const role = await getState(db, 'role');
  if (!role) return null;
  return { role, employeeId: (await getState(db, 'employee_id')) || null };
}

/** Temporary id -> real id, for a screen that still holds an id the PC has since replaced. */
export async function resolveAlias(id: string): Promise<string> {
  if (!db) return id;
  const rows = await db.all<{ real_id: string }>('SELECT real_id FROM id_alias WHERE temp_id = ?', [id]);
  return rows[0]?.real_id ?? id;
}

export async function aliasMap(): Promise<Map<string, string>> {
  if (!db) return new Map();
  return new Map((await db.all<{ temp_id: string; real_id: string }>('SELECT temp_id, real_id FROM id_alias')).map((r) => [r.temp_id, r.real_id]));
}
