import { microsToDecimalString } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const LOW_IMPRESSIONS_RULE_VERSION = "low_impressions@1";

export interface LowImpressionsInput {
  targetId: string;
  profileId?: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  /** Amazon entity state, e.g. "enabled" / "paused". */
  state: string;
  currentBidMicros: number | null;
  metrics: WindowMetrics;
}

/**
 * low_impressions@1 — a relevant, active target receives almost no traffic
 * over the window → flag bid, match type, indexing, or targeting for
 * review (docs/plan.md §9). Diagnostic only: the bid is never raised
 * automatically without relevance evidence.
 */
export function evaluateLowImpressions(
  input: LowImpressionsInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (input.state !== "enabled" && input.state !== "active") return null;

  const { maxImpressions } = ctx.config.lowImpressions;
  const { impressions } = input.metrics;
  if (impressions >= maxImpressions) return null;

  // Confidence grows as impressions approach zero (clearer signal of no
  // traffic): at exactly the threshold the rule does not fire; at 0
  // impressions confidence is 1.
  const confidence = Math.min(1, 1 - impressions / maxImpressions + 0.5);
  return {
    type: "low_impressions",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId,
    targetId: input.targetId,
    searchTerm: null,
    currentValue:
      input.currentBidMicros === null
        ? null
        : microsToDecimalString(input.currentBidMicros),
    proposedValue: null,
    rationale:
      `Target ${input.targetId} is active but received only ${impressions} ` +
      `impressions over the evidence window. Review the bid, match type, ` +
      `indexing, and targeting relevance. The bid is not raised automatically ` +
      `without evidence the traffic would be relevant.`,
    confidence,
    impactMicros: 0,
    evidenceWindow: ctx.window,
    ruleVersion: LOW_IMPRESSIONS_RULE_VERSION,
    evidenceInputs: {
      targetId: input.targetId,
      campaignId: input.campaignId,
      state: input.state,
      currentBidMicros: input.currentBidMicros,
      impressions,
      maxImpressions,
      window: ctx.window,
      ruleVersion: LOW_IMPRESSIONS_RULE_VERSION,
    },
    requiresHumanReview: true,
  };
}
