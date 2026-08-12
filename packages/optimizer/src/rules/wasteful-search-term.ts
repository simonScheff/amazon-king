import { formatMoney } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  isInCooldown,
  isProtectedSearchTerm,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const WASTEFUL_SEARCH_TERM_RULE_VERSION = "wasteful_search_term@1";

export interface WastefulSearchTermInput {
  searchTerm: string;
  profileId?: string | null;
  campaignId: string | null;
  adGroupId?: string | null;
  metrics: WindowMetrics;
}

/**
 * wasteful_search_term@1 — meaningful clicks with zero orders → propose a
 * negative exact (docs/plan.md §9: ~20 clicks before a negative decision).
 *
 * Suppressed when: the term is protected, the goal mode is launch/discovery
 * (exploration spend is expected there), or a negative for this term was
 * already added within the cooldown window.
 */
export function evaluateWastefulSearchTerm(
  input: WastefulSearchTermInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (isProtectedSearchTerm(ctx, input.searchTerm)) return null;
  if (ctx.goalMode === "launch") return null;
  if (
    isInCooldown(ctx, {
      actionType: "add_negative_exact",
      searchTerm: input.searchTerm,
    })
  ) {
    return null;
  }

  const { minClicks } = ctx.config.wastefulSearchTerm;
  const { clicks, orders, costMicros } = input.metrics;
  if (clicks < minClicks || orders !== 0) return null;

  const confidence = evidenceConfidence(clicks, minClicks);
  const spend = formatMoney(costMicros, ctx.currency);
  return {
    type: "wasteful_search_term",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId ?? null,
    targetId: null,
    searchTerm: input.searchTerm,
    currentValue: null,
    proposedValue: null,
    rationale:
      `Search term "${input.searchTerm}" accumulated ${clicks} clicks and ` +
      `${spend} in spend over the evidence window without a single order. ` +
      `Adding it as a negative exact stops this wasted spend.`,
    confidence,
    impactMicros: costMicros,
    evidenceWindow: ctx.window,
    ruleVersion: WASTEFUL_SEARCH_TERM_RULE_VERSION,
    evidenceInputs: {
      searchTerm: input.searchTerm,
      campaignId: input.campaignId,
      clicks,
      orders,
      costMicros,
      minClicks,
      goalMode: ctx.goalMode,
      window: ctx.window,
      ruleVersion: WASTEFUL_SEARCH_TERM_RULE_VERSION,
    },
    requiresHumanReview: false,
  };
}
