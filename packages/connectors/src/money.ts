/** Money and quantity normalization: integer minor units + ISO currency; quantities decimal strings + unit. */

const MINOR_DIGITS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/** Parse a decimal money amount string ("119.00") into integer minor units without floating point. */
export function toMinor(amount: string | number, currency: string): number {
  const digits = minorDigits(currency);
  const text = typeof amount === 'number' ? amount.toFixed(digits) : String(amount).trim();
  const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new RangeError(`invalid money amount: ${text}`);
  const sign = m[1] ? -1 : 1;
  const whole = m[2];
  let frac = (m[3] ?? '').padEnd(digits, '0');
  if (frac.length > digits) {
    if (/[1-9]/.test(frac.slice(digits))) throw new RangeError(`amount ${text} has more precision than ${currency} minor units`);
    frac = frac.slice(0, digits);
  }
  const value = Number(whole) * 10 ** digits + Number(frac || '0');
  if (!Number.isSafeInteger(value)) throw new RangeError(`amount ${text} exceeds safe integer range`);
  return sign * value;
}

export interface MoneyV2Like { amount: string; currencyCode: string }

export function moneyFrom(m: MoneyV2Like | null | undefined): { minor: number; currency: string } | null {
  if (!m || typeof m.amount !== 'string' || typeof m.currencyCode !== 'string') return null;
  return { minor: toMinor(m.amount, m.currencyCode), currency: m.currencyCode };
}

/** Quantities: decimal string with unit. */
export function quantity(value: number | string, unit = 'piece'): { quantity: string; unit: string } {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new RangeError(`invalid quantity: ${value}`);
  return { quantity: Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''), unit };
}
