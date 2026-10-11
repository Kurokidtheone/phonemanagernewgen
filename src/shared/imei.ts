// IMEI: exactly 15 digits, the last one a Luhn check digit.

/** Luhn check digit for a string of digits (the 14 digits that precede the check digit of an IMEI). */
export function luhnCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // Walking from the right, the first digit of the body is doubled (it sits left of the check digit).
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidImei(value: string): boolean {
  return /^\d{15}$/.test(value) && luhnCheckDigit(value.slice(0, 14)) === Number(value[14]);
}

/** Completes 14 digits into a valid 15-digit IMEI. Used by seed data and tests. */
export function makeImei(body14: string): string {
  if (!/^\d{14}$/.test(body14)) throw new Error('An IMEI body is exactly 14 digits');
  return body14 + luhnCheckDigit(body14);
}
