// The only way screens talk to the shop PC: api('channel', input), typed from the desktop's Api type.
// Whether the request goes to the PC on the shop Wi-Fi, through the mailbox, or is answered by the phone's own copy
// (offline) is decided here and in connection.ts: no screen knows.
import type { Api } from '@shared/api';
import { ApiError, callChannel, callFile, callUpload, errorText, type Endpoint } from './client';
import { currentEndpoint, getState, networkFailed, revoked } from './connection';
import { NetworkError } from './http';
import { LOCAL_READS, NeedsPcError, OFFLINE_WRITES, readLocal } from '@/sync/local';
import { SyncError } from '@/sync/engine';
import { requestUnlock } from './unlock';
import { runLocal } from './standalone';
import { aliasMap, getEngine, getLocalDb, getSyncView, kickSync, resolveAlias } from '@/sync/runtime';

export { ApiError, errorText };

const endpoint = (): Endpoint => {
  const e = currentEndpoint();
  if (!e) throw new ApiError('unauthorized');
  return e;
};

/** Codes that mean "the PC cannot be reached right now" (from the mailbox): look for a route again. */
const UNREACHABLE = new Set(['shop_offline', 'shop_blocked']);

/** What an error answer from the PC or the mailbox changes in the app, then the error to throw. */
function failure(code: string, params: Record<string, string | number> = {}): ApiError {
  if (code === 'device_revoked' || code === 'unauthorized') void revoked();
  else if (UNREACHABLE.has(code)) networkFailed();
  return new ApiError(code, params);
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof NetworkError) {
      networkFailed(); // pick the route again; if none works the phone carries on from its own copy, or shows "not connected"
      throw new ApiError('network');
    }
    throw err;
  }
}

/** An id the PC has replaced since this screen got it: swap it for the real one before asking the PC. */
async function withRealIds(input: unknown): Promise<unknown> {
  const aliases = await aliasMap();
  if (aliases.size === 0) return input;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return aliases.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(input);
}

const asApiError = (err: unknown): unknown => (err instanceof SyncError ? new ApiError(err.code, err.params) : err instanceof NeedsPcError ? new ApiError('needs_shop_pc') : err);

/** A change made on the phone: it always goes through the outbox (one code path), then goes to the PC when there is a route. */
async function write(channel: string, input: unknown): Promise<unknown> {
  const spec = OFFLINE_WRITES[channel];
  const engine = getEngine();
  if (!spec || !engine) return undefined;
  const raw = (input ?? {}) as Record<string, unknown>;
  try {
    const out = await engine.enqueue(spec.type, spec.payload ? spec.payload(raw) : raw);
    void kickSync();
    return out.result;
  } catch (err) {
    throw asApiError(err);
  }
}

export async function api<K extends keyof Api>(channel: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  const name = channel as string;
  // Stand-alone: this phone's own core answers, as the owner. Same channels, same types: no screen knows.
  if (getState().route === 'local') {
    let result = await runLocal(name, args[0]);
    // A protected section: ask for the manager password, then make the call again.
    if (!result.ok && result.error.code === 'locked' && (await requestUnlock())) result = await runLocal(name, args[0]);
    if (!result.ok) throw new ApiError(result.error.code, result.error.params);
    return result.data as Awaited<ReturnType<Api[K]>>;
  }
  if (name in OFFLINE_WRITES && getEngine()) return (await write(name, args[0])) as Awaited<ReturnType<Api[K]>>;

  const engine = getEngine();
  const state = getState();
  const local = async (): Promise<Awaited<ReturnType<Api[K]>>> => {
    const db = getLocalDb();
    if (!db || !LOCAL_READS.has(name)) throw new ApiError('needs_shop_pc');
    try {
      return (await readLocal(db, name, args[0])) as Awaited<ReturnType<Api[K]>>;
    } catch (err) {
      throw asApiError(err);
    }
  };

  // A sale made on this phone that the PC has not numbered yet is read from the phone.
  if (engine && name === 'sales.get') {
    const db = getLocalDb();
    const id = String((args[0] as { id?: string } | undefined)?.id ?? '');
    if (db && id && (await db.all('SELECT 1 FROM local_sales WHERE id = ?', [id])).length > 0) return local();
  }
  if (engine && state.route === 'none') return local();

  // Printing needs the PC's own record: not for something it has not received yet.
  if (engine && (name === 'sales.printReceipt' || name === 'repairs.printSlip')) {
    const id = String((args[0] as { id?: string } | undefined)?.id ?? '');
    if (getSyncView().waiting.has(id)) throw new ApiError('not_sent_yet');
  }
  const input = engine ? await withRealIds(args[0]) : args[0];
  try {
    const result = await guarded(() => callChannel(endpoint(), name, input));
    if (!result.ok) throw failure(result.error.code, result.error.params);
    return result.data as Awaited<ReturnType<Api[K]>>;
  } catch (err) {
    // The PC could not be reached just now: the phone's own copy answers what it can.
    if (engine && err instanceof ApiError && err.code === 'network' && LOCAL_READS.has(name)) return local();
    throw err;
  }
}

/** Uploads a photo to the PC and returns the stored name. Same failure handling as api(). */
export async function uploadImage(base64: string, contentType: string): Promise<string> {
  if (getState().route === 'local') throw new ApiError('photos_not_available_alone');
  const result = await guarded(() => callUpload(endpoint(), base64, contentType));
  if (!result.ok) throw failure(result.error.code, result.error.params);
  return result.data.name;
}

/** A stored photo as a data: URL. */
export const fetchPhoto = (name: string): Promise<string> => guarded(() => callFile(endpoint(), name));

/** The real id of something made on this phone (the PC replaces temporary ids once it has them). */
export const realId = resolveAlias;

/** What a channel returns, for typing rows and props: ApiResult<'units.list'>[number]. */
export type ApiResult<K extends keyof Api> = Awaited<ReturnType<Api[K]>>;
