import { z } from "zod";
import {
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
} from "./common.js";

export const recommendationTypeSchema = z.enum([
  "wasteful_search_term",
  "expensive_target",
  "profitable_target",
  "search_term_harvest",
  "budget_constrained_winner",
  "high_ctr_poor_conversion",
  "low_impressions",
  "placement_opportunity",
  "cannibalization_conflict",
]);
export type RecommendationType = z.infer<typeof recommendationTypeSchema>;

export const recommendationStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "applied",
  "protected",
]);
export type RecommendationState = z.infer<typeof recommendationStateSchema>;

/**
 * A deterministic, evidence-backed recommendation produced by the optimizer.
 * Values are string-encoded decimals; entity refs are nullable because not
 * every recommendation type targets the same entity grain.
 */
export const recommendationSchema = z.object({
  id: z.string(),
  type: recommendationTypeSchema,
  state: recommendationStateSchema,
  priority: z.number().int().min(1).max(5),
  profileId: z.string().nullable(),
  campaignId: z.string().nullable(),
  adGroupId: z.string().nullable(),
  targetId: z.string().nullable(),
  searchTerm: z.string().nullable(),
  currentValue: decimalStringSchema.nullable(),
  proposedValue: decimalStringSchema.nullable(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceWindow: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  dataFreshness: isoDateTimeSchema,
  ruleVersion: z.string(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * Evidence and current campaign identity needed for a human to resolve one
 * cannibalization finding. Campaign ids are Amazon ids; the browser never
 * receives internal database primary keys.
 */
export const cannibalizationCampaignSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  state: z.string(),
  targetingType: z.string().nullable(),
  spend: decimalStringSchema,
  orders: z.number().int().nonnegative(),
});
export type CannibalizationCampaign = z.infer<
  typeof cannibalizationCampaignSchema
>;

export const cannibalizationResolutionContextSchema = z.object({
  recommendationId: z.string(),
  profileId: z.string(),
  searchTerm: z.string(),
  currency: currencyCodeSchema,
  confidence: z.number().min(0).max(1),
  evidenceWindow: z.object({
    start: isoDateSchema,
    end: isoDateSchema,
  }),
  dataFreshness: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  totalSpend: decimalStringSchema,
  campaigns: z.array(cannibalizationCampaignSchema).min(2),
});
export type CannibalizationResolutionContext = z.infer<
  typeof cannibalizationResolutionContextSchema
>;

export const cannibalizationResolutionCreateSchema = z.object({
  destinationCampaignId: z.string().min(1),
});
export type CannibalizationResolutionCreate = z.infer<
  typeof cannibalizationResolutionCreateSchema
>;

export const changeSetCreateSchema = z.object({
  recommendationIds: z.array(z.string()).min(1),
});
export type ChangeSetCreate = z.infer<typeof changeSetCreateSchema>;

export const changeSetStatusSchema = z.enum([
  "draft",
  "previewed",
  "applying",
  "applied",
  "partially_applied",
  "failed",
  "blocked",
]);
export type ChangeSetStatus = z.infer<typeof changeSetStatusSchema>;

export const changeSetSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  status: changeSetStatusSchema,
  createdAt: isoDateTimeSchema,
  kind: z.enum(["recommendation", "max_cpc", "rollback"]).optional(),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export const changeActionTypeSchema = z.enum([
  "update_bid",
  "update_ad_group_default_bid",
  "update_campaign_bidding",
  "update_optimization_rule",
  "add_negative_exact",
  "remove_negative_exact",
]);
export type ChangeActionType = z.infer<typeof changeActionTypeSchema>;

/**
 * The concrete Amazon write supported for each recommendation in the MVP.
 * `null` means the recommendation is advisory-only and cannot enter a change
 * set. Shared by the API and web app so the approval UI cannot drift from the
 * guarded-write service.
 */
export const recommendationChangeActionType = {
  wasteful_search_term: "add_negative_exact",
  expensive_target: "update_bid",
  profitable_target: "update_bid",
  search_term_harvest: null,
  budget_constrained_winner: null,
  high_ctr_poor_conversion: null,
  low_impressions: null,
  placement_opportunity: null,
  cannibalization_conflict: null,
} as const satisfies Record<RecommendationType, ChangeActionType | null>;

export const changeActionStatusSchema = z.enum([
  "pending",
  "applied",
  "partially_applied",
  "failed",
  "verification_failed",
  "rolled_back",
]);
export type ChangeActionStatus = z.infer<typeof changeActionStatusSchema>;

export const changeActionSchema = z.object({
  id: z.string(),
  changeSetId: z.string(),
  actionType: changeActionTypeSchema,
  beforeValue: decimalStringSchema.nullable(),
  afterValue: decimalStringSchema.nullable(),
  entityName: z.string().nullable().optional(),
  beforeDetail: z.string().nullable().optional(),
  afterDetail: z.string().nullable().optional(),
  rollbackAvailable: z.boolean().optional(),
  status: changeActionStatusSchema,
  amazonRequestId: z.string().nullable(),
  errorMessage: z.string().nullable().optional(),
});
export type ChangeAction = z.infer<typeof changeActionSchema>;

/** GET /api/change-sets/:id/preview — the set, its actions, and guardrail violations. */
export const changeSetPreviewSchema = z.object({
  changeSet: changeSetSchema,
  actions: z.array(changeActionSchema),
  guardrails: z.array(z.string()).default([]),
});
export type ChangeSetPreview = z.infer<typeof changeSetPreviewSchema>;
