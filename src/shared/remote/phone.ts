// The phone's side of a request through the mailbox: seen? -> send -> wait for the answer with the same id, on a
// wake-up and by polling every 2 seconds, for 20 seconds at most.
import { Mailbox, RemoteError, TO_PC, TO_PHONE, type RemoteConfig, type FetchLike } from './client';
import { Inbox, sendSealed } from './inbox';
import { type SocketCtor, WakeListener } from './wake';
import { openJson, sealJson, type WireRequest, type WireResponse } from './wire';

export interface PhoneLinkOptions {
  config: RemoteConfig;
  mailbox: string;
  key: string;
  deviceId: string;
  fetchImpl?: FetchLike;
  socket?: SocketCtor;
  /** How old the PC's last beat may be before the shop counts as offline. */
  offlineAfterSec?: number;
  pollMs?: number;
  timeoutMs?: number;
  minBackoffMs?: number;
}

interface Pending {
  resolve: (r: WireResponse) => void;
}

export class PhoneLink {
  private mb: Mailbox;
  private inbox: Inbox;
  private pending = new Map<string, Pending>();
  private wake: WakeListener | null = null;
  private pumping = false;
  private nudge: (() => void) | null = null;
  private closed = false;

  constructor(private o: PhoneLinkOptions) {
    this.mb = new Mailbox(o.config, o.fetchImpl);
    this.inbox = new Inbox(this.mb, o.mailbox, TO_PHONE);
  }

  /** Is the shop PC alive? Throws shop_offline at once when it has not beaten for over a minute. */
  async check(): Promise<void> {
    const age = await this.mb.seen(this.o.mailbox);
    if (age === null || age > (this.o.offlineAfterSec ?? 60)) throw new RemoteError('shop_offline');
  }

  async request(method: string, path: string, body?: unknown, timeoutMs = this.o.timeoutMs ?? 20_000): Promise<WireResponse> {
    if (this.closed) throw new RemoteError('no_internet');
    await this.check();
    const id = globalThis.crypto.randomUUID();
    const req: WireRequest = { id, ts: Date.now(), method, path, body };
    const answer = new Promise<WireResponse>((resolve) => this.pending.set(id, { resolve }));
    try {
      await sendSealed(this.mb, this.o.mailbox, TO_PC, id, sealJson(this.o.key, this.o.mailbox, this.o.deviceId, req));
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    this.startWake();
    void this.pump();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RemoteError('shop_timeout')), timeoutMs);
    });
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private startWake(): void {
    if (this.wake || !this.o.socket) return;
    this.wake = new WakeListener({ config: this.o.config, socket: this.o.socket, onWake: () => this.nudge?.(), minBackoffMs: this.o.minBackoffMs });
    this.wake.setMailboxes([this.o.mailbox]);
    this.wake.start();
  }

  /** Reads answers while any request waits. A wake-up cuts the 2 second sleep short. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.size > 0 && !this.closed) {
        try {
          let ackTo = 0;
          for (const item of await this.inbox.poll()) {
            ackTo = Math.max(ackTo, item.lastRow);
            if (item.kind !== 'message') continue;
            try {
              const res = openJson<WireResponse>(this.o.key, this.o.mailbox, this.o.deviceId, item.sealed);
              this.pending.get(res.id)?.resolve(res);
            } catch {
              /* does not open: not for us, dropped */
            }
          }
          if (ackTo) await this.inbox.ack(ackTo);
        } catch {
          /* a poll failed (no internet): the next one tries again, the request times out by itself */
        }
        if (this.pending.size === 0) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.o.pollMs ?? 2000);
          this.nudge = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.nudge = null;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Whether the wake-up socket is up (the status only: requests work without it). */
  get realtime(): boolean {
    return this.wake?.connected ?? false;
  }

  close(): void {
    this.closed = true;
    this.wake?.stop();
    this.wake = null;
    this.nudge?.();
  }
}
