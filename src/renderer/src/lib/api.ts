// The only way the UI talks to the Rust core: api('channel', input), a Tauri command.
// Channels and their types come from core/src/api.rs (generated into src/shared/api.ts).
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import type { Api } from '@shared/api';
import type { IpcResult } from '@shared/errors';

export class ApiError extends Error {
  constructor(
    public code: string,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export async function api<K extends keyof Api>(channel: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  const result = await invoke<IpcResult<Awaited<ReturnType<Api[K]>>>>('api', { channel, payload: args[0] ?? null });
  if (!result.ok) throw new ApiError(result.error.code, result.error.params);
  return result.data;
}

/** A sentence the user can act on, in their language, for any error. */
export function errorText(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) return t(`errors.${err.code}`, { ...err.params, defaultValue: t('errors.unexpected') });
  return t('errors.unexpected');
}

/** URL of a file stored by the app (logo, photo, receipt), served by the appfile protocol. */
export const fileUrl = (name: string): string => convertFileSrc(name, 'appfile');

/** What a channel returns, for typing rows and props: ApiResult<'units.list'>[number]. */
export type ApiResult<K extends keyof Api> = Awaited<ReturnType<Api[K]>>;
