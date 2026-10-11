// A small in-memory fake of the five mailbox functions and of the Realtime socket, following supabase/schema.sql.
// For tests only: it plays the part of Supabase for both the PC and the phone.
import type { FetchLike, RemoteConfig } from './client';
import type { SocketLike } from './wake';

interface Shop {
  blocked: boolean;
  firstSeen: number;
  lastSeen: number;
}
interface Msg {
  id: number;
  mailbox: string;
  dir: number;
  body: string;
}

const valid = (m: unknown): m is string => typeof m === 'string' && /^[A-Za-z0-9_-]{43}$/.test(m);

export class FakeSupabase {
  readonly config: RemoteConfig = { url: 'https://fake.supabase.test', anonKey: 'anon-test-key' };
  private shops = new Map<string, Shop>();
  private msgs: Msg[] = [];
  private nextId = 1;
  private sockets = new Set<FakeSocketImpl>();
  realtimeUp = true;
  /** Every call made, for tests that check what was sent. */
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  /** Make every call fail as if offline. */
  offline = false;
  /** Fake clock, in ms. */
  now = Date.now();
  joins = 0;
  /** Called synchronously for every message stored, so a test can play the PC (or the phone) without timers. */
  onSend: ((m: { id: number; mailbox: string; dir: number; body: string }) => void) | null = null;

  readonly fetch: FetchLike = async (url, init) => {
    if (this.offline) throw new Error('offline');
    const fn = url.split('/rest/v1/rpc/')[1] ?? '';
    const args = JSON.parse(init.body) as Record<string, unknown>;
    if (init.headers.apikey !== this.config.anonKey) return this.reply(401, { message: 'invalid_key' });
    this.calls.push({ fn, args });
    try {
      return this.reply(200, this.run(fn, args));
    } catch (e) {
      return this.reply(400, { code: 'P0001', message: (e as Error).message });
    }
  };

  /** A class to pass as the WebSocket implementation. */
  readonly Socket: new (url: string) => SocketLike = socketClass(this);

  private reply(status: number, value: unknown) {
    return { ok: status < 300, status, text: async () => (value === undefined ? '' : JSON.stringify(value)) };
  }

  private run(fn: string, a: Record<string, unknown>): unknown {
    const mailbox = a.p_mailbox;
    if (!valid(mailbox)) throw new Error('bad_mailbox');
    const dir = a.p_dir as number;
    switch (fn) {
      case 'mb_beat': {
        const shop = this.shops.get(mailbox);
        if (shop) {
          shop.lastSeen = this.now;
          return shop.blocked;
        }
        const recent = [...this.shops.values()].filter((s) => this.now - s.firstSeen < 3_600_000).length;
        if (recent >= 200) throw new Error('too_many_new_shops');
        this.shops.set(mailbox, { blocked: false, firstSeen: this.now, lastSeen: this.now });
        return false;
      }
      case 'mb_seen': {
        const shop = this.shops.get(mailbox);
        return shop ? Math.max(0, Math.floor((this.now - shop.lastSeen) / 1000)) : null;
      }
      case 'mb_send': {
        if (dir !== 0 && dir !== 1) throw new Error('bad_dir');
        const shop = this.shops.get(mailbox);
        if (!shop) throw new Error('mailbox_unknown');
        if (shop.blocked) throw new Error('mailbox_blocked');
        const body = a.p_body;
        if (typeof body !== 'string' || body.length === 0 || body.length > 350_000) throw new Error('body_too_large');
        if (this.msgs.filter((m) => m.mailbox === mailbox && m.dir === dir).length >= 500) throw new Error('mailbox_full');
        const id = this.nextId++;
        this.msgs.push({ id, mailbox, dir, body });
        for (const s of this.sockets) s.wake(mailbox);
        this.onSend?.({ id, mailbox, dir, body });
        return id;
      }
      case 'mb_fetch':
        return this.msgs.filter((m) => m.mailbox === mailbox && m.dir === dir && m.id > ((a.p_after_id as number) ?? 0)).slice(0, 50).map((m) => ({ id: m.id, body: m.body }));
      case 'mb_ack':
        this.msgs = this.msgs.filter((m) => !(m.mailbox === mailbox && m.dir === dir && m.id <= (a.p_up_to_id as number)));
        return null;
      default:
        throw new Error('not_found');
    }
  }

  block(mailbox: string, blocked = true): void {
    const s = this.shops.get(mailbox);
    if (s) s.blocked = blocked;
  }
  /** Pretend the PC's last beat was this long ago. */
  ageLastSeen(mailbox: string, seconds: number): void {
    const s = this.shops.get(mailbox);
    if (s) s.lastSeen = this.now - seconds * 1000;
  }
  /** Rows still waiting: (mailbox, dir, body). */
  waiting(): Msg[] {
    return [...this.msgs];
  }
  shopCount(): number {
    return this.shops.size;
  }
  /** Close every open socket, as a network drop would. */
  killSockets(): void {
    for (const s of [...this.sockets]) s.kill();
  }
  setRealtime(on: boolean): void {
    this.realtimeUp = on;
    if (!on) this.killSockets();
  }
  openSockets(): number {
    return this.sockets.size;
  }
  /** @internal */
  register(s: FakeSocketImpl): void {
    this.sockets.add(s);
  }
  /** @internal */
  unregister(s: FakeSocketImpl): void {
    this.sockets.delete(s);
  }
}

class FakeSocketImpl implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private topics = new Set<string>();
  private dead = false;

  constructor(
    _url: string,
    private fake: FakeSupabase,
  ) {
    setTimeout(() => {
      if (!fake.realtimeUp) {
        this.dead = true;
        this.onerror?.({});
        return;
      }
      fake.register(this);
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    if (this.dead) return;
    const { topic, event, ref } = JSON.parse(data) as { topic: string; event: string; ref: string };
    if (event === 'phx_join') {
      this.topics.add(topic);
      this.fake.joins++;
      this.emit({ topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref });
    } else if (event === 'phx_leave') this.topics.delete(topic);
    else if (event === 'heartbeat') this.emit({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref });
  }

  wake(mailbox: string): void {
    const topic = `realtime:mb:${mailbox}`;
    if (this.topics.has(topic)) setTimeout(() => this.emit({ topic, event: 'broadcast', payload: { event: 'wake', type: 'broadcast', payload: { dir: 0 } }, ref: null }), 0);
  }

  private emit(frame: Record<string, unknown>): void {
    if (!this.dead) this.onmessage?.({ data: JSON.stringify(frame) });
  }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.fake.unregister(this);
    this.onclose?.({});
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.fake.unregister(this);
  }
}

function socketClass(fake: FakeSupabase): new (url: string) => SocketLike {
  return class extends FakeSocketImpl {
    constructor(url: string) {
      super(url, fake);
    }
  };
}
