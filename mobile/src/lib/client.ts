// The wire format with the shop PC, without any app state. api.ts and connection.ts build on it.
// A request goes either over HTTP to the PC on the shop network, or as an encrypted message through the mailbox.
import type { TFunction } from 'i18next';
import { RemoteError, type PhoneLink } from '@shared/remote';
import type { IpcResult } from '@shared/errors';
import type { MobileRole } from '@shared/schemas';
import { http, NetworkError, type HttpResponse } from './http';
import type { SavedRemote } from './storage';

export const REQUEST_TIMEOUT_MS = 6000;

export class ApiError extends Error {
  constructor(
    public code: string,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export interface Endpoint {
  /** http://<pc>:<port> on the shop network. Not used through the mailbox. */
  base: string;
  token: string;
  /** Outside the shop: the encrypted mailbox link. The token is not sent, the key identifies the phone. */
  link?: PhoneLink;
}
export interface DeviceInfo {
  id: string;
  name: string;
  role: MobileRole | null;
  employeeId: string | null;
  /** Sent by the PC: may this phone change things from outside the shop? */
  remote?: { writes: boolean };
}

export const lanBase = (host: string, port: number): string => `http://${host}:${port}`;
const bearer = (e: Endpoint): Record<string, string> => ({ Authorization: `Bearer ${e.token}` });

/** What the phone shows for the mailbox's own failures. */
const REMOTE_CODES: Record<string, string> = {
  shop_offline: 'shop_offline',
  shop_timeout: 'shop_timeout',
  mailbox_unknown: 'shop_offline',
  mailbox_blocked: 'shop_blocked',
  mailbox_full: 'shop_busy',
  body_too_large: 'body_too_large',
};
const failureEnvelope = (code: string): HttpResponse => ({ status: 503, data: { ok: false, error: { code, params: {} } } });

interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** A photo to upload. */
  file?: { base64: string; contentType: string };
  /** The answer is a photo: `data` comes back as base64 text. */
  binary?: boolean;
  timeoutMs: number;
}

/** One request, over HTTP or through the mailbox. Throws NetworkError only when the network itself is down. */
async function exchange(e: Endpoint, call: Call): Promise<HttpResponse> {
  if (!e.link) return http({ url: `${e.base}${call.path}`, method: call.method, headers: bearer(e), body: call.body, file: call.file, binary: call.binary, timeoutMs: call.timeoutMs });
  try {
    const res = await e.link.request(call.method, call.path, call.file ? { b64: call.file.base64, type: call.file.contentType } : call.body);
    if (call.binary && res.status === 200) {
      const photo = res.body as { b64?: unknown; type?: unknown } | null;
      return typeof photo?.b64 === 'string' ? { status: 200, data: photo.b64, contentType: typeof photo.type === 'string' ? photo.type : undefined } : failureEnvelope('unexpected');
    }
    return { status: res.status, data: res.body };
  } catch (err) {
    if (err instanceof RemoteError) {
      if (err.code === 'no_internet') throw new NetworkError('no_internet');
      return failureEnvelope(REMOTE_CODES[err.code] ?? 'unexpected');
    }
    throw err;
  }
}

/** Anything the PC answers becomes an envelope; only an unreachable PC throws (NetworkError). */
function envelope(data: unknown): IpcResult<unknown> {
  const body = data as Partial<IpcResult<unknown>> | null;
  if (body && typeof body === 'object' && 'ok' in body) return body as IpcResult<unknown>;
  return { ok: false, error: { code: 'unexpected', params: {} } };
}

export async function callChannel(endpoint: Endpoint, channel: string, input: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<IpcResult<unknown>> {
  const res = await exchange(endpoint, { method: 'POST', path: `/api/${channel}`, body: input ?? {}, timeoutMs });
  return envelope(res.data);
}

/** POST /files: one photo. The PC answers { name } or an error envelope. */
export async function callUpload(endpoint: Endpoint, base64: string, contentType: string): Promise<IpcResult<{ name: string }>> {
  const res = await exchange(endpoint, { method: 'POST', path: '/files', file: { base64, contentType }, timeoutMs: 30_000 });
  const body = res.data as { name?: unknown } | null;
  if (res.status === 200 && body && typeof body.name === 'string') return { ok: true, data: { name: body.name } };
  return envelope(res.data) as IpcResult<{ name: string }>;
}

/** GET /files/:name as a data: URL an <img> can show (an <img> cannot send the Authorization header). */
export async function callFile(endpoint: Endpoint, name: string): Promise<string> {
  const res = await exchange(endpoint, { method: 'GET', path: `/files/${encodeURIComponent(name)}`, binary: true, timeoutMs: 30_000 });
  if (res.status !== 200 || typeof res.data !== 'string') throw new ApiError('not_found');
  const type = res.contentType?.split(';')[0] ?? (name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  return `data:${type};base64,${res.data}`;
}

export async function callMe(endpoint: Endpoint, timeoutMs = REQUEST_TIMEOUT_MS): Promise<IpcResult<DeviceInfo>> {
  const res = await exchange(endpoint, { method: 'GET', path: '/me', timeoutMs });
  return envelope(res.data) as IpcResult<DeviceInfo>;
}

export interface PairResult {
  token: string;
  device: DeviceInfo;
  /** This phone's mailbox and key, and the public Supabase address: given once, here, on the shop Wi-Fi. */
  remote?: SavedRemote;
}

export async function callPair(host: string, port: number, code: string, deviceName: string): Promise<IpcResult<PairResult>> {
  const res = await http({ url: `${lanBase(host, port)}/pair`, method: 'POST', body: { code, deviceName }, timeoutMs: REQUEST_TIMEOUT_MS });
  // Success is the bare { token, device, remote } the PC documents; failures use the usual error envelope.
  const body = res.data as { token?: unknown; device?: DeviceInfo; remote?: Partial<SavedRemote> } | null;
  if (res.status === 200 && body && typeof body.token === 'string' && body.device) {
    const r = body.remote;
    const remote = r && r.mailbox && r.key && r.deviceId && r.url && r.anonKey ? { mailbox: r.mailbox, key: r.key, deviceId: r.deviceId, url: r.url, anonKey: r.anonKey } : undefined;
    return { ok: true, data: { token: body.token, device: body.device, remote } };
  }
  return envelope(res.data) as IpcResult<PairResult>;
}

/** A sentence the user can act on, in their language, for any error. */
export function errorText(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) return t(`errors.${err.code}`, { ...err.params, defaultValue: t('errors.unexpected') });
  return t('errors.unexpected');
}
