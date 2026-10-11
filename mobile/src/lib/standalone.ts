// The Rust core on this phone (stand-alone edition), through the PsmCore Capacitor plugin. Every call is JSON text in,
// JSON text out, exactly the envelope the PC sends: { ok: true, data } or { ok: false, error: { code, params } }.
import { registerPlugin } from '@capacitor/core';
import type { IpcResult } from '@shared/errors';

interface PsmCorePlugin {
  start(): Promise<{ result: string }>;
  run(options: { channel: string; payload: string }): Promise<{ result: string }>;
  exportBackup(options: { name: string }): Promise<{ result: string; path: string }>;
  restoreBackup(): Promise<{ result?: string; cancelled?: boolean }>;
  lastExported(): Promise<{ value: string }>;
  wipe(): Promise<{ result: string }>;
  shareFile(options: { path: string; mime: string; title?: string; whatsapp?: string }): Promise<void>;
  shareBase64(options: { base64: string; name: string; mime: string; title?: string; whatsapp?: string }): Promise<void>;
}

let plugin: PsmCorePlugin = registerPlugin<PsmCorePlugin>('PsmCore');
/** Tests: a fake core. */
export const setCoreForTests = (fake: PsmCorePlugin | null): void => {
  plugin = fake ?? registerPlugin<PsmCorePlugin>('PsmCore');
};

const parse = (text: string): IpcResult<unknown> => {
  try {
    return JSON.parse(text) as IpcResult<unknown>;
  } catch {
    return { ok: false, error: { code: 'unexpected', params: {} } };
  }
};

/** Opens the data and starts the core. */
export async function startCore(): Promise<IpcResult<unknown>> {
  return parse((await plugin.start()).result);
}

/** One channel call to this phone's own core, as the owner. */
export async function runLocal(channel: string, input: unknown): Promise<IpcResult<unknown>> {
  return parse((await plugin.run({ channel, payload: JSON.stringify(input ?? null) })).result);
}

/** Builds the backup zip and returns its path (for the share menu). */
export async function exportBackup(name: string): Promise<{ result: IpcResult<unknown>; path: string }> {
  const out = await plugin.exportBackup({ name });
  return { result: parse(out.result), path: out.path };
}

/** Asks for a backup file and restores it. Null when the person cancelled. */
export async function restoreBackup(): Promise<IpcResult<unknown> | null> {
  const out = await plugin.restoreBackup();
  return out.cancelled || !out.result ? null : parse(out.result);
}

export async function lastExported(): Promise<string | null> {
  return (await plugin.lastExported()).value || null;
}

/** Erases this phone's own data (moving to a shop PC). */
export async function wipeCore(): Promise<IpcResult<unknown>> {
  return parse((await plugin.wipe()).result);
}

/** The Android share menu, with WhatsApp to the customer's number first when it is installed. */
/** A picture or PDF made in the web view, handed to the share menu (WhatsApp to the customer's number first). */
export const shareBase64 = (options: { base64: string; name: string; mime: string; title?: string; whatsapp?: string }): Promise<void> => plugin.shareBase64(options);

export const shareFile = (options: { path: string; mime: string; title?: string; whatsapp?: string }): Promise<void> => plugin.shareFile(options);
