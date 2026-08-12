import { breakEvenCpc, smoothedConversionRate } from "../calc.js";
import { microsToDecimalString } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const SEARCH_TERM_HARVEST_RULE_VERSION = "search_term_harvest@1";

export type SourceTargetingType = "auto" | "broad" | "phrase" | "exact";

export interface SearchTermHarvestInput {
  searchTerm: string;
  profileId?: string | null;
  sourceCampaignId: string | null;
  sourceTargetingType: SourceTargetingType;
  /** True when the term is already an exact keyword in a manual campaign. */
  alreadyTargetedExactly: boolean;
  metrics: WindowMetrics;
}

/**
 * search_term_harvest@1 — a shopper term converts repeatedly (>= 2 orders)
 * inside automatic/broad targeting → propose adding it as an exact keyword
 * in a controlled manual campaign (docs/plan.md §9). Skipped when the term
 * is already targeted exactly (duplicate/conflict avoidance).
 *
 * The proposed value is the estimated break-even CPC when KDP economics are
 * available (smoothed CVR x royalty); otherwise null and the human sets the
 * starting bid.
 */
export function evaluateSearchTermHarvest(
  input: SearchTermHarvestInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (
    input.sourceTargetingType !== "auto" &&
    input.sourceTargetingType !== "broad"
  ) {
    return null;
  }
  if (input.alreadyTargetedExactly) return null;

  const { minOrders } = ctx.config.searchTermHarvest;
  const { clicks, orders, costMicros, salesMicros } = input.metrics;
  if (orders < minOrders) return null;

  let proposedValue: string | null = null;
  if (ctx.royaltyPerSaleMicros !== null) {
    const cvr = smoothedConversionRate(
      clicks,
      orders,
      ctx.config.smoothing.priorRate,
      ctx.config.smoothing.priorWeight,
    );
    proposedValue = microsToDecimalString(
      breakEvenCpc(cvr, ctx.royaltyPerSaleMicros),
    );
  }

  const confidence = evidenceConfidence(orders, minOrders);
  return {
    type: "search_term_harvest",
    profileId: input.profileId ?? null,
    campaignId: input.sourceCampaignId,
    adGroupId: null,
    targetId: null,
    searchTerm: input.searchTerm,
    currentValue: null,
    proposedValue,
    rationale:
      `Shoppers searching "${input.searchTerm}" ordered ${orders} times via ` +
      `${input.sourceTargetingType} targeting. Adding it as an exact keyword ` +
      `in a controlled manual campaign gives direct bid control` +
      (proposedValue !== null
        ? `; the estimated break-even CPC is ${proposedValue}.`
        : "."),
    confidence,
    impactMicros: salesMicros,
    evidenceWindow: ctx.window,
    ruleVersion: SEARCH_TERM_HARVEST_RULE_VERSION,
    evidenceInputs: {
      searchTerm: input.searchTerm,
      sourceCampaignId: input.sourceCampaignId,
      sourceTargetingType: input.sourceTargetingType,
      clicks,
      orders,
      costMicros,
      salesMicros,
      minOrders,
      proposedValue,
      window: ctx.window,
      ruleVersion: SEARCH_TERM_HARVEST_RULE_VERSION,
    },
    requiresHumanReview: true,
  };
}
