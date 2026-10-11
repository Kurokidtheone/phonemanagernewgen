// The Bluetooth thermal printer: which one (chosen once, remembered), and sending it a picture.
// The paper width is the only thing that changes how the picture is scaled: 58 mm is 384 dots, 80 mm is 576.
import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { TFunction } from 'i18next';

export interface BtDevice {
  name: string;
  address: string;
}
export interface PrinterConfig extends BtDevice {
  paper: '58' | '80';
  /** Send a partial-cut command at the end. Off by default: printers without a cutter can print garbage for it. */
  cut: boolean;
}
interface BtPrinterPlugin {
  paired(): Promise<{ devices: BtDevice[] }>;
  print(options: { address: string; image: string; dots: number; cut?: boolean }): Promise<void>;
}

const plugin = registerPlugin<BtPrinterPlugin>('BtPrinter');
const KEY = 'printer';
export const DOTS = { '58': 384, '80': 576 } as const;

export async function loadPrinter(): Promise<PrinterConfig | null> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    const p = value ? (JSON.parse(value) as PrinterConfig) : null;
    return p && p.address ? { ...p, paper: p.paper === '58' ? '58' : '80', cut: !!p.cut } : null;
  } catch {
    return null;
  }
}
export const savePrinter = (p: PrinterConfig): Promise<void> => Preferences.set({ key: KEY, value: JSON.stringify(p) });
export const clearPrinter = (): Promise<void> => Preferences.remove({ key: KEY });

export const pairedPrinters = async (): Promise<BtDevice[]> => (await plugin.paired()).devices;

/** Sends a PNG (base64) to the saved printer. Throws an Error whose message is a code, see printerError. */
export async function printImage(base64: string, config?: PrinterConfig | null): Promise<void> {
  const p = config ?? (await loadPrinter());
  if (!p) throw new Error('printer_not_set');
  await plugin.print({ address: p.address, image: base64, dots: DOTS[p.paper], cut: p.cut });
}

const CODES = ['printer_not_set', 'bt_unavailable', 'bt_off', 'bt_permission', 'printer_unreachable', 'bad_image'];

/** The sentence for a printing failure, in the app's language. */
export function printerError(t: TFunction, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = CODES.find((c) => message.includes(c));
  return t(`m.printer.errors.${code ?? 'printer_unreachable'}`);
}
