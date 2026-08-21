import { z } from "zod";
import { ASIN_PATTERN } from "./asin.js";
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

/** An ASIN product target drafted with a new campaign. */
export const campaignCreationTargetSchema = z.object({
  asin: z
    .string()
    .regex(ASIN_PATTERN, "Expected a 10-character ASIN (B0… or ISBN-10)"),
  bid: nonNegativeDecimalStringSchema.optional(),
});
export type CampaignCreationTarget = z.infer<
  typeof campaignCreationTargetSchema
>;

/**
 * Owner-submitted draft for creating one Sponsored Products campaign (plus its
 * ad group, product ad, keywords, and/or ASIN product targets) across one or
 * more profiles. Money fields are string-encoded decimals; the campaign is
 * created paused unless the owner explicitly enables it.
 */
export const campaignCreationCreateSchema = z
  .object({
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
      .default([]),
    // Intentionally optional without a schema-level default: a `.default([])`
    // would make `targets` required in the inferred output type, breaking
    // consumers that construct `CampaignCreationCreate` payloads by hand.
    targets: z.array(campaignCreationTargetSchema).optional(),
    /**
     * Set when this campaign resolves a cannibalization finding: alongside the
     * creation set the API drafts negative-exact keywords for the conflicting
     * campaigns, locked until this creation set is applied.
     */
    cannibalization: z
      .object({ recommendationId: z.string().min(1) })
      .optional(),
  })
  // Amazon creates the four default auto targets (close/loose match,
  // substitutes, complements) for AUTO campaigns itself and rejects manual
  // keywords or product targets in them ("Only negative keywords and negative
  // product targets are allowed in auto-targeting campaigns"), so manual
  // targeting clauses are only valid — and required — for MANUAL campaigns.
  .refine(
    (value) =>
      value.campaign.targetingType === "AUTO" ||
      value.keywords.length + (value.targets?.length ?? 0) > 0,
    { message: "Provide at least one keyword or product target" },
  )
  .refine(
    (value) =>
      value.campaign.targetingType === "MANUAL" ||
      (value.keywords.length === 0 && (value.targets?.length ?? 0) === 0),
    {
      message:
        "Automatic campaigns are targeted by Amazon — keywords and product targets require manual targeting",
    },
  );
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
