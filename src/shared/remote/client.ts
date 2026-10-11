// The five mailbox functions over HTTPS (/rest/v1/rpc/<name>) with the public anon key. Same contract as the Rust
// crate in remote/. Knowing a mailbox name is what grants access to it: never log or show one.

export interface RemoteConfig {
  /** The Supabase Project URL. Public by design. */
  url: string;
  /** The anon public key. Public by design. Never the service_role key. */
  anonKey: string;
}
export type Dir = 0 | 1;
/** 0 = to the PC, 1 = to the phone. */
export const TO_PC: Dir = 0;
export const TO_PHONE: Dir = 1;

export type RemoteErrorCode =
  | 'mailbox_blocked'
  | 'mailbox_full'
  | 'mailbox_unknown'
  | 'body_too_large'
  | 'bad_mailbox'
  | 'too_many_new_shops'
  | 'no_internet'
  | 'server'
  // raised by the phone side
  | 'shop_offline'
  | 'shop_timeout';

export class RemoteError extends Error {
  constructor(
    public code: RemoteErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface Row {
  id: number;
  body: string;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const KNOWN: RemoteErrorCode[] = ['mailbox_blocked', 'mailbox_full', 'mailbox_unknown', 'body_too_large', 'bad_mailbox', 'too_many_new_shops'];

export class Mailbox {
  constructor(
    readonly config: RemoteConfig,
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private timeoutMs = 15_000,
  ) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.config.url.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: this.config.anonKey, Authorization: `Bearer ${this.config.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      text = await res.text();
    } catch {
      throw new RemoteError('no_internet');
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return text ? (JSON.parse(text) as unknown) : null;
    let message = `http_${res.status}`;
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof m === 'string') message = m;
    } catch {
      /* not JSON */
    }
    throw new RemoteError(KNOWN.includes(message as RemoteErrorCode) ? (message as RemoteErrorCode) : 'server', message);
  }

  /** The PC's heartbeat. True when the shop is blocked. */
  async beat(mailbox: string, shopId: string, name: string): Promise<boolean> {
    return (await this.rpc('mb_beat', { p_mailbox: mailbox, p_shop_id: shopId, p_name: name })) === true;
  }
  /** Seconds since the PC's last beat, or null when it was never seen. */
  async seen(mailbox: string): Promise<number | null> {
    const v = await this.rpc('mb_seen', { p_mailbox: mailbox });
    return typeof v === 'number' ? v : null;
  }
  async send(mailbox: string, dir: Dir, body: string): Promise<number> {
    const v = await this.rpc('mb_send', { p_mailbox: mailbox, p_dir: dir, p_body: body });
    if (typeof v !== 'number') throw new RemoteError('server', 'bad_reply');
    return v;
  }
  /** Up to 50 rows after `afterId`, oldest first. */
  async fetch(mailbox: string, dir: Dir, afterId: number): Promise<Row[]> {
    const v = await this.rpc('mb_fetch', { p_mailbox: mailbox, p_dir: dir, p_after_id: afterId });
    if (!Array.isArray(v)) throw new RemoteError('server', 'bad_reply');
    return v as Row[];
  }
  async ack(mailbox: string, dir: Dir, upToId: number): Promise<void> {
    await this.rpc('mb_ack', { p_mailbox: mailbox, p_dir: dir, p_up_to_id: upToId });
  }
}
