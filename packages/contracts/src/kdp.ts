import { z } from "zod";
import { coverImageUrlSchema } from "./books.js";
import {
  bookIdListParamSchema,
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";
import { dashboardCountrySchema } from "./metrics.js";

/**
 * KDP "Royalties Estimator" workbook import. The browser parses the xlsx into
 * this canonical payload; the server derives royalty-per-copy suggestions from
 * actuals (docs/kdp-royalty-import-plan.md). KDP data carries no ad
 * attribution, so this never touches per-day or per-campaign figures.
 */

export const kdpRoyaltyRowFormatSchema = z.enum([
  "paperback",
  "hardcover",
  "ebook",
]);
export type KdpRoyaltyRowFormat = z.infer<typeof kdpRoyaltyRowFormatSchema>;

/** One transaction row from a royalty sheet. Amounts may be negative (refunds). */
export const kdpRoyaltyRowSchema = z.object({
  format: kdpRoyaltyRowFormatSchema,
  orderDate: isoDateSchema,
  royaltyDate: isoDateSchema,
  asin: z.string().trim().max(64),
  title: z.string().trim().min(1).max(500),
  marketplace: z.string().trim().min(1).max(64),
  royaltyType: z.string().trim().min(1).max(16),
  transactionType: z.string().trim().min(1).max(128),
  netUnits: z.number().int().min(-1000).max(1000),
  royalty: decimalStringSchema,
  currency: currencyCodeSchema,
});
export type KdpRoyaltyRow = z.infer<typeof kdpRoyaltyRowSchema>;

export const KDP_ROYALTY_IMPORT_MAX_ROWS = 20_000;

export const kdpRoyaltyImportInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rows: z.array(kdpRoyaltyRowSchema).min(1).max(KDP_ROYALTY_IMPORT_MAX_ROWS),
});
export type KdpRoyaltyImportInput = z.infer<typeof kdpRoyaltyImportInputSchema>;

/** Why a report row group produced no suggestion. */
export const kdpRoyaltySkipReasonSchema = z.enum([
  "unknown_marketplace",
  "no_ads_profile",
  "asin_not_linked",
  "currency_mismatch",
  "no_standard_rows",
]);
export type KdpRoyaltySkipReason = z.infer<typeof kdpRoyaltySkipReasonSchema>;

export const kdpRoyaltySkippedRowSchema = z.object({
  asin: z.string(),
  title: z.string(),
  marketplace: z.string(),
  reason: kdpRoyaltySkipReasonSchema,
  units: z.number().int(),
});
export type KdpRoyaltySkippedRow = z.infer<typeof kdpRoyaltySkippedRowSchema>;

/**
 * Derived royalty-per-copy for one book × profile. Computed over standard-rate
 * rows only — expanded-distribution sales cannot come from ads. `lowEvidence`
 * (<5 standard units) and `deviationWarning` (>15% from current) are advisory
 * flags for the review UI.
 */
export const kdpRoyaltySuggestionSchema = z.object({
  bookId: z.string(),
  profileId: z.string(),
  title: z.string(),
  countryCode: z.string().length(2),
  currency: currencyCodeSchema,
  currentRoyaltyPerSale: nonNegativeDecimalStringSchema.nullable(),
  suggestedRoyaltyPerSale: nonNegativeDecimalStringSchema,
  standardUnits: z.number().int().nonnegative(),
  expandedUnits: z.number().int().nonnegative(),
  lowEvidence: z.boolean(),
  deviationWarning: z.boolean(),
});
export type KdpRoyaltySuggestion = z.infer<typeof kdpRoyaltySuggestionSchema>;

export const kdpRoyaltyImportSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rowCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
  /** True when the same file content was uploaded before (idempotent replay). */
  alreadyExisted: z.boolean(),
  suggestions: z.array(kdpRoyaltySuggestionSchema),
  skipped: z.array(kdpRoyaltySkippedRowSchema),
});
export type KdpRoyaltyImport = z.infer<typeof kdpRoyaltyImportSchema>;

export const kdpRoyaltyImportSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rowCount: z.number().int().nonnegative(),
  suggestionCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
});
export type KdpRoyaltyImportSummary = z.infer<
  typeof kdpRoyaltyImportSummarySchema
>;

export const kdpRoyaltyApplyInputSchema = z.object({
  selections: z
    .array(
      z.object({
        bookId: z.string().min(1),
        profileId: z.string().min(1),
      }),
    )
    .min(1)
    .max(500),
  /** Defaults to the apply date. */
  effectiveFrom: isoDateSchema.optional(),
});
export type KdpRoyaltyApplyInput = z.infer<typeof kdpRoyaltyApplyInputSchema>;

export const kdpRoyaltyApplySkipSchema = z.object({
  bookId: z.string(),
  profileId: z.string(),
  reason: z.enum(["unknown_selection", "no_existing_economics"]),
});
export type KdpRoyaltyApplySkip = z.infer<typeof kdpRoyaltyApplySkipSchema>;

export const kdpRoyaltyApplyResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.array(kdpRoyaltyApplySkipSchema),
});
export type KdpRoyaltyApplyResult = z.infer<typeof kdpRoyaltyApplyResultSchema>;

/**
 * GET /api/kdp/history — phase-2 sales history for the /kdp-history page
 * (docs/kdp-royalty-import-plan.md §6): per book × marketplace monthly series
 * for the sales-mix and royalty-trend charts, plus fulfillment-time stats.
 * KDP units are derived at read time from the stored transactions, grouped
 * by KDP report month (royalty_date, matching the KDP dashboard's own
 * display); ad units are computed from the fact tables at query time
 * (decision 11); royaltyPerSale is the effective-dated book_economics value
 * in effect for that month (decision 10 — read from history, never
 * duplicated). Each series is single-currency by construction.
 */

/** One month of a book × marketplace history series. */
export const kdpHistoryMonthSchema = z.object({
  /** First of the KDP report month — the month of royalty_date (ISO date). */
  month: isoDateSchema,
  /** KDP standard-rate net units (can go negative on refund-heavy months). */
  kdpStandardUnits: z.number().int(),
  /** KDP expanded-distribution net units. */
  kdpExpandedUnits: z.number().int(),
  /** Ad-attributed copies on the 14-day click-attribution window. */
  adUnits: z.number().int().nonnegative(),
  /**
   * estimated_royalty_per_sale in effect at the end of the month; null when
   * no economics row covered it.
   */
  royaltyPerSale: nonNegativeDecimalStringSchema.nullable(),
});
export type KdpHistoryMonth = z.infer<typeof kdpHistoryMonthSchema>;

export const kdpHistorySeriesSchema = z.object({
  bookId: z.string(),
  title: z.string(),
  /** Amazon Ads profile id. */
  profileId: z.string(),
  countryCode: z.string().length(2),
  currency: currencyCodeSchema,
  coverImageUrl: coverImageUrlSchema.nullable(),
  months: z.array(kdpHistoryMonthSchema),
});
export type KdpHistorySeries = z.infer<typeof kdpHistorySeriesSchema>;

/** One month of fulfillment time (order → ship) for one marketplace. */
export const kdpFulfillmentMonthSchema = z.object({
  month: isoDateSchema,
  /** Median royalty_date − order_date in days (percentile_cont; fractional). */
  medianDays: z.number().nonnegative(),
  averageDays: z.number().nonnegative(),
  /** Standard-rate net units the stats are computed over. */
  standardUnits: z.number().int(),
});
export type KdpFulfillmentMonth = z.infer<typeof kdpFulfillmentMonthSchema>;

export const kdpFulfillmentSeriesSchema = z.object({
  /** Amazon Ads profile id. */
  profileId: z.string(),
  countryCode: z.string().length(2),
  months: z.array(kdpFulfillmentMonthSchema),
});
export type KdpFulfillmentSeries = z.infer<typeof kdpFulfillmentSeriesSchema>;

export const kdpHistorySchema = z.object({
  series: z.array(kdpHistorySeriesSchema),
  fulfillment: z.array(kdpFulfillmentSeriesSchema),
});
export type KdpHistory = z.infer<typeof kdpHistorySchema>;

/** GET /api/kdp/transactions query params (per-sale browser). */
export const kdpTransactionsQuerySchema = z.object({
  bookId: z.string().min(1).optional(),
  /** Amazon Ads profile id. */
  profileId: z.string().min(1).optional(),
  /** First-of-month ISO date; matches the KDP report month (royalty_date). */
  month: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});
export type KdpTransactionsQuery = z.infer<typeof kdpTransactionsQuerySchema>;

/** One stored KDP sale transaction, newest order date first. */
export const kdpSaleTransactionSchema = z.object({
  id: z.string(),
  /** Null when the row's ASIN is not linked to a catalog book/profile. */
  bookId: z.string().nullable(),
  /** Catalog book title when linked; null for unlinked rows. */
  title: z.string().nullable(),
  /** Amazon Ads profile id when linked; null for unlinked rows. */
  profileId: z.string().nullable(),
  asin: z.string(),
  marketplace: z.string(),
  format: kdpRoyaltyRowFormatSchema,
  royaltyType: z.string(),
  transactionType: z.string(),
  orderDate: isoDateSchema,
  royaltyDate: isoDateSchema,
  netUnits: z.number().int(),
  /** Signed (refunds are negative), native currency. */
  royalty: decimalStringSchema,
  currency: currencyCodeSchema,
});
export type KdpSaleTransaction = z.infer<typeof kdpSaleTransactionSchema>;

/** GET /api/kdp/transactions response: one page plus the filtered total. */
export const kdpTransactionsPageSchema = z.object({
  transactions: z.array(kdpSaleTransactionSchema),
  /** Total rows matching the filters, across all pages. */
  total: z.number().int().nonnegative(),
});
export type KdpTransactionsPage = z.infer<typeof kdpTransactionsPageSchema>;

