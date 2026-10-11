// End-to-end encryption between the phone and the shop PC: XChaCha20-Poly1305, byte-compatible with the Rust
// crate in wire/ (see wire/vectors.json, which both sides open). The mailbox name and the device id are bound in as
// associated data. Sealed messages over 300,000 characters are split into numbered parts and joined on arrival.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export const MAX_PART_CHARS = 300_000;
export const MAX_MESSAGE_CHARS = 6 * 1024 * 1024;
export const MAILBOX_LEN = 43;
const MAX_PARTS = Math.floor(MAX_MESSAGE_CHARS / MAX_PART_CHARS) + 1;

export type WireErrorCode = 'bad_key' | 'bad_mailbox' | 'cannot_open' | 'bad_message' | 'message_too_large';
export class WireError extends Error {
  constructor(public code: WireErrorCode) {
    super(code);
  }
}

export interface Sealed {
  /** Nonce, base64url. */
  n: string;
  /** Ciphertext, base64url. */
  c: string;
}
export interface WireRequest {
  id: string;
  /** Unix milliseconds on the phone. */
  ts: number;
  method: string;
  path: string;
  body?: unknown;
}
export interface WireResponse {
  id: string;
  status: number;
  body?: unknown;
}
interface Part {
  id: string;
  i: number;
  of: number;
  part: string;
}

const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function toB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new WireError('bad_message');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const newKey = (): string => toB64Url(random(32));
export const newMailbox = (): string => toB64Url(random(32));
export const isMailbox = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

function keyBytes(key: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromB64Url(key);
  } catch {
    throw new WireError('bad_key');
  }
  if (bytes.length !== 32) throw new WireError('bad_key');
  return bytes;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const aad = (mailbox: string, deviceId: string): Uint8Array => enc.encode(`${mailbox}\0${deviceId}`);

export function seal(key: string, mailbox: string, deviceId: string, plain: Uint8Array): Sealed {
  if (!isMailbox(mailbox)) throw new WireError('bad_mailbox');
  const nonce = random(24);
  const c = xchacha20poly1305(keyBytes(key), nonce, aad(mailbox, deviceId)).encrypt(plain);
  return { n: toB64Url(nonce), c: toB64Url(c) };
}

export function open(key: string, mailbox: string, deviceId: string, sealed: Sealed): Uint8Array {
  try {
    const nonce = fromB64Url(sealed.n);
    if (nonce.length !== 24) throw new WireError('cannot_open');
    return xchacha20poly1305(keyBytes(key), nonce, aad(mailbox, deviceId)).decrypt(fromB64Url(sealed.c));
  } catch (err) {
    if (err instanceof WireError && err.code === 'bad_key') throw err;
    throw new WireError('cannot_open');
  }
}

/** JSON in, sealed out; and back. */
export const sealJson = (key: string, mailbox: string, deviceId: string, value: WireRequest | WireResponse): Sealed => seal(key, mailbox, deviceId, enc.encode(JSON.stringify(value)));
export function openJson<T>(key: string, mailbox: string, deviceId: string, sealed: Sealed): T {
  try {
    return JSON.parse(dec.decode(open(key, mailbox, deviceId, sealed))) as T;
  } catch (err) {
    if (err instanceof WireError) throw err;
    throw new WireError('bad_message');
  }
}

/** The mailbox bodies to send for one sealed message: one body when it fits, otherwise numbered parts. */
export function pack(id: string, sealed: Sealed): string[] {
  const whole = JSON.stringify(sealed);
  if (whole.length > MAX_MESSAGE_CHARS) throw new WireError('message_too_large');
  if (whole.length <= MAX_PART_CHARS) return [whole];
  const chunk = MAX_PART_CHARS - 200;
  const pieces: string[] = [];
  for (let i = 0; i < whole.length; i += chunk) pieces.push(whole.slice(i, i + chunk));
  return pieces.map((part, i) => JSON.stringify({ id, i: i + 1, of: pieces.length, part } satisfies Part));
}

/** Joins mailbox bodies back into sealed messages. Keep one per mailbox direction. */
export class Assembler {
  private partial = new Map<string, { of: number; parts: Map<number, string> }>();

  /** The sealed message when this body completes one, null while parts are missing. Throws WireError on garbage. */
  push(body: string): Sealed | null {
    if (body.length > MAX_PART_CHARS) throw new WireError('message_too_large');
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new WireError('bad_message');
    }
    if (!value || typeof value !== 'object') throw new WireError('bad_message');
    const v = value as Record<string, unknown>;
    if (typeof v.part === 'string') {
      const { id, i, of, part } = v as unknown as Part;
      if (typeof id !== 'string' || !Number.isInteger(i) || !Number.isInteger(of) || of < 1 || of > MAX_PARTS || i < 1 || i > of) throw new WireError('bad_message');
      let entry = this.partial.get(id);
      if (!entry) this.partial.set(id, (entry = { of, parts: new Map() }));
      if (entry.of !== of) {
        this.partial.delete(id);
        throw new WireError('bad_message');
      }
      entry.parts.set(i, part);
      if (entry.parts.size < of) return null;
      this.partial.delete(id);
      let whole = '';
      for (let n = 1; n <= of; n++) {
        whole += entry.parts.get(n) ?? '';
        if (whole.length > MAX_MESSAGE_CHARS) throw new WireError('message_too_large');
      }
      return parseSealed(whole);
    }
    return parseSealed(body);
  }

  clear(): void {
    this.partial.clear();
  }
  get pending(): number {
    return this.partial.size;
  }
}

function parseSealed(text: string): Sealed {
  try {
    const v = JSON.parse(text) as Partial<Sealed>;
    if (typeof v.n === 'string' && typeof v.c === 'string') return { n: v.n, c: v.c };
  } catch {
    /* falls through */
  }
  throw new WireError('bad_message');
}
