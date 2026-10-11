// Linking a phone that is not on the shop Wi-Fi. The PC shows a one-time code with 80 random bits. Both sides turn it
// into a private pairing mailbox name and key (HKDF-SHA256), so the code itself is never sent anywhere and nobody
// without it can find or read that mailbox. The PC answers once with the phone's real mailbox and key, sealed with the
// pairing key; then the pairing mailbox is forgotten.
import { toB64Url } from './wire';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PAIR_CODE_LENGTH = 16;
/** The device id bound into pairing messages (a real device id is a UUID, so it cannot collide). */
export const PAIRING_DEVICE_ID = 'pairing';

/** 16 characters from a 32-letter alphabet: 80 bits. */
export function newPairCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PAIR_CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
}

/** XXXX-XXXX-XXXX-XXXX */
export const formatPairCode = (code: string): string => code.match(/.{1,4}/g)?.join('-') ?? code;

/** What a person typed (any case, spaces or dashes) as a clean code, or null when it is not one. */
export function parsePairCode(text: string): string | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '');
  return clean.length === PAIR_CODE_LENGTH && [...clean].every((c) => ALPHABET.includes(c)) ? clean : null;
}

async function derive(code: string, info: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('psm-remote-pair-v1'), info: enc.encode(info) }, base, 256);
  return toB64Url(new Uint8Array(bits));
}

/** The private mailbox name and key for a code. */
export async function pairingChannel(code: string): Promise<{ mailbox: string; key: string }> {
  return { mailbox: await derive(code, 'mailbox'), key: await derive(code, 'key') };
}
