import { z } from "zod";
import {
  currencyCodeSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";
import { changeActionSchema, changeSetSchema } from "./recommendations.js";

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

/** Pause or enable a campaign (one-click guarded apply). */
export const updateCampaignStateSchema = z.object({
  state: z.enum(["enabled", "paused"]),
});
export type UpdateCampaignState = z.infer<typeof updateCampaignStateSchema>;

/** Rename a campaign (one-click guarded apply). Amazon caps names at 128. */
export const renameCampaignSchema = z.object({
  name: z.string().trim().min(1).max(128),
});
export type RenameCampaign = z.infer<typeof renameCampaignSchema>;

/**
 * Block shopper terms in one campaign. Each term becomes a campaign-level
 * negative exact keyword, or a negative ASIN product target when the term is
 * an ASIN. The result is a draft change set — nothing reaches Amazon until it
 * is applied from Change center.
 */
export const campaignNegativesCreateSchema = z.object({
  searchTerms: z.array(z.string().trim().min(1)).min(1).max(50),
});
export type CampaignNegativesCreate = z.infer<
  typeof campaignNegativesCreateSchema
>;

/**
 * Block one shopper term across many campaigns at once (the search-term
 * detail "Exclude everywhere" action). `campaignIds` are Amazon campaign ids;
 * each one that currently runs the term and is enabled gets its own draft
 * change set via the same per-campaign logic as `campaignNegativesCreateSchema`.
 */
export const searchTermNegativesCreateSchema = z.object({
  campaignIds: z.array(z.string().trim().min(1)).min(1).max(50),
});
export type SearchTermNegativesCreate = z.infer<
  typeof searchTermNegativesCreateSchema
>;

/**
 * The drafts created by one bulk exclude. Requested campaign ids that are
 * unknown, do not run the term, or are not enabled are reported as skipped —
 * never an error.
 */
export const searchTermNegativesResultSchema = z.object({
  changeSetIds: z.array(z.string()),
  skippedCampaignIds: z.array(z.string()),
});
export type SearchTermNegativesResult = z.infer<
  typeof searchTermNegativesResultSchema
>;

/** The applied one-click campaign update (pause/enable or rename). */
export const campaignUpdateResultSchema = z.object({
  changeSet: changeSetSchema,
  actions: z.array(changeActionSchema),
});
export type CampaignUpdateResult = z.infer<typeof campaignUpdateResultSchema>;
