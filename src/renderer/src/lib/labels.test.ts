import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { internalBarcode } from '@shared/barcode';
import { makeImei } from '@shared/imei';

// The label printer draws these exact symbologies through JsBarcode. This checks that an IMEI and
// an internal barcode encode, without throwing, to the right number of modules. Whether a real
// scanner reads the printed paper is tested by hand (see the Phase 2 checklist).
const require = createRequire(import.meta.url);
const CODE128 = require('jsbarcode/bin/barcodes/CODE128/CODE128_AUTO.js').default;
const EAN13 = require('jsbarcode/bin/barcodes/EAN_UPC/EAN13.js').default;

describe('label barcodes', () => {
  it('encodes an IMEI as Code 128, carrying the digits as text', () => {
    const imei = makeImei('35000000000001');
    const encoded = new CODE128(imei, {}).encode();
    expect(encoded.text).toBe(imei);
    expect(encoded.data).toMatch(/^[01]+$/);
    expect(encoded.data).toHaveLength(134); // start, 7 digit pairs, 1 digit, check, stop
  });

  it('encodes an internal EAN-13 in 95 modules and rejects a wrong check digit', () => {
    const code = internalBarcode(42);
    expect(new EAN13(code, {}).valid()).toBe(true);
    const modules = (new EAN13(code, {}).encode() as { data: string }[]).map((part) => part.data).join('');
    expect(modules).toHaveLength(95);
    expect(new EAN13(code.slice(0, 12) + String((Number(code[12]) + 1) % 10), {}).valid()).toBe(false);
  });
});
