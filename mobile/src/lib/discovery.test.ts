import { afterEach, describe, expect, it } from 'vitest';
import { candidatePrefixes, firstHello, hello, isIpv4, parseQr, prefixOf, scanSubnet } from './discovery';
import { setTransport } from './http';

afterEach(() => setTransport(null));

const helloBody = (serverId: string) => ({ app: 'PSM', serverId, storeName: 'Shop', appVersion: '1.0.0', apiVersion: 1 });
/** A LAN where only these hosts answer /hello. */
function lan(hosts: Record<string, string>, stats = { inFlight: 0, maxInFlight: 0, timeouts: [] as number[] }) {
  setTransport(async ({ url, timeoutMs }) => {
    stats.timeouts.push(timeoutMs);
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    stats.inFlight -= 1;
    const host = /^http:\/\/([\d.]+):/.exec(url)![1];
    if (!(host in hosts)) throw new Error('unreachable');
    return { status: 200, data: helloBody(hosts[host]) };
  });
  return stats;
}

describe('pairing QR', () => {
  const good = { v: 1, id: 'abc', name: 'Shop', hosts: ['192.168.1.20', '10.0.0.5'], port: 4780, code: '123456' };
  it('reads the QR the PC shows', () => {
    expect(parseQr(JSON.stringify(good))).toEqual(good);
  });
  it('rejects anything else', () => {
    for (const bad of ['hello', '{}', JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, code: '12' }), JSON.stringify({ ...good, hosts: [] }), JSON.stringify({ ...good, hosts: ['evil.example'] }), JSON.stringify({ ...good, port: 70000 })]) {
      expect(parseQr(bad), bad).toBeNull();
    }
  });
  it('checks IPv4 addresses and takes their /24', () => {
    expect(isIpv4('192.168.1.20')).toBe(true);
    expect(isIpv4('192.168.1.300')).toBe(false);
    expect(prefixOf('192.168.1.20')).toBe('192.168.1');
    expect(prefixOf('nope')).toBeNull();
  });
  it('lists networks to search: own first, then last, then the QR addresses, each once', () => {
    expect(candidatePrefixes(['192.168.1.77'], '192.168.1.20', ['10.0.0.5', '192.168.1.20'])).toEqual(['192.168.1', '10.0.0']);
  });
});

describe('/hello', () => {
  it('answers only for this product', async () => {
    setTransport(async () => ({ status: 200, data: { app: 'OTHER', serverId: 'x' } }));
    expect(await hello('192.168.1.2', 4780)).toBeNull();
    lan({ '192.168.1.2': 'S1' });
    expect((await hello('192.168.1.2', 4780))?.serverId).toBe('S1');
    expect(await hello('192.168.1.3', 4780)).toBeNull();
  });

  it('tries every address of the QR and keeps the one with the same serverId', async () => {
    lan({ '10.0.0.5': 'OTHER-PC', '192.168.1.20': 'S1' });
    const found = await firstHello(['10.0.0.5', '192.168.1.99', '192.168.1.20'], 4780, 'S1');
    expect(found?.host).toBe('192.168.1.20');
    expect(await firstHello(['192.168.1.99'], 4780, 'S1')).toBeNull();
  });
});

describe('searching a /24', () => {
  it('finds the PC with the same serverId, asking 40 at a time with an 800 ms timeout', async () => {
    const stats = lan({ '192.168.1.150': 'S1', '192.168.1.60': 'OTHER' });
    expect(await scanSubnet('192.168.1', 4780, 'S1')).toBe('192.168.1.150');
    expect(stats.maxInFlight).toBeLessThanOrEqual(40);
    expect(stats.maxInFlight).toBeGreaterThan(10);
    expect(new Set(stats.timeouts)).toEqual(new Set([800]));
  });

  it('returns null when nothing answers', async () => {
    lan({});
    expect(await scanSubnet('192.168.1', 4780, 'S1')).toBeNull();
  });
});
