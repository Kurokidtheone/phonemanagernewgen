// The receive draft as a store, saved to Preferences on every change: it survives a lost connection (the
// not-connected screen replaces the app) and a restart of the app.
import { Preferences } from '@capacitor/preferences';
import { useSyncExternalStore } from 'react';
import { newDraft, type Draft } from './receive';

const KEY = 'draft.receive';
let draft: Draft | null = null;
const listeners = new Set<() => void>();

export async function loadDraft(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    const parsed = value ? (JSON.parse(value) as Draft) : null;
    draft = parsed && parsed.requestId && Array.isArray(parsed.phones) && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    draft = null;
  }
  listeners.forEach((l) => l());
}

export const getDraft = (): Draft | null => draft;

export function setDraft(next: Draft | null): void {
  draft = next;
  listeners.forEach((l) => l());
  void (draft ? Preferences.set({ key: KEY, value: JSON.stringify(draft) }) : Preferences.remove({ key: KEY }));
}

export const startDraft = (): Draft => {
  const d = newDraft();
  setDraft(d);
  return d;
};
export const useDraft = (): Draft | null =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => draft,
  );
