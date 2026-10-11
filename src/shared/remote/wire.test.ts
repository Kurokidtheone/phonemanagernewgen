import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Assembler, MAX_PART_CHARS, newKey, newMailbox, open, openJson, pack, seal, sealJson, toB64Url, WireError, type Sealed } from './wire';

const enc = new TextEncoder();
const dec = new TextDecoder();
const vectors = JSON.parse(readFileSync(new URL('../../../wire/vectors.json', import.meta.url), 'utf8')) as Record<string, { key: string; mailbox: string; device: string; plain: string; sealed: Sealed }>;

describe('wire (TypeScript side)', () => {
  it('opens a message sealed by the Rust crate', () => {
    const v = vectors.from_rust;
    expect(dec.decode(open(v.key, v.mailbox, v.device, v.sealed))).toBe(v.plain);
  });
  it('opens a message sealed by this code (the Rust tests open the same file)', () => {
    const v = vectors.from_ts;
    expect(dec.decode(open(v.key, v.mailbox, v.device, v.sealed))).toBe(v.plain);
  });

  it('round trips JSON', () => {
    const key = newKey();
    const mailbox = newMailbox();
    const req = { id: 'a', ts: 1, method: 'POST', path: '/api/x', body: { n: 'é' } };
    expect(openJson(key, mailbox, 'dev', sealJson(key, mailbox, 'dev', req))).toEqual(req);
  });
  it('uses a fresh nonce each time', () => {
    const key = newKey();
    const mailbox = newMailbox();
    const a = seal(key, mailbox, 'd', enc.encode('same'));
    const b = seal(key, mailbox, 'd', enc.encode('same'));
    expect(a.n).not.toBe(b.n);
  });
  it('fails with another key, other associated data or a flipped byte', () => {
    const key = newKey();
    const mailbox = newMailbox();
    const s = seal(key, mailbox, 'dev', enc.encode('hello world'));
    expect(() => open(newKey(), mailbox, 'dev', s)).toThrow(WireError);
    expect(() => open(key, newMailbox(), 'dev', s)).toThrow(WireError);
    expect(() => open(key, mailbox, 'other', s)).toThrow(WireError);
    const c = Uint8Array.from(atob(s.c.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.c.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
    c[0] ^= 1;
    expect(() => open(key, mailbox, 'dev', { n: s.n, c: toB64Url(c) })).toThrow(WireError);
  });
  it('splits a 2 MB message and joins it in any order', () => {
    const key = newKey();
    const mailbox = newMailbox();
    const plain = new Uint8Array(2_000_000).map((_, i) => i % 251);
    const bodies = pack('big', seal(key, mailbox, 'dev', plain)).reverse();
    expect(bodies.length).toBeGreaterThan(5);
    expect(bodies.every((b) => b.length <= MAX_PART_CHARS)).toBe(true);
    const a = new Assembler();
    let done: Sealed | null = null;
    for (const b of bodies) done = a.push(b) ?? done;
    expect(open(key, mailbox, 'dev', done!)).toEqual(plain);
    expect(a.pending).toBe(0);
  });
  it('refuses over 6 MB and bad parts', () => {
    const key = newKey();
    const s = seal(key, newMailbox(), 'd', new Uint8Array(5_000_000));
    expect(() => pack('x', s)).toThrow(WireError);
    const a = new Assembler();
    expect(() => a.push('not json')).toThrow(WireError);
    expect(() => a.push(JSON.stringify({ id: 'q', i: 0, of: 2, part: 'x' }))).toThrow(WireError);
    expect(() => a.push(JSON.stringify({ id: 'q', i: 1, of: 500, part: 'x' }))).toThrow(WireError);
  });
});
