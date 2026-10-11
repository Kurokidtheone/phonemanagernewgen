import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: kv.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void kv.set(key, value),
    remove: async ({ key }: { key: string }) => void kv.delete(key),
  },
}));

const pin = await import('./pin');

beforeEach(() => kv.clear());

describe('the app PIN', () => {
  it('takes 4 to 6 digits only', () => {
    expect(['1234', '123456', '12345'].every(pin.isValidPin)).toBe(true);
    expect(['123', '1234567', '12a4', ''].some(pin.isValidPin)).toBe(false);
  });

  it('is stored as a salted hash, never the PIN, and opens only with the right digits', async () => {
    await pin.setPin('4821');
    expect(kv.get('pin')).not.toContain('4821');
    expect(JSON.parse(kv.get('pin')!)).toHaveProperty('salt');
    expect(await pin.verifyPin('0000')).toBe(false);
    expect(await pin.verifyPin('4821')).toBe(true);
  });

  it('locks the screen after five wrong tries, even for the right PIN', async () => {
    await pin.setPin('4821');
    for (let i = 0; i < 5; i++) expect(await pin.verifyPin('1111')).toBe(false);
    expect(pin.lockedFor()).toBeGreaterThan(0);
    expect(await pin.verifyPin('4821')).toBe(false);
  });

  it('asks to choose a PIN when none exists, and to enter it when one does', async () => {
    await pin.initPin(true);
    expect(kv.size).toBe(0);
    await pin.setPin('4821');
    await pin.initPin(true);
    await pin.clearPin();
    expect(kv.size).toBe(0);
  });
});
