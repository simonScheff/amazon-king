import { z } from "zod";
import {
  currencyCodeSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";
import { changeSetSchema } from "./recommendations.js";

/** Amazon's Sponsored Products campaign bidding strategies. */
export const sponsoredProductsBiddingStrategySchema = z.enum([
  "LEGACY_FOR_SALES",
  "AUTO_FOR_SALES",
  "MANUAL",
  "RULE_BASED",
]);
export type SponsoredProductsBiddingStrategy = z.infer<
  typeof sponsoredProductsBiddingStrategySchema
>;

export const bidAdjustmentSchema = z.object({
  type: z.enum(["placement", "audience"]),
  name: z.string(),
  percentage: z.number().int().nonnegative(),
});
export type BidAdjustment = z.infer<typeof bidAdjustmentSchema>;

export const bidRuleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  subcategory: z.string(),
  status: z.string(),
});
export type BidRuleSummary = z.infer<typeof bidRuleSummarySchema>;

export const maxCpcCoverageStatusSchema = z.enum([
  "not_configured",
  "pending",
  "covered",
  "drifted",
  "unsupported",
]);
export type MaxCpcCoverageStatus = z.infer<typeof maxCpcCoverageStatusSchema>;

/**
 * One campaign's complete CPC-control surface. A policy is only `covered`
 * when base bids are within the ceiling and every Amazon-side bid increase
 * known to the stable adapters has been neutralized.
 */
export const campaignMaxCpcSchema = z.object({
  campaignId: z.string(),
  profileId: z.string(),
  currency: currencyCodeSchema,
  maxCpc: nonNegativeDecimalStringSchema.nullable(),
  status: maxCpcCoverageStatusSchema,
  strategy: sponsoredProductsBiddingStrategySchema.nullable(),
  adjustments: z.array(bidAdjustmentSchema),
  activeBidRules: z.array(bidRuleSummarySchema),
  coverageIssues: z.array(z.string()),
  currentMaxBaseBid: nonNegativeDecimalStringSchema.nullable(),
  currentMaxAdjustedBid: nonNegativeDecimalStringSchema.nullable(),
  counts: z.object({
    adGroups: z.number().int().nonnegative(),
    explicitTargetBids: z.number().int().nonnegative(),
    bidsAboveCeiling: z.number().int().nonnegative(),
  }),
  writeEnabled: z.boolean(),
  sourceReadAt: isoDateTimeSchema,
  enforcedAt: isoDateTimeSchema.nullable(),
});
export type CampaignMaxCpc = z.infer<typeof campaignMaxCpcSchema>;

export const setCampaignMaxCpcSchema = z.object({
  maxCpc: nonNegativeDecimalStringSchema.refine(
    (value) => Number(value) > 0,
    "Maximum CPC must be greater than zero",
  ),
});
export type SetCampaignMaxCpc = z.infer<typeof setCampaignMaxCpcSchema>;

/** A guarded draft created from one Max CPC submission. */
export const maxCpcChangeSetResultSchema = z.object({
  changeSet: changeSetSchema,
  controls: campaignMaxCpcSchema,
  actionsCreated: z.number().int().nonnegative(),
});
export type MaxCpcChangeSetResult = z.infer<typeof maxCpcChangeSetResultSchema>;
