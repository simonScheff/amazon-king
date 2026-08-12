import { formatMoney } from "../money.js";
import {
  evidenceConfidence,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const CANNIBALIZATION_CONFLICT_RULE_VERSION =
  "cannibalization_conflict@1";

export interface CannibalizingCampaign {
  campaignId: string;
  orders: number;
  costMicros: number;
}

export interface CannibalizationConflictInput {
  searchTerm: string;
  profileId?: string | null;
  campaigns: CannibalizingCampaign[];
}

/**
 * cannibalization_conflict@1 — the same shopper term is targeted across
 * >= 2 overlapping campaigns → suggest consolidation or intent separation
 * (docs/plan.md §9). Always requires human review; no automatic change is
 * proposed.
 */
export function evaluateCannibalizationConflict(
  input: CannibalizationConflictInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  const { minCampaigns } = ctx.config.cannibalizationConflict;
  if (input.campaigns.length < minCampaigns) return null;

  const totalCostMicros = input.campaigns.reduce(
    (sum, campaign) => sum + campaign.costMicros,
    0,
  );
  const campaignIds = input.campaigns.map((campaign) => campaign.campaignId);
  const confidence = evidenceConfidence(input.campaigns.length, minCampaigns);
  return {
    type: "cannibalization_conflict",
    profileId: input.profileId ?? null,
    campaignId: null,
    adGroupId: null,
    targetId: null,
    searchTerm: input.searchTerm,
    currentValue: null,
    proposedValue: null,
    rationale:
      `Search term "${input.searchTerm}" is targeted in ` +
      `${input.campaigns.length} campaigns (${campaignIds.join(", ")}), ` +
      `spending a combined ${formatMoney(totalCostMicros, ctx.currency)} over ` +
      `the window. Overlapping campaigns bid against each other; consider ` +
      `consolidating the term into one campaign or separating intent ` +
      `(e.g. discovery vs exact). Human review required.`,
    confidence,
    impactMicros: totalCostMicros,
    evidenceWindow: ctx.window,
    ruleVersion: CANNIBALIZATION_CONFLICT_RULE_VERSION,
    evidenceInputs: {
      searchTerm: input.searchTerm,
      campaigns: input.campaigns,
      minCampaigns,
      totalCostMicros,
      window: ctx.window,
      ruleVersion: CANNIBALIZATION_CONFLICT_RULE_VERSION,
    },
    requiresHumanReview: true,
  };
}
