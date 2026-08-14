import { z } from "zod";
import {
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";

/** Aggregated ad metrics. Money fields are string-encoded decimals. */
export const metricTotalsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  cost: nonNegativeDecimalStringSchema,
  sales: nonNegativeDecimalStringSchema,
  orders: z.number().int().nonnegative(),
});
export type MetricTotals = z.infer<typeof metricTotalsSchema>;

export const dashboardSummarySchema = z.object({
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
  dataCurrentThrough: isoDateTimeSchema,
  /** True when writes are unavailable (kill switch or all profiles read-only). */
  writesDisabled: z.boolean().optional(),
  /** Per-day monetary series for the dashboard trend chart. */
  daily: z
    .array(
      z.object({
        date: isoDateSchema,
        cost: nonNegativeDecimalStringSchema,
        sales: nonNegativeDecimalStringSchema,
        estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      }),
    )
    .optional(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const campaignRowSchema = z.object({
  profileId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
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
});
export type NegativeKeywordRow = z.infer<typeof negativeKeywordRowSchema>;

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
  searchTerms: z.array(namedMetricRowSchema).default([]),
  negativeKeywords: z.array(negativeKeywordRowSchema).default([]),
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;
