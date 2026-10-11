// Which edition this install runs as: connected to a shop PC, or alone on this phone. Saved once chosen.
import { Preferences } from '@capacitor/preferences';

export type Mode = 'connected' | 'standalone';
const KEY = 'mode';

export async function loadMode(): Promise<Mode | null> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    return value === 'connected' || value === 'standalone' ? value : null;
  } catch {
    return null;
  }
}
export const saveMode = (mode: Mode): Promise<void> => Preferences.set({ key: KEY, value: mode });
export const clearMode = async (): Promise<void> => {
  try {
    await Preferences.remove({ key: KEY });
  } catch {
    /* nothing saved */
  }
};
