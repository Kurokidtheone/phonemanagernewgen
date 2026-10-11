// License key format, shared by the app, tools/license-tool.mjs and tools/license-desk.html.
//   key = base32( signature[64 bytes] + UTF-8 JSON payload ), in groups of 5
//   payload = { p: product code, d: device id, n: customer, e: edition, i: issued date }
// The signature (Ed25519) covers the payload bytes exactly as they appear in the key.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const SIGNATURE_LENGTH = 64;

export interface LicensePayload {
  /** Product code ("PSM" for this app). A key whose p is missing or different is rejected. */
  p?: string;
  d: string;
  n: string;
  e: string;
  i: string;
}

export type LicenseParseError = 'invalid_characters' | 'too_short' | 'corrupted';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const normalizeDeviceId = (id: string): string => id.toUpperCase().replace(/[^0-9A-F]/g, '');
export const groupText = (text: string, size: number): string => text.match(new RegExp(`.{1,${size}}`, 'g'))?.join('-') ?? '';

export function parseLicenseKey(
  key: string,
): { ok: true; signature: Uint8Array; payloadBytes: Uint8Array; payload: LicensePayload } | { ok: false; error: LicenseParseError } {
  const cleaned = key.toUpperCase().replace(/[\s-]/g, '');
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) return { ok: false, error: 'invalid_characters' };
  const raw = base32Decode(cleaned);
  if (!raw) return { ok: false, error: 'invalid_characters' };
  if (raw.length <= SIGNATURE_LENGTH) return { ok: false, error: 'too_short' };
  const signature = raw.slice(0, SIGNATURE_LENGTH);
  const payloadBytes = raw.slice(SIGNATURE_LENGTH);
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)) as LicensePayload;
    // "p" (the product code) is checked by the app after the signature: a key without it is the wrong product, not a damaged one.
    if (typeof payload.d !== 'string') return { ok: false, error: 'corrupted' };
    return { ok: true, signature, payloadBytes, payload };
  } catch {
    return { ok: false, error: 'corrupted' };
  }
}

/**
 * The phone option lives in the license edition: "lifetime+mobile3" allows 3 paired phones, a bare "mobile"
 * allows any number, and an edition without it allows none. Words may be separated by + , space or -.
 */
export function mobileAllowance(edition: string | undefined): { allowed: boolean; limit: number | null } {
  for (const word of (edition ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    const m = /^mobile(\d*)$/.exec(word);
    if (m) return { allowed: true, limit: m[1] ? Number(m[1]) : null };
  }
  return { allowed: false, limit: null };
}
