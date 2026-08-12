/**
 * Money representation decision
 * -----------------------------
 * This package never uses raw floating point for monetary values. All money
 * is represented internally as integer **micro-units**: 1 currency unit =
 * 1,000,000 micros, stored in a plain `number`. Integer micro arithmetic
 * (add/subtract/compare) is exact for any realistic ad-spend magnitude
 * (safe up to ~9e9 currency units, far beyond a single-owner KDP account).
 *
 * Multiplication by a ratio (e.g. bid x multiplier, cvr x royalty) is the
 * only place a float appears, and its result is immediately rounded with
 * `roundHalfAwayFromZero` to whole micros. Public outputs that cross the
 * package boundary are string-encoded decimals via `microsToDecimalString`,
 * rounded half-up (away from zero) to 4 decimal places — the same precision
 * the contracts package accepts in `decimalStringSchema` and the precision
 * Amazon uses for bids.
 *
 * Ratios that are not money (ACoS, ROAS, CTR, conversion rate, multipliers)
 * are ordinary `number`s; they are never emitted as monetary outputs.
 */

export const MICROS_PER_UNIT = 1_000_000;

/** Decimal places used when emitting monetary strings (bids, budgets). */
export const MONEY_DECIMAL_PLACES = 4;

const DECIMAL_STRING_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Parse a string-encoded decimal (up to 6 fractional digits) into integer
 * micro-units. Throws on anything that is not an exact decimal string —
 * inputs are never silently rounded.
 */
export function microsFromDecimalString(value: string): number {
  const match = DECIMAL_STRING_RE.exec(value);
  if (!match) {
    throw new TypeError(`Invalid decimal string: ${JSON.stringify(value)}`);
  }
  const [, sign, intPart, fracPart = ""] = match;
  const micros =
    Number(intPart) * MICROS_PER_UNIT + Number(fracPart.padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError(`Decimal string out of safe range: ${value}`);
  }
  return sign === "-" ? -micros : micros;
}

/** Round to the nearest integer, halves away from zero. */
export function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Round a micro amount (possibly fractional after a ratio multiplication)
 * to the given number of decimal places of the currency unit, halves away
 * from zero. Returns integer micros. Default is 4 dp (bid precision).
 */
export function roundMicrosToDp(
  micros: number,
  dp: number = MONEY_DECIMAL_PLACES,
): number {
  if (!Number.isInteger(dp) || dp < 0 || dp > 6) {
    throw new RangeError(`dp must be an integer in [0, 6], got ${dp}`);
  }
  const factor = 10 ** (6 - dp);
  return roundHalfAwayFromZero(micros / factor) * factor;
}

/**
 * Format integer micros as a string-encoded decimal with exactly `dp`
 * fractional digits (default 4), rounding halves away from zero first.
 * The output always matches the contracts `decimalStringSchema` shape.
 */
export function microsToDecimalString(
  micros: number,
  dp: number = MONEY_DECIMAL_PLACES,
): string {
  const rounded = roundMicrosToDp(micros, dp);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const units = Math.floor(abs / MICROS_PER_UNIT);
  const factor = 10 ** (6 - dp);
  const frac = (abs % MICROS_PER_UNIT) / factor;
  const sign = negative ? "-" : "";
  if (dp === 0) {
    return `${sign}${units}`;
  }
  return `${sign}${units}.${String(frac).padStart(dp, "0")}`;
}

/** Deterministic human-readable money label for rationales, e.g. "USD 12.34". */
export function formatMoney(micros: number, currency: string): string {
  return `${currency} ${microsToDecimalString(micros, 2)}`;
}
