import { afterEach, describe, expect, it } from 'vitest';
import { assertAllowedUrl, http, isPrivateHost, NetworkError, setTransport } from './http';

afterEach(() => setTransport(null));

describe('plain http is for the shop network only', () => {
  it('knows the private addresses', () => {
    for (const host of ['192.168.1.20', '10.0.0.5', '172.16.0.1', '172.31.255.255', '169.254.1.1', '127.0.0.1', 'localhost']) expect(isPrivateHost(host), host).toBe(true);
    for (const host of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', 'relay.example.com', '11.0.0.1', '192.168.1']) expect(isPrivateHost(host), host).toBe(false);
  });

  it('allows http to a private address and https to anywhere, and refuses http elsewhere', () => {
    expect(() => assertAllowedUrl('http://192.168.1.20:4780/hello')).not.toThrow();
    expect(() => assertAllowedUrl('https://relay.example.com/r/X/hello')).not.toThrow();
    expect(() => assertAllowedUrl('http://relay.example.com/r/X/hello')).toThrowError(NetworkError);
    expect(() => assertAllowedUrl('http://8.8.8.8/hello')).toThrowError(NetworkError);
    expect(() => assertAllowedUrl('ftp://192.168.1.20/x')).toThrowError(NetworkError);
  });

  it('never sends a request that is not allowed', async () => {
    let sent = 0;
    setTransport(async () => {
      sent += 1;
      return { status: 200, data: {} };
    });
    await expect(http({ url: 'http://relay.example.com/x', method: 'GET', timeoutMs: 100 })).rejects.toBeInstanceOf(NetworkError);
    await http({ url: 'https://relay.example.com/x', method: 'GET', timeoutMs: 100 });
    await http({ url: 'http://10.1.2.3:4780/x', method: 'GET', timeoutMs: 100 });
    expect(sent).toBe(2);
  });
});
