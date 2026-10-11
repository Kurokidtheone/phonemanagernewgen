import { describe, expect, it } from 'vitest';
import { isValidImei, makeImei } from './imei';

describe('IMEI', () => {
  it('accepts known valid numbers', () => {
    expect(isValidImei('490154203237518')).toBe(true); // the classic Luhn example
    expect(isValidImei('356938035643809')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('356938035643808')).toBe(false);
  });

  it('rejects anything that is not exactly 15 digits', () => {
    expect(isValidImei('')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false);
    expect(isValidImei('4901542032375180')).toBe(false);
    expect(isValidImei('49015420323751a')).toBe(false);
    expect(isValidImei('490154 203237518')).toBe(false);
    expect(isValidImei('٤٩٠١٥٤٢٠٣٢٣٧٥١٨')).toBe(false); // Arabic-Indic digits
  });

  it('builds valid numbers from 14 digits', () => {
    expect(makeImei('49015420323751')).toBe('490154203237518');
    for (let i = 0; i < 200; i++) expect(isValidImei(makeImei(String(35000000000000 + i * 7919)))).toBe(true);
    expect(() => makeImei('123')).toThrow();
  });
});
