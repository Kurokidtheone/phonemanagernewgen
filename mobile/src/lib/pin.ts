// The app PIN: asked every time the app opens, so the shop's data on a lost phone is not one tap away. Only a salted
// hash is kept (PBKDF2). Five wrong tries lock the screen for 30 seconds, doubling each time.
import { Preferences } from '@capacitor/preferences';
import { useSyncExternalStore } from 'react';

const KEY = 'pin';
const ITERATIONS = 150_000;
export type PinStatus = 'unknown' | 'locked' | 'needs_set' | 'open';

let status: PinStatus = 'unknown';
const listeners = new Set<() => void>();
const setStatus = (next: PinStatus): void => {
  status = next;
  listeners.forEach((l) => l());
};
export const usePinStatus = (): PinStatus =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );

export const isValidPin = (pin: string): boolean => /^\d{4,6}$/.test(pin);

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function hash(pin: string, salt: Uint8Array): Promise<string> {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS }, base, 256);
  return b64(new Uint8Array(bits));
}

async function stored(): Promise<{ salt: string; hash: string } | null> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    return value ? (JSON.parse(value) as { salt: string; hash: string }) : null;
  } catch {
    return null;
  }
}

/** Called once the app has loaded: is there a PIN to ask for? `paired` is false before pairing (nothing to protect). */
export async function initPin(paired: boolean): Promise<void> {
  if (!paired) return setStatus('open');
  setStatus((await stored()) ? 'locked' : 'needs_set');
}

export async function setPin(pin: string): Promise<void> {
  if (!isValidPin(pin)) throw new Error('bad_pin');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  await Preferences.set({ key: KEY, value: JSON.stringify({ salt: b64(salt), hash: await hash(pin, salt) }) });
  setStatus('open');
}

export async function clearPin(): Promise<void> {
  try {
    await Preferences.remove({ key: KEY });
  } catch {
    /* nothing stored, or not on a phone */
  }
}

let wrong = 0;
let lockedUntil = 0;
let lockSeconds = 30;
export const lockedFor = (): number => Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));

/** True when the PIN is right (the app opens). Wrong tries are counted; after five the screen locks for a while. */
export async function verifyPin(pin: string): Promise<boolean> {
  if (lockedFor() > 0) return false;
  const saved = await stored();
  if (!saved) return false;
  const ok = (await hash(pin, unb64(saved.salt))) === saved.hash;
  if (ok) {
    wrong = 0;
    lockSeconds = 30;
    setStatus('open');
    return true;
  }
  wrong += 1;
  if (wrong >= 5) {
    wrong = 0;
    lockedUntil = Date.now() + lockSeconds * 1000;
    lockSeconds *= 2;
  }
  return false;
}
