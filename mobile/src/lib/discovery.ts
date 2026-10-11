// Finding the shop PC: reading the pairing QR, asking /hello, and searching a /24 network when its address changed.
import { APP } from '@shared/app.config';
import type { RemoteMode } from '@shared/schemas';
import { http } from './http';

export const API_VERSION = 1;
export const HELLO_TIMEOUT_MS = 2500;
/** The first look at the shop network on start, on resume and after an error: short, so the mailbox is tried quickly when away. */
export const LAN_QUICK_MS = 1500;
export const SCAN_TIMEOUT_MS = 800;
export const SCAN_PARALLEL = 40;

export interface Hello {
  app: string;
  serverId: string;
  storeName: string;
  appVersion: string;
  apiVersion: number;
  /** The phone app the PC holds (served at /app.apk), if the installer included it. */
  apk?: { versionName: string; versionCode: number; size: number } | null;
  /** Whether the PC allows outside access, learned while the phone is in the shop. */
  remote?: { mode: RemoteMode };
}

export interface PairingQr {
  v: 1;
  id: string;
  name: string;
  hosts: string[];
  port: number;
  code: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const isIpv4 = (s: string): boolean => {
  const m = IPV4.exec(s.trim());
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
};
/** "192.168.1.20" -> "192.168.1" */
export const prefixOf = (ip: string): string | null => (isIpv4(ip) ? ip.trim().split('.').slice(0, 3).join('.') : null);

export function parseQr(text: string): PairingQr | null {
  try {
    const q = JSON.parse(text) as Partial<PairingQr>;
    if (q.v !== 1 || typeof q.id !== 'string' || typeof q.code !== 'string' || !/^\d{6}$/.test(q.code)) return null;
    if (!Array.isArray(q.hosts) || !q.hosts.every((h) => typeof h === 'string' && isIpv4(h)) || q.hosts.length === 0) return null;
    if (!Number.isInteger(q.port) || (q.port as number) < 1 || (q.port as number) > 65535) return null;
    return { v: 1, id: q.id, name: typeof q.name === 'string' ? q.name : '', hosts: q.hosts, port: q.port as number, code: q.code };
  } catch {
    return null;
  }
}

/** /hello on one address. null when nothing answers, or what answers is not this product. */
export async function hello(host: string, port: number, timeoutMs = HELLO_TIMEOUT_MS): Promise<Hello | null> {
  const answer = await helloAt(`http://${host}:${port}`, timeoutMs);
  return answer.ok ? answer.hello : null;
}

export type HelloAt = { ok: true; hello: Hello } | { ok: false; code: string | null };

/** /hello at a base address. `code` is the error the PC gave, null when unreachable. */
export async function helloAt(base: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<HelloAt> {
  try {
    const res = await http({ url: `${base}/hello`, method: 'GET', timeoutMs });
    const body = res.data as (Partial<Hello> & { ok?: boolean; error?: { code?: string } }) | null;
    if (res.status === 200 && body && body.app === APP.productCode && typeof body.serverId === 'string') return { ok: true, hello: body as Hello };
    return { ok: false, code: body?.error?.code ?? null };
  } catch {
    return { ok: false, code: null };
  }
}

/** Asks every address at once and returns the first that answers /hello (with this serverId, when one is given). */
export function firstHello(hosts: string[], port: number, serverId?: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<{ host: string; hello: Hello } | null> {
  return new Promise((resolve) => {
    let pending = hosts.length;
    if (pending === 0) return resolve(null);
    for (const host of hosts) {
      void hello(host, port, timeoutMs).then((h) => {
        pending -= 1;
        if (h && (!serverId || h.serverId === serverId)) resolve({ host, hello: h });
        else if (pending === 0) resolve(null);
      });
    }
  });
}

/** Searches prefix.1 to prefix.254 for a PC answering /hello with this serverId: 40 requests at a time, 800 ms each. */
export async function scanSubnet(prefix: string, port: number, serverId: string, options: { parallel?: number; timeoutMs?: number; skip?: string[] } = {}): Promise<string | null> {
  const parallel = options.parallel ?? SCAN_PARALLEL;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((h) => !options.skip?.includes(h));
  let next = 0;
  let found: string | null = null;
  const worker = async (): Promise<void> => {
    while (found === null && next < hosts.length) {
      const host = hosts[next++];
      const h = await hello(host, port, timeoutMs);
      if (h && h.serverId === serverId) found = host;
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, hosts.length) }, worker));
  return found;
}

/** The phone's own addresses, when the WebView will tell (it often hides them behind .local names; then this returns nothing). */
export async function ownAddresses(timeoutMs = 1500): Promise<string[]> {
  if (typeof RTCPeerConnection === 'undefined') return [];
  return new Promise((resolve) => {
    const found = new Set<string>();
    const pc = new RTCPeerConnection({ iceServers: [] });
    const done = (): void => {
      pc.close();
      resolve([...found]);
    };
    const timer = setTimeout(done, timeoutMs);
    pc.createDataChannel('');
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        clearTimeout(timer);
        return done();
      }
      const ip = e.candidate.candidate.split(' ')[4];
      if (ip && isIpv4(ip)) found.add(ip);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(done);
  });
}

/** Networks to search, most likely first, each once: the phone's own, then the last known PC address, then every address from the QR. */
export function candidatePrefixes(own: string[], last: string, known: string[]): string[] {
  return [...new Set([...own, last, ...known].map(prefixOf).filter((p): p is string => !!p))];
}
