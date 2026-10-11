// Every request to the shop PC goes through here, over Capacitor's native HTTP (not the WebView's fetch),
// so plain http on the LAN is allowed and timeouts are real. A test replaces the transport with setTransport().
import { CapacitorHttp } from '@capacitor/core';

export class NetworkError extends Error {
  constructor(message = 'network') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** A binary body (base64) sent as is, with this Content-Type: a photo for POST /files. */
  file?: { base64: string; contentType: string };
  /** The answer is a file: `data` comes back as base64 text. */
  binary?: boolean;
  timeoutMs: number;
}
export interface HttpResponse {
  status: number;
  data: unknown;
  contentType?: string;
}
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

const nativeTransport: Transport = async ({ url, method, headers, body, file, binary, timeoutMs }) => {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new NetworkError('timeout')), timeoutMs));
  const call = CapacitorHttp.request({
    url,
    method,
    headers: { ...(file ? { 'Content-Type': file.contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    data: file ? file.base64 : body,
    ...(file ? { dataType: 'file' as const } : {}),
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    responseType: binary ? 'blob' : 'json',
  });
  const res = await Promise.race([call, timer]);
  let data: unknown = res.data;
  const contentType = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  if (typeof data === 'string' && !binary) {
    try {
      data = JSON.parse(data);
    } catch {
      /* not JSON: left as text */
    }
  }
  return { status: res.status, data, contentType };
};

let transport: Transport = nativeTransport;
export const setTransport = (next: Transport | null): void => {
  transport = next ?? nativeTransport;
};

/** 10.x, 172.16-31.x, 192.168.x, 169.254.x (the shop LAN), or this phone itself. */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Plain http is only for the shop's own network. Android cannot restrict cleartext traffic to address ranges in its
 * network security config, so the app does it here: anything outside the shop (Supabase, any other host) must be https.
 */
export function assertAllowedUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isPrivateHost(parsed.hostname)) return;
  throw new NetworkError('cleartext_blocked');
}

/** Resolves with the response whatever its status; rejects with NetworkError when the PC cannot be reached. */
export async function http(request: HttpRequest): Promise<HttpResponse> {
  try {
    assertAllowedUrl(request.url);
    return await transport(request);
  } catch (err) {
    throw err instanceof NetworkError ? err : new NetworkError(err instanceof Error ? err.message : 'network');
  }
}
