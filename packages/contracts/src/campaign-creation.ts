import { z } from "zod";
import { isoDateSchema, nonNegativeDecimalStringSchema } from "./common.js";
import { changeSetSchema } from "./recommendations.js";

export const campaignCreationTargetingTypeSchema = z.enum(["AUTO", "MANUAL"]);
export type CampaignCreationTargetingType = z.infer<
  typeof campaignCreationTargetingTypeSchema
>;

export const campaignCreationMatchTypeSchema = z.enum([
  "EXACT",
  "PHRASE",
  "BROAD",
]);
export type CampaignCreationMatchType = z.infer<
  typeof campaignCreationMatchTypeSchema
>;

/**
 * Owner-submitted draft for creating one Sponsored Products campaign (plus its
 * ad group, product ad, and keywords) across one or more profiles. Money
 * fields are string-encoded decimals; the campaign is created paused unless
 * the owner explicitly enables it.
 */
export const campaignCreationCreateSchema = z.object({
  profileIds: z.array(z.string().min(1)).min(1),
  campaign: z.object({
    name: z.string().min(1),
    dailyBudget: nonNegativeDecimalStringSchema,
    targetingType: campaignCreationTargetingTypeSchema,
    startDate: isoDateSchema,
    state: z.enum(["enabled", "paused"]).default("paused"),
  }),
  adGroup: z.object({
    name: z.string().min(1),
    defaultBid: nonNegativeDecimalStringSchema,
  }),
  bookId: z.string().min(1),
  keywords: z
    .array(
      z.object({
        text: z.string().min(1),
        matchType: campaignCreationMatchTypeSchema,
        bid: nonNegativeDecimalStringSchema,
      }),
    )
    .min(1),
  /**
   * Set when this campaign resolves a cannibalization finding: alongside the
   * creation set the API drafts negative-exact keywords for the conflicting
   * campaigns, locked until this creation set is applied.
   */
  cannibalization: z.object({ recommendationId: z.string().min(1) }).optional(),
});
export type CampaignCreationCreate = z.infer<
  typeof campaignCreationCreateSchema
>;

/** The guarded change sets created from one campaign-creation submission. */
export const campaignCreationResultSchema = z.object({
  changeSets: z.array(changeSetSchema),
});
export type CampaignCreationResult = z.infer<
  typeof campaignCreationResultSchema
>;
