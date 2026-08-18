import { z } from "zod";

/**
 * String-encoded decimal (e.g. "12.3400") used for money and bid values in
 * API payloads so floating point never touches monetary data.
 */
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "Expected a string-encoded decimal");
export type DecimalString = z.infer<typeof decimalStringSchema>;

/** Non-negative variant for prices, spend, and sales amounts. */
export const nonNegativeDecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Expected a non-negative string-encoded decimal");
export type NonNegativeDecimalString = z.infer<
  typeof nonNegativeDecimalStringSchema
>;

/** ISO calendar date (YYYY-MM-DD). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");
export type IsoDate = z.infer<typeof isoDateSchema>;

/** ISO 8601 timestamp with timezone. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** ISO 4217 currency code, e.g. "USD". */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Expected a 3-letter currency code");
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * Metric lookback: a trailing N-day window (1–90) or calendar month-to-date
 * (`"mtd"`, 1st of the current UTC month through today). Query strings are
 * coerced (`"30"` → 30); `"mtd"` is tried first so it is not turned into NaN.
 */
export const metricWindowSchema = z.union([
  z.literal("mtd"),
  z.coerce.number().int().min(1).max(90),
]);
export type MetricWindow = z.infer<typeof metricWindowSchema>;