/**
 * GET /api/kdp/daily-profit — daily profitability over a day range for the
 * /kdp-history organic tab (one calendar month) and the overview card (the
 * page's shared timeframe window): real KDP royalty per royalty posting date
 * (organic included — the day KDP posted the royalty, matching the KDP
 * dashboard's own display and the royalty-month import periods) next to the
 * estimated ad-attributed royalty and the ad spend, all
 * markets converted per day into the workspace display currency through the
 * USD-pivot fx_rates table (same convention as country=all on the dashboard
 * summary). The ad/organic split avoids double counting by valuing
 * organic = max(0, totalRoyalty − adRoyalty) — ad attribution and KDP royalty
 * posting dates never align perfectly, the same clamp the sales-mix chart
 * uses.
 * `profit = totalRoyalty − adSpend` is real money and needs no book
 * economics; only the ad/organic split does. The `books` product filter
 * limits both the ad side and the KDP side; `country` limits both to one
 * market, answered in that market's native currency with no FX conversion
 * ("all", the default, is the converted view above).
 */

/** Longest range the endpoint answers; bounds the per-day series. */
export const KDP_DAILY_PROFIT_MAX_RANGE_DAYS = 93;

const DAY_MS = 86_400_000;

/** GET /api/kdp/daily-profit query params: a month XOR a start/end range. */
export const kdpDailyProfitQuerySchema = z
  .object({
    /** First-of-month ISO date; the month to observe. */
    month: isoDateSchema.optional(),
    /** Explicit day range (alternative to `month`), both ends inclusive. */
    start: isoDateSchema.optional(),
    end: isoDateSchema.optional(),
    /**
     * Global product filter: comma-separated catalog book ids; absent sums
     * every book (and unlinked-ASIN sales).
     */
    books: bookIdListParamSchema,
    /**
     * Two-letter market; absent (or "all") converts every market into the
     * workspace display currency, while a specific market keeps the day's
     * figures in that market's native currency — like the dashboard
     * summary — with no FX conversion.
     */
    country: dashboardCountrySchema.optional(),
  })
  .superRefine((query, ctx) => {
    const hasMonth = query.month !== undefined;
    const hasRange = query.start !== undefined || query.end !== undefined;
    if (hasMonth === hasRange) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either month or both start and end",
      });
      return;
    }
    if (hasMonth) return;
    if (query.start === undefined || query.end === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "start and end must be provided together",
      });
      return;
    }
    if (query.start > query.end) {
      ctx.addIssue({ code: "custom", message: "start must not be after end" });
      return;
    }
    const spanDays =
      (Date.parse(`${query.end}T00:00:00.000Z`) -
        Date.parse(`${query.start}T00:00:00.000Z`)) /
      DAY_MS;
    if (spanDays + 1 > KDP_DAILY_PROFIT_MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `Range must not exceed ${KDP_DAILY_PROFIT_MAX_RANGE_DAYS} days`,
      });
    }
  });
export type KdpDailyProfitQuery = z.infer<typeof kdpDailyProfitQuerySchema>;

/** One day of the monthly profitability series. */
export const kdpDailyProfitDaySchema = z.object({
  date: isoDateSchema,
  /** Converted ad spend; "0" on ad-free days. */
  adSpend: nonNegativeDecimalStringSchema,
  /**
   * Estimated ad-attributed royalty (facts × book economics); null when
   * economics were missing for that day.
   */
  adRoyalty: nonNegativeDecimalStringSchema.nullable(),
  /**
   * max(0, totalRoyalty − adRoyalty); null when the split is unavailable
   * (economics missing) or the range was never imported.
   */
  organicRoyalty: nonNegativeDecimalStringSchema.nullable(),
  /**
   * Real summed KDP royalty for the royalty posting date (signed — refunds
   * go negative); null when the range was never imported.
   */
  totalRoyalty: decimalStringSchema.nullable(),
  /** totalRoyalty − adSpend; null when the range was never imported. */
  profit: decimalStringSchema.nullable(),
});
export type KdpDailyProfitDay = z.infer<typeof kdpDailyProfitDaySchema>;

export const kdpDailyProfitSchema = z.object({
  /** Observed day range (echo of the resolved query, both ends inclusive). */
  start: isoDateSchema,
  end: isoDateSchema,
  /** Display currency every figure is converted into. */
  currency: currencyCodeSchema,
  /** False when fx_rates is empty — daily is then empty, never unconverted. */
  ratesAvailable: z.boolean(),
  /** True when any day lacked the economics needed for the ad/organic split. */
  economicsMissing: z.boolean(),
  /** False when the range has no KDP transactions (never imported). */
  kdpImported: z.boolean(),
  /** Every day of the range, ascending (capped at today). */
  daily: z.array(kdpDailyProfitDaySchema),
});
export type KdpDailyProfit = z.infer<typeof kdpDailyProfitSchema>;
