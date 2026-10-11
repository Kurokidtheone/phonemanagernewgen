// The manager password in stand-alone mode: a protected section asks for it when it is first touched, then the call
// that was refused is made again. Same rule as the desktop (one unlock covers every protected section).
import { useSyncExternalStore } from 'react';

interface Waiting {
  resolve: (unlocked: boolean) => void;
}
let waiting: Waiting | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

/** Resolves true once the password was accepted, false when the person gave up. */
export function requestUnlock(): Promise<boolean> {
  if (waiting) return new Promise((resolve) => {
    const previous = waiting!;
    waiting = { resolve: (ok) => (previous.resolve(ok), resolve(ok)) };
  });
  return new Promise((resolve) => {
    waiting = { resolve };
    emit();
  });
}

export const unlockRequested = (): boolean => waiting !== null;

export function answerUnlock(unlocked: boolean): void {
  const w = waiting;
  waiting = null;
  emit();
  w?.resolve(unlocked);
}

export const useUnlockRequested = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting !== null,
  );
