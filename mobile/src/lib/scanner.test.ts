import { describe, expect, it, vi } from 'vitest';
import { makeImei } from '@shared/imei';
import { createReader, type ScanEntry, type ScanFeedback } from './scanner';

const IMEI_A = makeImei('35000000000001');
const IMEI_B = makeImei('35000000000002');

function reader(options: { imei?: boolean; onRead?: (code: string) => Promise<ScanFeedback> | ScanFeedback } = {}) {
  let clock = 1000;
  const entries: ScanEntry[] = [];
  const onRead = vi.fn(options.onRead ?? ((code: string) => ({ ok: true, message: code })));
  const close = vi.fn();
  const read = createReader({ title: 't', imei: options.imei, onRead }, { add: (e) => entries.push(e), close, now: () => clock });
  return { read, entries, onRead, close, tick: (ms: number) => (clock += ms) };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the continuous scanner', () => {
  it('ignores the same code seen again within 2 seconds, and accepts it after', async () => {
    const { read, entries, onRead, tick } = reader();
    read('ABC');
    tick(500);
    read('ABC');
    tick(1000);
    read('ABC'); // 1.5 s after the first read
    await settle();
    expect(onRead).toHaveBeenCalledTimes(1);
    tick(2000);
    read('ABC');
    await settle();
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
  });

  it('reads five labels in a row, one after the other, without anything in between', async () => {
    const { read, entries, onRead } = reader({ imei: true });
    const imeis = [1, 2, 3, 4, 5].map((n) => makeImei(`3500000000000${n}`));
    imeis.forEach(read);
    await settle();
    expect(onRead.mock.calls.map((c) => c[0])).toEqual(imeis);
    expect(entries.map((e) => e.code)).toEqual(imeis);
    expect(entries.every((e) => e.ok)).toBe(true);
  });

  it('checks IMEIs with isValidImei before accepting: a bad one is refused and never reaches the screen logic', async () => {
    const { read, entries, onRead } = reader({ imei: true });
    read('123456789012345'); // 15 digits, bad check digit
    read('12345');
    read(IMEI_A);
    await settle();
    expect(onRead.mock.calls.map((c) => c[0])).toEqual([IMEI_A]);
    expect(entries.filter((e) => !e.ok)).toHaveLength(2);
  });

  it('lists what the screen says about a read, including a refusal', async () => {
    const { read, entries } = reader({ onRead: (code) => ({ ok: code === IMEI_A, message: code === IMEI_A ? 'added' : 'already in stock' }) });
    read(IMEI_A);
    read(IMEI_B);
    await settle();
    expect(entries.map((e) => [e.ok, e.message])).toEqual([[true, 'added'], [false, 'already in stock']]);
  });

  it('closes after a read when the feedback asks for it, and survives a handler that throws', async () => {
    const closing = reader({ onRead: () => ({ ok: true, message: 'x', close: true }) });
    closing.read('A');
    await settle();
    expect(closing.close).toHaveBeenCalledTimes(1);

    const failing = reader({
      onRead: () => {
        throw new Error('boom');
      },
    });
    failing.read('A');
    failing.tick(3000);
    failing.read('B');
    await settle();
    expect(failing.entries.map((e) => e.ok)).toEqual([false, false]);
  });
});
