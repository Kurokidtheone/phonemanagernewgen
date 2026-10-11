import { describe, expect, it } from 'vitest';
import { internalBarcode, isValidEan13 } from './barcode';

describe('EAN-13', () => {
  it('validates the check digit', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan13('400638133393')).toBe(false);
  });

  it('builds internal codes starting with 200', () => {
    expect(internalBarcode(1)).toMatch(/^200000000001\d$/);
    for (const n of [1, 2, 99, 123456]) expect(isValidEan13(internalBarcode(n))).toBe(true);
  });
});
