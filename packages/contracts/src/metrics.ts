import { z } from "zod";
import {
  bookIdListParamSchema,
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
  metricWindowSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";

/** Aggregated ad metrics. Money fields are string-encoded decimals. */
export const metricTotalsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  cost: nonNegativeDecimalStringSchema,
  sales: nonNegativeDecimalStringSchema,
  orders: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
});
export type MetricTotals = z.infer<typeof metricTotalsSchema>;

const dashboardTotalsSchema = metricTotalsSchema.extend({
  acos: z.number().nullable(),
  estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
  estimatedAdProfit: decimalStringSchema.nullable(),
});

/**
 * Overview market filter: a two-letter Amazon country code, or `"all"` for
 * the all-market view that converts every marketplace into a single display
 * currency (docs/fx-rates-all-market-plan.md, decision 6). Case-insensitive
 * on input; normalized to uppercase codes / lowercase `"all"`.
 */
export const dashboardCountrySchema = z
  .string()
  .trim()
  .regex(
    /^(?:[A-Za-z]{2}|all)$/i,
    "Expected a two-letter country code or 'all'",
  )
  .transform((value) =>
    value.toLowerCase() === "all" ? "all" : value.toUpperCase(),
  );
export type DashboardCountry = z.infer<typeof dashboardCountrySchema>;

/**
 * GET /api/dashboard/summary query. `currency` selects the display currency
 * of the all-market view and is validated as ISO 4217; it is ignored for a
 * specific country, whose totals stay in the native currency.
 */
export const dashboardSummaryQuerySchema = z.object({
  days: metricWindowSchema.default(30),
  books: bookIdListParamSchema,
  country: dashboardCountrySchema.default("US"),
  currency: currencyCodeSchema.optional(),
});
export type DashboardSummaryQuery = z.infer<typeof dashboardSummaryQuerySchema>;

/**
 * GET /api/dashboard/country-spend query. When `currency` is present, each
 * per-market row also carries a converted total in that currency.
 */
export const countrySpendQuerySchema = z.object({
  days: metricWindowSchema.default(30),
  books: bookIdListParamSchema,
  currency: currencyCodeSchema.optional(),
});
export type CountrySpendQuery = z.infer<typeof countrySpendQuerySchema>;

