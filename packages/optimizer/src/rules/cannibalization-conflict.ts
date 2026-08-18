import { formatMoney } from "../money.js";
import {
  evidenceConfidence,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const CANNIBALIZATION_CONFLICT_RULE_VERSION =
  "cannibalization_conflict@2";

export interface CannibalizingCampaign {
  campaignId: string;
  orders: number;
  costMicros: number;
  /**
   * The campaign can no longer serve this term because a negative keyword
   * already blocks it (see negatives.ts). Historical spend stays in the
   * evidence window long after the negative is applied, so the campaign is
   * excluded from the conflict rather than removed from the input.
   */
  blockedByNegative?: boolean;
}

export interface CannibalizationConflictInput {
  searchTerm: string;
  profileId?: string | null;
  campaigns: CannibalizingCampaign[];
}

/**
 * cannibalization_conflict@2 — the same shopper term is targeted across
 * >= 2 overlapping campaigns that can all still serve it → suggest
 * consolidation or intent separation (docs/plan.md §9). Campaigns already
 * blocked by a negative keyword do not count toward the conflict, so a
 * resolved term stops being recommended. Always requires human review; no
 * automatic change is proposed.
 */
export function evaluateCannibalizationConflict(
  input: CannibalizationConflictInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  const { minCampaigns } = ctx.config.cannibalizationConflict;
  const competing = input.campaigns.filter(
    (campaign) => campaign.blockedByNegative !== true,
  );
  const excludedCampaigns = input.campaigns.filter(
    (campaign) => campaign.blockedByNegative === true,
  );
  if (competing.length < minCampaigns) return null;

  const totalCostMicros = competing.reduce(
    (sum, campaign) => sum + campaign.costMicros,
    0,
  );
  const campaignIds = competing.map((campaign) => campaign.campaignId);
  const confidence = evidenceConfidence(competing.length, minCampaigns);
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
      `${competing.length} campaigns (${campaignIds.join(", ")}), ` +
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
      campaigns: competing,
      excludedCampaigns,
      minCampaigns,
      totalCostMicros,
      window: ctx.window,
      ruleVersion: CANNIBALIZATION_CONFLICT_RULE_VERSION,
    },
    requiresHumanReview: true,
  };
}
