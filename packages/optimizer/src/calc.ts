import type { CurrencyCode, IsoDate } from "@amazon-king/contracts";
import { addDays, parseIsoDate } from "./dates.js";
import { roundMicrosToDp } from "./money.js";

/**
 * Core deterministic calculations (docs/plan.md §9). Money enters and
 * leaves these functions as integer micro-units; ratios (ACoS, ROAS, CVR,
 * multipliers) are plain numbers. Division-by-zero in a ratio returns
 * `null` — never Infinity/NaN. Genuinely invalid inputs (negative counts,
 * out-of-range priors) throw, because they indicate a caller bug.
 */

/** ACoS = advertising cost / attributed sales revenue. Null when no sales. */
export function acos(costMicros: number, salesMicros: number): number | null {
  assertNonNegative(costMicros, "costMicros");
  assertNonNegative(salesMicros, "salesMicros");
  if (salesMicros === 0) return null;
  return costMicros / salesMicros;
}

/** ROAS = attributed sales revenue / advertising cost. Null when no spend. */
export function roas(salesMicros: number, costMicros: number): number | null {
  assertNonNegative(salesMicros, "salesMicros");
  assertNonNegative(costMicros, "costMicros");
  if (costMicros === 0) return null;
  return salesMicros / costMicros;
}

/** Conversion rate = attributed orders / clicks. Null when no clicks. */
export function conversionRate(orders: number, clicks: number): number | null {
  assertNonNegative(orders, "orders");
  assertNonNegative(clicks, "clicks");
  if (clicks === 0) return null;
  return orders / clicks;
}

/**
 * Estimated ad profit = (copies x royalty per sale) - ad cost, in micros.
 * Exact integer arithmetic; may be negative. Pass `royaltyCopies(...)` rather
 * than raw orders: KDP pays per copy, so a multi-copy order earns a royalty
 * per copy.
 */
export function estimatedAdProfit(
  copies: number,
  royaltyPerSaleMicros: number,
  costMicros: number,
): number {
  assertNonNegative(copies, "copies");
  assertNonNegative(royaltyPerSaleMicros, "royaltyPerSaleMicros");
  assertNonNegative(costMicros, "costMicros");
  return copies * royaltyPerSaleMicros - costMicros;
}

/**
 * Copies a royalty is earned on over a window. Amazon reports orders and units
 * separately and never fewer units than orders, so an order of three copies
 * shows one order and three units. Units are absent (0 while orders are
 * positive) on facts imported before the units columns existed, in which case
 * this degrades to orders rather than erasing the royalty entirely.
 */
export function royaltyCopies(orders: number, units = 0): number {
  assertNonNegative(orders, "orders");
  assertNonNegative(units, "units");
  return Math.max(orders, units);
}

/**
 * Estimated break-even CPC = conversion rate x royalty per sale, rounded
 * half-up to 4 dp. This is the profit ceiling for a bid.
 */
export function breakEvenCpc(
  cvr: number,
  royaltyPerSaleMicros: number,
): number {
  assertRate(cvr, "cvr");
  assertNonNegative(royaltyPerSaleMicros, "royaltyPerSaleMicros");
  return roundMicrosToDp(cvr * royaltyPerSaleMicros);
}

/**
 * Beta-style smoothed conversion rate (docs/plan.md §9: "use a smoothed
 * conversion rate rather than orders / clicks when volume is low"):
 *
 *   (orders + priorRate * priorWeight) / (clicks + priorWeight)
 *
 * At zero clicks it returns the prior rate; with growing volume it
 * converges to the observed rate. Defaults: priorRate 0.05, priorWeight 20.
 */
export function smoothedConversionRate(
  clicks: number,
  orders: number,
  priorRate = 0.05,
  priorWeight = 20,
): number {
  assertNonNegative(clicks, "clicks");
  assertNonNegative(orders, "orders");
  assertRate(priorRate, "priorRate");
  assertNonNegative(priorWeight, "priorWeight");
  return (orders + priorRate * priorWeight) / (clicks + priorWeight);
}

/** Clamp a raw bid multiplier into the per-cooldown guard band. */
export function clampBidMultiplier(
  raw: number,
  min = 0.85,
  max = 1.15,
): number {
  if (!Number.isFinite(raw)) {
    throw new TypeError(`raw multiplier must be finite, got ${raw}`);
  }
  if (min > max) {
    throw new RangeError(`clamp min ${min} exceeds max ${max}`);
  }
  return Math.min(max, Math.max(min, raw));
}

export interface ProposedBidInput {
  currentBidMicros: number;
  targetAcos: number | null;
  observedAcos: number | null;
  smoothedCvr: number;
  /** Null when KDP economics are missing — the proposal is then rejected. */
  royaltyPerSaleMicros: number | null;
  safetyFactor?: number;
  maxBidMicros?: number | null;
  clampMin?: number;
  clampMax?: number;
  /** Reject when the relative change is below this (default 1%). */
  minRelativeChange?: number;
}

