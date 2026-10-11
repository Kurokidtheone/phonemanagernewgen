import { describe, expect, it } from 'vitest';
import { formatMoney, splitPercent, toCentimes } from './money';

describe('money', () => {
  it('parses what people type', () => {
    expect(toCentimes('2400')).toBe(240000);
    expect(toCentimes('2 400,50')).toBe(240050);
    expect(toCentimes('2.400')).toBe(240000);
    expect(toCentimes('2.400,5')).toBe(240050);
    expect(toCentimes('12.5')).toBe(1250);
    expect(toCentimes(19.99)).toBe(1999);
    expect(toCentimes('abc')).toBeNull();
    expect(toCentimes('')).toBeNull();
  });
  it('formats with dot thousands', () => {
    expect(formatMoney(240000, 'ar')).toBe('2.400 دج');
    expect(formatMoney(240000, 'fr', { decimals: true })).toBe('2.400,00 DA');
    expect(formatMoney(-7532000, 'en')).toBe('-75.320 DA');
    expect(formatMoney(50, 'fr')).toBe('0,50 DA');
  });
  it('splits a percent without losing a centime', () => {
    expect(splitPercent(240000, 50)).toEqual([120000, 120000]);
    const [a, b] = splitPercent(100001, 33);
    expect(a + b).toBe(100001);
  });
});