export const dashboardSummarySchema = z.object({
  dateRange: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  currency: currencyCodeSchema,
  /**
   * True when the fx_rates table holds at least one fixing, i.e. the
   * all-market view (`country=all`) can convert. Returned for every country
   * selection so the client can enable or disable the "all markets" option.
   */
  ratesAvailable: z.boolean(),
  totals: dashboardTotalsSchema,
  /**
   * Totals for the comparison window, powering period-over-period on the
   * dashboard. Trailing N-day views use the immediately preceding window of
   * the same length (7d vs the 7d before). Month-to-date (`days=mtd`) uses
   * the same day-of-month range in the previous calendar month (1–18 Aug vs
   * 1–18 Jul), clamping the end day when that month is shorter.
   */
  previous: z.object({
    dateRange: z.object({
      start: isoDateSchema,
      end: isoDateSchema,
    }),
    totals: dashboardTotalsSchema,
  }),
  economicsMissing: z.boolean(),
  dataCurrentThrough: isoDateTimeSchema,
  /** True when writes are unavailable (kill switch or all profiles read-only). */
  writesDisabled: z.boolean().optional(),
  /** Per-day series for the dashboard trend chart. */
  daily: z
    .array(
      z.object({
        date: isoDateSchema,
        cost: nonNegativeDecimalStringSchema,
        sales: nonNegativeDecimalStringSchema,
        orders: z.number().int().nonnegative(),
        estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      }),
    )
    .optional(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/**
 * GET /api/dashboard/country-spend — ad spend per marketplace country over the
 * requested window, sorted by spend descending. Powers spend-ordered country
 * selectors. Countries without metrics in the window are omitted (treated as
 * zero by clients).
 */
export const countrySpendSchema = z.object({
  dateRange: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  /**
   * Display currency of the converted totals; present only when the request
   * asked for conversion (the `currency` query param).
   */
  currency: currencyCodeSchema.optional(),
  countries: z.array(
    z.object({
      countryCode: z.string(),
      currency: currencyCodeSchema,
      spend: nonNegativeDecimalStringSchema,
      /**
       * Spend converted into the response `currency`, per fact date. Null
       * when stored FX rates do not cover this market's window — never a
       * silently unconverted number. Absent when no conversion was requested.
       */
      convertedSpend: nonNegativeDecimalStringSchema.nullable().optional(),
    }),
  ),
});
export type CountrySpend = z.infer<typeof countrySpendSchema>;

export const campaignRowSchema = z.object({
  profileId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
  /**
   * Amazon Ads console (Campaign Manager) URL for the campaign's profile, so
   * the UI can link out to Amazon for a side-by-side data check. Scoped to
   * the profile, not the campaign: the console's per-campaign URLs use an id
   * namespace the API never exposes. Null when the profile has no entity id
   * on file (never re-synced with account info).
   */
  amazonConsoleUrl: z.string().nullable(),
});
export type CampaignRow = z.infer<typeof campaignRowSchema>;

/** Profitability for one campaign over the campaign-list date window. */
export const campaignProfitabilitySchema = z.object({
  dateRange: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  currency: currencyCodeSchema,
  estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
  estimatedAdProfit: decimalStringSchema.nullable(),
  economicsMissing: z.boolean(),
  dataCurrentThrough: isoDateSchema.nullable(),
});
export type CampaignProfitability = z.infer<typeof campaignProfitabilitySchema>;

/** GET /api/campaigns row, including profitability for the requested window. */
export const campaignListRowSchema = campaignRowSchema.extend({
  profitability: campaignProfitabilitySchema,
  /**
   * Distinct catalog book ids advertised by this campaign (via enabled
   * book_profile_links). Empty when no ads are mapped. The dashboard joins
   * GET /api/books for cover images.
   */
  bookIds: z.array(z.string()).default([]),
});
export type CampaignListRow = z.infer<typeof campaignListRowSchema>;

/** A named entity (ad group, target, search term) with its metric totals. */
export const namedMetricRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
});
export type NamedMetricRow = z.infer<typeof namedMetricRowSchema>;

/** Current Amazon negative keyword attached to a campaign or one ad group. */
export const negativeKeywordRowSchema = z.object({
  id: z.string(),
  keywordText: z.string(),
  matchType: z.string(),
  level: z.enum(["campaign", "ad_group"]),
  adGroupId: z.string().nullable(),
  adGroupName: z.string().nullable(),
  state: z.string(),
  /**
   * When the app first saw this negative (Amazon exposes no creation date):
   * the apply date for negatives created through the app, first sync otherwise.
   */
  firstSeenAt: isoDateTimeSchema,
});
export type NegativeKeywordRow = z.infer<typeof negativeKeywordRowSchema>;

/** Current Amazon negative product target (ASIN_SAME_AS) on a campaign or ad group. */
export const negativeTargetRowSchema = z.object({
  id: z.string(),
  asin: z.string(),
  targetType: z.literal("ASIN_SAME_AS"),
  level: z.enum(["campaign", "ad_group"]),
  adGroupId: z.string().nullable(),
  adGroupName: z.string().nullable(),
  state: z.string(),
  /**
   * When the app first saw this negative (Amazon exposes no creation date):
   * the apply date for negatives created through the app, first sync otherwise.
   */
  firstSeenAt: isoDateTimeSchema,
});
export type NegativeTargetRow = z.infer<typeof negativeTargetRowSchema>;

/**
 * One search term within a campaign, with KDP royalty estimated through the
 * ad group's book (same single-book attribution as campaign rows) — never
 * guessed when economics are missing.
 */
export const campaignSearchTermRowSchema = namedMetricRowSchema.extend({
  estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
  estimatedAdProfit: decimalStringSchema.nullable(),
  economicsMissing: z.boolean(),
});
export type CampaignSearchTermRow = z.infer<typeof campaignSearchTermRowSchema>;

/**
 * GET /api/search-terms row: one shopper search term aggregated across every
 * campaign of the workspace over the requested window. Royalty/profit follow
 * the same rules as campaign rows — never guessed when economics are missing.
 */
export const searchTermListRowSchema = z.object({
  searchTerm: z.string(),
  campaignCount: z.number().int().nonnegative(),
  /** Distinct marketplace country codes the term's metrics come from. */
  countryCodes: z.array(z.string()),
  currency: currencyCodeSchema,
  totals: metricTotalsSchema.extend({
    acos: z.number().nullable(),
  }),
  estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
  estimatedAdProfit: decimalStringSchema.nullable(),
  economicsMissing: z.boolean(),
  dataCurrentThrough: isoDateSchema.nullable(),
  /**
   * Distinct catalog book ids whose ad groups contributed to this term.
   * Empty when no contributing ads are mapped. The dashboard joins
   * GET /api/books for cover images.
   */
  bookIds: z.array(z.string()).default([]),
});
export type SearchTermListRow = z.infer<typeof searchTermListRowSchema>;

/** One campaign's contribution to a search term (drill-down row). */
export const searchTermCampaignRowSchema = z.object({
  profileId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
  estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
  estimatedAdProfit: decimalStringSchema.nullable(),
  economicsMissing: z.boolean(),
});
export type SearchTermCampaignRow = z.infer<typeof searchTermCampaignRowSchema>;

/** GET /api/search-terms/:term — a search term with its per-campaign breakdown. */
export const searchTermDetailSchema = z.object({
  searchTerm: z.string(),
  /** Marketplace selected for this view (two-letter Amazon country code). */
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  /** Markets where this term has data in the selected window. */
  availableCountryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
  dateRange: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  currency: currencyCodeSchema,
  totals: metricTotalsSchema.extend({
    acos: z.number().nullable(),
    estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
    estimatedAdProfit: decimalStringSchema.nullable(),
  }),
  economicsMissing: z.boolean(),
  dataCurrentThrough: isoDateSchema.nullable(),
  /** Per-day series for the trend chart, in the selected market. */
  daily: z.array(
    z.object({
      date: isoDateSchema,
      cost: nonNegativeDecimalStringSchema,
      sales: nonNegativeDecimalStringSchema,
      estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      estimatedAdProfit: decimalStringSchema.nullable(),
    }),
  ),
  campaigns: z.array(searchTermCampaignRowSchema),
});
export type SearchTermDetail = z.infer<typeof searchTermDetailSchema>;

/** GET /api/campaigns/:id — a campaign with its hierarchy and metric totals. */
export const campaignDetailSchema = z.object({
  dateRange: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  currency: currencyCodeSchema,
  campaign: campaignRowSchema.extend({
    totals: metricTotalsSchema.extend({
      acos: z.number().nullable(),
      estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      estimatedAdProfit: decimalStringSchema.nullable(),
    }),
  }),
  economicsMissing: z.boolean(),
  dataCurrentThrough: isoDateTimeSchema,
  daily: z.array(
    z.object({
      date: isoDateSchema,
      cost: nonNegativeDecimalStringSchema,
      sales: nonNegativeDecimalStringSchema,
      estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      estimatedAdProfit: decimalStringSchema.nullable(),
    }),
  ),
  adGroups: z.array(namedMetricRowSchema).default([]),
  targets: z.array(namedMetricRowSchema).default([]),
  searchTerms: z.array(campaignSearchTermRowSchema).default([]),
  negativeKeywords: z.array(negativeKeywordRowSchema).default([]),
  negativeTargets: z.array(negativeTargetRowSchema).default([]),
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;
