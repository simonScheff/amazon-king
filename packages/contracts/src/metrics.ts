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

/** A named entity (ad group, target, search term) with its metric totals. */
export const namedMetricRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
});
export type NamedMetricRow = z.infer<typeof namedMetricRowSchema>;

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
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;
