// The camera scanner. startScan() of @capacitor-mlkit/barcode-scanning uses the ML Kit model that is bundled in
// the app (com.google.mlkit:barcode-scanning): no download, no internet. The plugin's scan() uses Google's code
// scanner module from Play Services, which may download: never used here.
//
// One session stays open and reads code after code: each accepted read gets a beep and a vibration, is passed to the
// screen's handler, and is listed under the preview. The same code within 2 seconds is ignored. In IMEI mode a read
// is checked with isValidImei before it is accepted.
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { useSyncExternalStore } from 'react';
import { isValidImei } from '@shared/imei';

export const DUPLICATE_WINDOW_MS = 2000;

export interface ScanFeedback {
  ok: boolean;
  message: string;
  /** Close the scanner after this read (single-scan uses). */
  close?: boolean;
}
export interface ScanEntry {
  code: string;
  ok: boolean;
  message: string;
  at: number;
}
export interface ScanOptions {
  title: string;
  /** Only valid IMEIs are accepted; anything else is shown as refused and the handler is not called. */
  imei?: boolean;
  onRead: (code: string) => Promise<ScanFeedback> | ScanFeedback;
}
interface Session {
  options: ScanOptions;
  entries: ScanEntry[];
  torchAvailable: boolean;
  torchOn: boolean;
}

export type ScanFailure = 'denied' | 'unsupported';
export class ScanError extends Error {
  constructor(public reason: ScanFailure) {
    super(reason);
  }
}

let session: Session | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useScanSession = (): Session | null => useSyncExternalStore(subscribe, () => session);
export const useScanning = (): boolean => useScanSession() !== null;

let closeSession: (() => void) | null = null;
export const cancelScan = (): void => closeSession?.();

export async function toggleTorch(): Promise<void> {
  if (!session?.torchAvailable) return;
  await BarcodeScanner.toggleTorch();
  session = { ...session, torchOn: !session.torchOn };
  notify();
}

// ---- feedback: a short beep, a short vibration ----
let audio: AudioContext | null = null;
function beep(ok: boolean): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1200 : 300;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.09 : 0.25));
  } catch {
    /* no audio: the vibration and the list still tell */
  }
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
  } catch {
    /* no vibrator */
  }
}

const FORMATS = [BarcodeFormat.QrCode, BarcodeFormat.Code128, BarcodeFormat.Code39, BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Itf, BarcodeFormat.Codabar, BarcodeFormat.DataMatrix];

/**
 * The reading logic, apart from the camera so it can be tested: a queue of codes in, feedback out.
 * Returns what to do with one raw read.
 */
export function createReader(options: ScanOptions, hooks: { add: (entry: ScanEntry) => void; close: () => void; now?: () => number }) {
  const now = hooks.now ?? Date.now;
  const lastSeen = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const handle = async (code: string): Promise<void> => {
    if (options.imei && !isValidImei(code)) {
      hooks.add({ code, ok: false, message: '', at: now() }); // the screen words this refusal itself (see badImei)
      beep(false);
      return;
    }
    let feedback: ScanFeedback;
    try {
      feedback = await options.onRead(code);
    } catch (err) {
      feedback = { ok: false, message: err instanceof Error ? err.message : 'error' };
    }
    hooks.add({ code, ok: feedback.ok, message: feedback.message, at: now() });
    beep(feedback.ok);
    if (feedback.close) hooks.close();
  };

  /** Reads come in many times a second while a code stays in view. */
  return (raw: string | undefined): void => {
    const code = raw?.trim();
    if (!code) return;
    const t = now();
    const seen = lastSeen.get(code);
    if (seen !== undefined && t - seen < DUPLICATE_WINDOW_MS) return;
    lastSeen.set(code, t);
    chain = chain.then(() => handle(code));
  };
}

/** Opens the camera and keeps reading until the user closes it. Throws ScanError when the camera cannot be used. */
export async function openScanner(options: ScanOptions): Promise<void> {
  if (session) return;
  const { supported } = await BarcodeScanner.isSupported();
  if (!supported) throw new ScanError('unsupported');
  const permission = await BarcodeScanner.requestPermissions();
  if (permission.camera !== 'granted' && permission.camera !== 'limited') throw new ScanError('denied');

  session = { options, entries: [], torchAvailable: false, torchOn: false };
  document.documentElement.classList.add('scanning');
  notify();
  let failure: unknown;
  try {
    await new Promise<void>((resolve) => {
      closeSession = resolve;
      const read = createReader(options, {
        add: (entry) => {
          if (session) session = { ...session, entries: [entry, ...session.entries].slice(0, 8) };
          notify();
        },
        close: resolve,
      });
      void BarcodeScanner.addListener('barcodesScanned', (event) => read(event.barcodes[0]?.rawValue));
      BarcodeScanner.startScan({ formats: FORMATS })
        .then(async () => {
          const { available } = await BarcodeScanner.isTorchAvailable().catch(() => ({ available: false }));
          if (session) session = { ...session, torchAvailable: available };
          notify();
        })
        .catch((err) => {
          failure = err;
          resolve();
        });
    });
  } finally {
    closeSession = null;
    await BarcodeScanner.removeAllListeners();
    await BarcodeScanner.stopScan().catch(() => undefined);
    document.documentElement.classList.remove('scanning');
    session = null;
    notify();
  }
  if (failure) throw failure;
}

/** One code, then the camera closes. Resolves null when the user cancels. */
export async function scanCode(options: { imei?: boolean; title?: string } = {}): Promise<string | null> {
  let found: string | null = null;
  await openScanner({
    title: options.title ?? '',
    imei: options.imei,
    onRead: (code) => {
      found = code;
      return { ok: true, message: code, close: true };
    },
  });
  return found;
}
