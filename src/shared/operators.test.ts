import { describe, expect, it } from 'vitest';
import { operatorOf } from './operators';

describe('operatorOf', () => {
  it('05 is Ooredoo, 06 Mobilis, 07 Djezzy', () => {
    expect(operatorOf('0550123456')).toBe('ooredoo');
    expect(operatorOf('0661 22 33 44')).toBe('mobilis');
    expect(operatorOf('07-70-55-66-77')).toBe('djezzy');
  });
  it('recognises the number after only two digits, and understands the international form', () => {
    expect(operatorOf('06')).toBe('mobilis');
    expect(operatorOf('+213 770 55 66 77')).toBe('djezzy');
    expect(operatorOf('00213 550 12 34 56')).toBe('ooredoo');
  });
  it('says nothing for other numbers', () => {
    expect(operatorOf('')).toBeNull();
    expect(operatorOf('0')).toBeNull();
    expect(operatorOf('021 23 45 67')).toBeNull(); // a landline
    expect(operatorOf('0850123456')).toBeNull();
    expect(operatorOf('abc')).toBeNull();
  });
});
