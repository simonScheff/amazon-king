import { acos, estimatedAdProfit, royaltyCopies } from "../calc.js";
import { formatMoney } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  hasEconomics,
  isProtectedCampaign,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const PLACEMENT_OPPORTUNITY_RULE_VERSION = "placement_opportunity@2";

export interface PlacementOpportunityInput {
  campaignId: string;
  profileId?: string | null;
  /** Placement code, e.g. "PLACEMENT_TOP" / "PLACEMENT_PRODUCT_PAGE". */
  placement: string;
  /** Current placement bid modifier as a fraction (0 = no adjustment). */
  currentModifierPct: number;
  metrics: WindowMetrics;
}

/**
 * placement_opportunity@2 — a placement is consistently profitable with
 * enough volume (orders and clicks above thresholds, ACoS <= 0.8x target)
 * → suggest a capped placement adjustment (docs/plan.md §9). Requires KDP
 * economics; the adjustment is a single fixed step so repeated approvals
 * cannot compound beyond the cap in one recommendation. Version 2 values
 * royalty on copies sold instead of orders.
 */
export function evaluatePlacementOpportunity(
  input: PlacementOpportunityInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (!hasEconomics(ctx)) return null;
  if (isProtectedCampaign(ctx, input.campaignId)) return null;

  const { minClicks, minOrders, acosMultiplier, adjustPct } =
    ctx.config.placementOpportunity;
  const { clicks, orders, units, costMicros, salesMicros } = input.metrics;
  if (clicks < minClicks || orders < minOrders) return null;

  const targetAcos = ctx.targetAcos as number;
  const observedAcos = acos(costMicros, salesMicros);
  if (observedAcos === null || observedAcos > acosMultiplier * targetAcos) {
    return null;
  }
  const copies = royaltyCopies(orders, units);
  const profitMicros = estimatedAdProfit(
    copies,
    ctx.royaltyPerSaleMicros as number,
    costMicros,
  );
  if (profitMicros <= 0) return null;

  const proposedModifier = input.currentModifierPct + adjustPct;
  const confidence = Math.min(
    evidenceConfidence(clicks, minClicks),
    evidenceConfidence(orders, minOrders),
  );
  return {
    type: "placement_opportunity",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: null,
    targetId: null,
    searchTerm: null,
    currentValue: input.currentModifierPct.toFixed(4),
    proposedValue: proposedModifier.toFixed(4),
    rationale:
      `Placement ${input.placement} in campaign ${input.campaignId} is ` +
      `consistently profitable: ${orders} orders, estimated ad profit ` +
      `${formatMoney(profitMicros, ctx.currency)}, ACoS ${observedAcos.toFixed(4)} ` +
      `vs target ${targetAcos.toFixed(4)}. Consider raising the placement ` +
      `modifier from ${(input.currentModifierPct * 100).toFixed(0)}% to ` +
      `${(proposedModifier * 100).toFixed(0)}% (single capped step).`,
    confidence,
    impactMicros: profitMicros,
    evidenceWindow: ctx.window,
    ruleVersion: PLACEMENT_OPPORTUNITY_RULE_VERSION,
    evidenceInputs: {
      campaignId: input.campaignId,
      placement: input.placement,
      currentModifierPct: input.currentModifierPct,
      clicks,
      orders,
      units: units ?? 0,
      royaltyCopies: copies,
      costMicros,
      salesMicros,
      observedAcos,
      targetAcos,
      profitMicros,
      minClicks,
      minOrders,
      acosMultiplier,
      adjustPct,
      window: ctx.window,
      ruleVersion: PLACEMENT_OPPORTUNITY_RULE_VERSION,
    },
    requiresHumanReview: false,
  };
}
