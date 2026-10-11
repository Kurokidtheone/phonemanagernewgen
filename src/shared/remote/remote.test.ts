import { describe, expect, it } from 'vitest';
import { Mailbox, RemoteError, TO_PC, TO_PHONE } from './client';
import { FakeSupabase } from './fake';
import { Inbox, sendSealed } from './inbox';
import { PhoneLink } from './phone';
import { WakeListener } from './wake';
import { newKey, newMailbox, open, openJson, seal, sealJson, type WireRequest, type WireResponse } from './wire';

const setup = async () => {
  const fake = new FakeSupabase();
  const mb = new Mailbox(fake.config, fake.fetch);
  const mailbox = newMailbox();
  expect(await mb.beat(mailbox, 'shop', 'Shop')).toBe(false);
  return { fake, mb, mailbox };
};
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('mailbox client', () => {
  it('sends, fetches in order, keeps directions apart, acks', async () => {
    const { mb, mailbox } = await setup();
    const a = await mb.send(mailbox, TO_PC, 'one');
    const b = await mb.send(mailbox, TO_PC, 'two');
    await mb.send(mailbox, TO_PHONE, 'reply');
    expect(b).toBeGreaterThan(a);
    expect((await mb.fetch(mailbox, TO_PC, 0)).map((r) => r.body)).toEqual(['one', 'two']);
    expect((await mb.fetch(mailbox, TO_PHONE, 0)).map((r) => r.body)).toEqual(['reply']);
    expect(await mb.fetch(mailbox, TO_PC, a)).toHaveLength(1);
    await mb.ack(mailbox, TO_PC, a);
    expect((await mb.fetch(mailbox, TO_PC, 0)).map((r) => r.body)).toEqual(['two']);
  });
  it('pages 50 at a time and the inbox reads them all once', async () => {
    const { mb, mailbox } = await setup();
    for (let i = 0; i < 120; i++) await mb.send(mailbox, TO_PC, JSON.stringify({ n: 'x', c: String(i) }));
    expect(await mb.fetch(mailbox, TO_PC, 0)).toHaveLength(50);
    const inbox = new Inbox(mb, mailbox, TO_PC);
    expect(await inbox.poll()).toHaveLength(120);
    expect(await inbox.poll()).toHaveLength(0);
  });
  it('reports how long ago the PC was seen', async () => {
    const { fake, mb, mailbox } = await setup();
    expect(await mb.seen(mailbox)).toBeLessThan(5);
    fake.ageLastSeen(mailbox, 90);
    expect(await mb.seen(mailbox)).toBeGreaterThanOrEqual(90);
    expect(await mb.seen(newMailbox())).toBeNull();
  });
  it('joins split messages and reports garbage as bad', async () => {
    const { mb, mailbox } = await setup();
    const key = newKey();
    const plain = new Uint8Array(900_000).map((_, i) => i % 249);
    await sendSealed(mb, mailbox, TO_PC, 'r1', seal(key, mailbox, 'dev', plain));
    await mb.send(mailbox, TO_PC, 'garbage');
    const got = await new Inbox(mb, mailbox, TO_PC).poll();
    expect(got.map((g) => g.kind)).toEqual(['message', 'bad']);
    if (got[0].kind === 'message') expect(open(key, mailbox, 'dev', got[0].sealed)).toEqual(plain);
  });
  it('maps a blocked, unknown, oversized and full mailbox', async () => {
    const { fake, mb, mailbox } = await setup();
    fake.block(mailbox);
    expect(await mb.beat(mailbox, 's', 'n')).toBe(true);
    await expect(mb.send(mailbox, TO_PC, 'x')).rejects.toMatchObject({ code: 'mailbox_blocked' });
    fake.block(mailbox, false);
    await expect(mb.send(newMailbox(), TO_PC, 'x')).rejects.toMatchObject({ code: 'mailbox_unknown' });
    await expect(mb.send('short', TO_PC, 'x')).rejects.toMatchObject({ code: 'bad_mailbox' });
    await expect(mb.send(mailbox, TO_PC, 'a'.repeat(350_001))).rejects.toMatchObject({ code: 'body_too_large' });
    for (let i = 0; i < 500; i++) await mb.send(mailbox, TO_PC, 'x');
    await expect(mb.send(mailbox, TO_PC, 'x')).rejects.toMatchObject({ code: 'mailbox_full' });
    await expect(mb.send(mailbox, TO_PHONE, 'x')).resolves.toBeTypeOf('number');
  });
  it('allows 200 new shops an hour, no more', async () => {
    const fake = new FakeSupabase();
    const mb = new Mailbox(fake.config, fake.fetch);
    for (let i = 0; i < 200; i++) await mb.beat(newMailbox(), 's', 'n');
    await expect(mb.beat(newMailbox(), 's', 'n')).rejects.toMatchObject({ code: 'too_many_new_shops' });
  });
  it('says no_internet when the network is down', async () => {
    const { fake, mb, mailbox } = await setup();
    fake.offline = true;
    await expect(mb.seen(mailbox)).rejects.toMatchObject({ code: 'no_internet' });
  });
});

