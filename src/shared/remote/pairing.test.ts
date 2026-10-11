import { describe, expect, it } from 'vitest';
import { formatPairCode, newPairCode, pairingChannel, parsePairCode } from './pairing';
import { isMailbox } from './wire';

describe('remote pairing code', () => {
  it('has 16 characters and is typed back in any shape', () => {
    const code = newPairCode();
    expect(code).toMatch(/^[A-Z2-7]{16}$/);
    expect(parsePairCode(formatPairCode(code).toLowerCase())).toBe(code);
    expect(parsePairCode(` ${formatPairCode(code)} `)).toBe(code);
    expect(parsePairCode('SHORT')).toBeNull();
    expect(parsePairCode('0000-0000-0000-0000')).toBeNull(); // 0 is not in the alphabet
  });
  it('gives both sides the same private mailbox and key, and different codes different ones', async () => {
    const code = newPairCode();
    const a = await pairingChannel(code);
    expect(await pairingChannel(code)).toEqual(a);
    expect(isMailbox(a.mailbox)).toBe(true);
    expect(a.key).not.toBe(a.mailbox);
    expect((await pairingChannel(newPairCode())).mailbox).not.toBe(a.mailbox);
  });
});
