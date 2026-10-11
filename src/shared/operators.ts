// Algerian mobile operators by the first digits of the number: 05 Ooredoo, 06 Mobilis, 07 Djezzy.
export type Operator = 'ooredoo' | 'mobilis' | 'djezzy';

const BY_PREFIX: Record<string, Operator> = { '5': 'ooredoo', '6': 'mobilis', '7': 'djezzy' };

/** The operator of a number typed as 0550…, 0 6 61…, +213 7…, 00213 5…; null while it cannot be told. */
export function operatorOf(phone: string): Operator | null {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00213')) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith('213')) digits = `0${digits.slice(3)}`;
  return digits.length >= 2 && digits[0] === '0' ? (BY_PREFIX[digits[1]] ?? null) : null;
}