describe('wake-ups', () => {
  it('arrive through the socket, reconnect after a drop, and are not needed for delivery', async () => {
    const { fake, mb, mailbox } = await setup();
    const woken: string[] = [];
    const l = new WakeListener({ config: fake.config, socket: fake.Socket, onWake: (m) => woken.push(m), minBackoffMs: 20, maxBackoffMs: 80 });
    l.setMailboxes([mailbox]);
    l.start();
    await until(() => l.connected);
    woken.length = 0;
    await mb.send(mailbox, TO_PC, 'hello');
    await until(() => woken.includes(mailbox));
    fake.killSockets();
    await until(() => !l.connected);
    await until(() => l.connected);
    expect(fake.joins).toBeGreaterThanOrEqual(2);
    fake.setRealtime(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(l.connected).toBe(false);
    // Without the socket the message is still there to fetch.
    await mb.send(mailbox, TO_PC, 'still here');
    expect((await mb.fetch(mailbox, TO_PC, 0)).map((r) => r.body)).toContain('still here');
    l.stop();
  });
});

describe('PhoneLink', () => {
  const answerer = (fake: FakeSupabase, mailbox: string, key: string, device: string, status = 200) => {
    // A tiny stand-in for the PC: answers every request with its path.
    const mb = new Mailbox(fake.config, fake.fetch);
    const inbox = new Inbox(mb, mailbox, TO_PC);
    const timer = setInterval(async () => {
      for (const item of await inbox.poll()) {
        if (item.kind !== 'message') continue;
        try {
          const req = openJson<WireRequest>(key, mailbox, device, item.sealed);
          const res: WireResponse = { id: req.id, status, body: { ok: true, echo: req.path } };
          await sendSealed(mb, mailbox, TO_PHONE, req.id, sealJson(key, mailbox, device, res));
        } catch {
          /* cannot open: dropped, like the real PC */
        }
        await inbox.ack(item.lastRow);
      }
    }, 10);
    return () => clearInterval(timer);
  };

  it('gets the answer and acks it', async () => {
    const { fake, mailbox } = await setup();
    const key = newKey();
    const stop = answerer(fake, mailbox, key, 'dev');
    const link = new PhoneLink({ config: fake.config, mailbox, key, deviceId: 'dev', fetchImpl: fake.fetch, socket: fake.Socket, pollMs: 30 });
    const res = await link.request('POST', '/api/units.list', { q: 1 });
    expect(res).toMatchObject({ status: 200, body: { echo: '/api/units.list' } });
    await until(() => fake.waiting().length === 0);
    link.close();
    stop();
  });
  it('says shop_offline at once when the PC has not beaten for over a minute, without sending anything', async () => {
    const { fake, mailbox } = await setup();
    fake.ageLastSeen(mailbox, 61);
    const link = new PhoneLink({ config: fake.config, mailbox, key: newKey(), deviceId: 'dev', fetchImpl: fake.fetch });
    await expect(link.request('GET', '/me')).rejects.toMatchObject({ code: 'shop_offline' });
    expect(fake.waiting()).toHaveLength(0);
  });
  it('times out when nobody answers', async () => {
    const { fake, mailbox } = await setup();
    const link = new PhoneLink({ config: fake.config, mailbox, key: newKey(), deviceId: 'dev', fetchImpl: fake.fetch, pollMs: 20, timeoutMs: 150 });
    await expect(link.request('GET', '/me')).rejects.toBeInstanceOf(RemoteError);
    await expect(link.request('GET', '/me')).rejects.toMatchObject({ code: 'shop_timeout' });
  });
  it('works with the wake-up socket blocked (polling only)', async () => {
    const { fake, mailbox } = await setup();
    fake.setRealtime(false);
    const key = newKey();
    const stop = answerer(fake, mailbox, key, 'dev');
    const link = new PhoneLink({ config: fake.config, mailbox, key, deviceId: 'dev', fetchImpl: fake.fetch, socket: fake.Socket, pollMs: 30, minBackoffMs: 20 });
    expect((await link.request('GET', '/me')).status).toBe(200);
    link.close();
    stop();
  });
  it('ignores answers sealed with another key', async () => {
    const { fake, mailbox } = await setup();
    const link = new PhoneLink({ config: fake.config, mailbox, key: newKey(), deviceId: 'dev', fetchImpl: fake.fetch, pollMs: 20, timeoutMs: 200 });
    const stop = answerer(fake, mailbox, newKey(), 'dev'); // cannot even open the request
    await expect(link.request('GET', '/me')).rejects.toMatchObject({ code: 'shop_timeout' });
    stop();
  });
});
