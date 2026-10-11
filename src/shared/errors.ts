// Errors that cross the IPC boundary. `code` is an i18n key under "errors.<code>".
export class AppError extends Error {
  constructor(
    public code: string,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; params: Record<string, string | number> } };
