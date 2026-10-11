// One Realtime WebSocket, joined to the public topic "mb:<mailbox>" of each mailbox it is given. A wake-up is only a
// hint that something is waiting: everything also works by polling mb_fetch, so a lost socket never loses a message.
import type { RemoteConfig } from './client';

/** The part of the browser WebSocket (also implemented by the `ws` package) this file uses. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface WakeOptions {
  config: RemoteConfig;
  socket: SocketCtor;
  /** Called with the mailbox that was woken. */
  onWake: (mailbox: string) => void;
  onState?: (connected: boolean) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatMs?: number;
}

export function websocketUrl(config: RemoteConfig): string {
  const base = config.url.replace(/\/+$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(config.anonKey)}&vsn=1.0.0`;
}

export class WakeListener {
  private mailboxes = new Set<string>();
  private joined = new Set<string>();
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private delay: number;
  private ref = 1;
  private stopped = true;
  private up = false;
  private open = false;

  constructor(private o: WakeOptions) {
    this.delay = o.minBackoffMs ?? 2000;
  }

  get connected(): boolean {
    return this.up;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.setUp(false);
  }

  /** The mailboxes to listen to. Safe to call at any time. */
  setMailboxes(list: string[]): void {
    const next = new Set(list);
    for (const m of this.joined) if (!next.has(m)) this.leave(m);
    this.mailboxes = next;
    for (const m of next) this.join(m);
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    this.o.onState?.(up);
  }

  private topic = (mailbox: string): string => `realtime:mb:${mailbox}`;

  private join(mailbox: string): void {
    if (!this.socket || !this.open || this.joined.has(mailbox)) return;
    this.joined.add(mailbox);
    const ref = String(this.ref++);
    this.send({ topic: this.topic(mailbox), event: 'phx_join', payload: { config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [], private: false } }, ref, join_ref: ref });
  }
  private leave(mailbox: string): void {
    this.joined.delete(mailbox);
    this.send({ topic: this.topic(mailbox), event: 'phx_leave', payload: {}, ref: String(this.ref++) });
  }
  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* the socket is going away; onclose reconnects */
    }
  }

  private drop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    const s = this.socket;
    this.socket = null;
    this.open = false;
    this.joined.clear();
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = new this.o.socket(websocketUrl(this.o.config));
    } catch {
      return this.retry();
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.open = true;
      // "up" once the first join is answered.
      for (const m of this.mailboxes) this.join(m);
      if (this.mailboxes.size === 0) this.setUp(true);
      this.beat = setInterval(() => this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(this.ref++) }), this.o.heartbeatMs ?? 25_000);
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let frame: unknown;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Protocol 1.0.0 sends JSON objects (2.0.0 sends broadcasts as binary frames, which are not used here).
      if (!frame || typeof frame !== 'object' || typeof (frame as { topic?: unknown }).topic !== 'string') return;
      const { topic, event, payload } = frame as { topic: string; event: string; payload?: { status?: string } };
      if (!topic.startsWith('realtime:mb:')) return;
      const mailbox = topic.slice('realtime:mb:'.length);
      if (event === 'phx_reply' && payload?.status === 'ok') {
        this.delay = this.o.minBackoffMs ?? 2000;
        this.setUp(true);
        this.o.onWake(mailbox); // anything sent while we were not joined
      } else if (event === 'broadcast') this.o.onWake(mailbox);
      else if (event === 'phx_close' || event === 'phx_error') this.joined.delete(mailbox);
    };
    const lost = (): void => {
      if (this.socket !== socket) return;
      this.drop();
      this.setUp(false);
      if (!opened) this.delay = Math.min(this.delay, this.o.maxBackoffMs ?? 60_000);
      this.retry();
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.o.maxBackoffMs ?? 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }
}