export interface ProposedBidResult {
  /** Proposed bid in integer micros, rounded half-up to 4 dp. */
  bidMicros: number;
  rawMultiplier: number;
  clampedMultiplier: number;
  /** Profit ceiling CPC in micros (smoothedCvr x royalty x safetyFactor). */
  ceilingMicros: number;
}

/**
 * The plan §9 example bid calculation:
 *
 *   raw multiplier     = target ACoS / observed ACoS
 *   guarded multiplier = clamp(raw, 0.85, 1.15)
 *   profit ceiling CPC = smoothed CVR x royalty per sale x safety factor
 *   proposed bid       = min(current x guarded, ceiling, configured max bid)
 *
 * Returns null (reject) when required economics are absent, inputs are
 * invalid, or the bid difference is too small to matter.
 */
export function proposedBid(input: ProposedBidInput): ProposedBidResult | null {
  const {
    currentBidMicros,
    targetAcos,
    observedAcos,
    smoothedCvr,
    royaltyPerSaleMicros,
    safetyFactor = 1,
    maxBidMicros = null,
    clampMin = 0.85,
    clampMax = 1.15,
    minRelativeChange = 0.01,
  } = input;

  if (
    royaltyPerSaleMicros === null ||
    targetAcos === null ||
    observedAcos === null ||
    !Number.isFinite(currentBidMicros) ||
    currentBidMicros <= 0 ||
    !Number.isFinite(targetAcos) ||
    targetAcos <= 0 ||
    !Number.isFinite(observedAcos) ||
    observedAcos <= 0 ||
    !Number.isFinite(smoothedCvr) ||
    smoothedCvr < 0 ||
    smoothedCvr > 1 ||
    !Number.isFinite(safetyFactor) ||
    safetyFactor <= 0 ||
    royaltyPerSaleMicros < 0 ||
    (maxBidMicros !== null && maxBidMicros <= 0)
  ) {
    return null;
  }

  const rawMultiplier = targetAcos / observedAcos;
  const clampedMultiplier = clampBidMultiplier(
    rawMultiplier,
    clampMin,
    clampMax,
  );
  const ceilingMicros = roundMicrosToDp(
    smoothedCvr * royaltyPerSaleMicros * safetyFactor,
  );
  const candidates = [currentBidMicros * clampedMultiplier, ceilingMicros];
  if (maxBidMicros !== null) candidates.push(maxBidMicros);
  const bidMicros = roundMicrosToDp(Math.min(...candidates));

  if (bidMicros <= 0) return null;
  if (bidMicros === currentBidMicros) return null;
  const relativeChange =
    Math.abs(bidMicros - currentBidMicros) / currentBidMicros;
  if (relativeChange < minRelativeChange) return null;

  return { bidMicros, rawMultiplier, clampedMultiplier, ceilingMicros };
}

/** One daily fact row for a single entity, money in micros. */
export interface DailyMetricRow {
  date: IsoDate;
  currency: CurrencyCode;
  impressions: number;
  clicks: number;
  orders: number;
  /** Copies sold; 0 on facts imported before the units columns existed. */
  units?: number;
  costMicros: number;
  salesMicros: number;
}

export interface WindowTotals {
  startDate: IsoDate;
  endDate: IsoDate;
  rowCount: number;
  impressions: number;
  clicks: number;
  orders: number;
  units: number;
  costMicros: number;
  salesMicros: number;
}

export class MixedCurrencyError extends Error {
  constructor(expected: string, found: string) {
    super(
      `Refusing to aggregate across currencies: expected ${expected}, found ${found}`,
    );
    this.name = "MixedCurrencyError";
  }
}

/**
 * Sum daily rows over the `days`-day window ending at `endDate` (inclusive).
 * Typical windows are 7/14/30/60 days (docs/plan.md §9). Every supplied row
 * must be in `currency`; a mismatch throws `MixedCurrencyError` — monetary
 * values are never aggregated across currencies without explicit conversion.
 */
export function aggregateWindow(
  rows: readonly DailyMetricRow[],
  days: number,
  endDate: IsoDate,
  currency: CurrencyCode,
): WindowTotals {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
  for (const row of rows) {
    if (row.currency !== currency) {
      throw new MixedCurrencyError(currency, row.currency);
    }
  }
  const startDate = addDays(endDate, -(days - 1));
  const startMs = parseIsoDate(startDate);
  const endMs = parseIsoDate(endDate);
  const totals: WindowTotals = {
    startDate,
    endDate,
    rowCount: 0,
    impressions: 0,
    clicks: 0,
    orders: 0,
    units: 0,
    costMicros: 0,
    salesMicros: 0,
  };
  for (const row of rows) {
    const ms = parseIsoDate(row.date);
    if (ms < startMs || ms > endMs) continue;
    totals.rowCount += 1;
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.orders += row.orders;
    totals.units += row.units ?? 0;
    totals.costMicros += row.costMicros;
    totals.salesMicros += row.salesMicros;
  }
  return totals;
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative finite number, got ${value}`,
    );
  }
}

function assertRate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be in [0, 1], got ${value}`);
  }
}
