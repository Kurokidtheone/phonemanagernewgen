// The cart as a store kept in Preferences: a lost connection or a restart does not empty it.
import { Preferences } from '@capacitor/preferences';
import { useSyncExternalStore } from 'react';
import { newCart, type Cart } from './cart';

const KEY = 'cart';
let cart: Cart = newCart();
const listeners = new Set<() => void>();

export async function loadCart(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    const parsed = value ? (JSON.parse(value) as Cart) : null;
    if (parsed && parsed.requestId && Array.isArray(parsed.lines)) cart = parsed;
  } catch {
    /* start with an empty cart */
  }
  listeners.forEach((l) => l());
}

export const getCart = (): Cart => cart;
export function setCart(next: Cart): void {
  cart = next;
  listeners.forEach((l) => l());
  void Preferences.set({ key: KEY, value: JSON.stringify(next) });
}
export const clearCart = (): void => setCart(newCart());
export const useCart = (): Cart =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cart,
  );
