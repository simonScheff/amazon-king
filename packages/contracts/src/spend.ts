import { z } from "zod";
import {
  currencyCodeSchema,
  isoDateSchema,
  metricWindowSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";
import { dashboardCountrySchema } from "./metrics.js";

/**
 * Spend explorer contracts (the /spend dashboard page): where ad spend goes,
 * broken down by market, campaign, or search term. Read-only analytics over
 * the daily fact tables; the all-market view (`country=all`) converts every
 * fact at its own metric date into one display currency, the same convention
 * as the overview summary.
 */

/** Breakdown dimension of the spend explorer. */
export const spendGrainSchema = z.enum(["market", "campaign", "searchTerm"]);
export type SpendGrain = z.infer<typeof spendGrainSchema>;

/** GET /api/spend/breakdown query. Same country/currency conventions as the dashboard summary. */
export const spendBreakdownQuerySchema = z.object({
  grain: spendGrainSchema.default("campaign"),
  days: metricWindowSchema.default(30),
  country: dashboardCountrySchema.default("US"),
  currency: currencyCodeSchema.optional(),
});
export type SpendBreakdownQuery = z.infer<typeof spendBreakdownQuerySchema>;

/** GET /api/spend/tree query. */
export const spendTreeQuerySchema = z.object({
  days: metricWindowSchema.default(30),
  country: dashboardCountrySchema.default("US"),
  currency: currencyCodeSchema.optional(),
});
export type SpendTreeQuery = z.infer<typeof spendTreeQuerySchema>;

const dateRangeSchema = z.object({
  start: isoDateSchema,
  end: isoDateSchema,
});

/** One day of an entity's spend series (zero-filled over the window). */
export const spendDailyPointSchema = z.object({
  date: isoDateSchema,
  spend: nonNegativeDecimalStringSchema,
});
export type SpendDailyPoint = z.infer<typeof spendDailyPointSchema>;

/** One top-spend entity of the breakdown (a market, campaign, or search term). */
export const spendBreakdownEntitySchema = z.object({
  /** Country code, Amazon campaign id, or the search term itself. */
  id: z.string(),
  name: z.string(),
  spend: nonNegativeDecimalStringSchema,
  sales: nonNegativeDecimalStringSchema,
  orders: z.number().int().nonnegative(),
  /** Spend / attributed sales; null when there are no sales (worst bucket). */
  acos: z.number().nullable(),
  /** Spend in the immediately preceding same-length window ("0" when absent). */
  previousSpend: nonNegativeDecimalStringSchema,
  /** Per-day spend over the window, zero-filled. */
  daily: z.array(spendDailyPointSchema),
});
export type SpendBreakdownEntity = z.infer<typeof spendBreakdownEntitySchema>;

/**
 * GET /api/spend/breakdown — the top 12 entities by window spend with their
 * per-day series, everything else aggregated into `other` (per day too, so
 * the composition chart sums correctly). `previousSpend` (per entity and in
 * totals) covers the comparison window, same semantics as the dashboard
 * summary's `previous`.
 */
export const spendBreakdownSchema = z.object({
  grain: spendGrainSchema,
  dateRange: dateRangeSchema,
  previousDateRange: dateRangeSchema,
  currency: currencyCodeSchema,
  /** Same meaning as the dashboard summary: false when no FX rates are stored. */
  ratesAvailable: z.boolean(),
  totals: z.object({
    spend: nonNegativeDecimalStringSchema,
    sales: nonNegativeDecimalStringSchema,
    previousSpend: nonNegativeDecimalStringSchema,
  }),
  entities: z.array(spendBreakdownEntitySchema),
  other: z.object({
    spend: nonNegativeDecimalStringSchema,
    daily: z.array(spendDailyPointSchema),
  }),
});
export type SpendBreakdown = z.infer<typeof spendBreakdownSchema>;

/** One spend-map node: a market, campaign, or search term with its totals. */
export const spendTreeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: spendGrainSchema,
  spend: nonNegativeDecimalStringSchema,
  sales: nonNegativeDecimalStringSchema,
  acos: z.number().nullable(),
});
export type SpendTreeNode = z.infer<typeof spendTreeNodeSchema>;

/**
 * GET /api/spend/tree — two-level spend hierarchy for the treemap. With
 * `country=all` the roots are markets and the children campaigns; with a
 * single country the roots are campaigns and the children search terms.
 * Children are capped at the top 10 per parent by spend, the rest folded
 * into an "Other" child.
 */
export const spendTreeSchema = z.object({
  dateRange: dateRangeSchema,
  currency: currencyCodeSchema,
  ratesAvailable: z.boolean(),
  roots: z.array(
    spendTreeNodeSchema.extend({
      children: z.array(spendTreeNodeSchema),
    }),
  ),
});
export type SpendTree = z.infer<typeof spendTreeSchema>;
