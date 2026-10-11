// What the phone remembers, in Capacitor Preferences (Android SharedPreferences).
import { Preferences } from '@capacitor/preferences';
import type { Language } from '@shared/app.config';
import type { RemoteMode } from '@shared/schemas';

export interface SavedSession {
  serverId: string;
  /** The PC's address on the shop network. Empty for a phone linked from another network. */
  host: string;
  port: number;
  token: string;
  deviceName: string;
  /** This phone's id on the PC (used for temporary receipt numbers). Absent before phase 17. */
  deviceId?: string;
  /** Every address the QR code listed: their /24 networks are searched when the PC changes address. */
  hosts: string[];
  storeName: string;
  /** The outside route: this phone's mailbox and key (given once at pairing) and the public Supabase address. */
  remote?: SavedRemote;
  /** What the PC last said about outside access: off, full or view only. */
  remoteMode?: RemoteMode;
}

export interface SavedRemote {
  mailbox: string;
  key: string;
  deviceId: string;
  url: string;
  anonKey: string;
}

const KEY = 'session';
const LANGUAGE = 'language';

export async function loadSession(): Promise<SavedSession | null> {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return null;
  try {
    const s = JSON.parse(value) as Partial<SavedSession>;
    // A phone linked from another network has no shop address (host is empty).
    return s.serverId && s.token ? ({ deviceName: '', hosts: [], storeName: '', ...s } as SavedSession) : null;
  } catch {
    return null;
  }
}
export const saveSession = (s: SavedSession): Promise<void> => Preferences.set({ key: KEY, value: JSON.stringify(s) });
export const clearSession = (): Promise<void> => Preferences.remove({ key: KEY });

export async function loadLanguage(): Promise<Language | null> {
  const { value } = await Preferences.get({ key: LANGUAGE });
  return value === 'ar' || value === 'fr' || value === 'en' ? value : null;
}
export const saveLanguage = (l: Language): Promise<void> => Preferences.set({ key: LANGUAGE, value: l });
