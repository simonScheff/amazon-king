import {
  acos,
  estimatedAdProfit,
  proposedBid,
  royaltyCopies,
  smoothedConversionRate,
} from "../calc.js";
import { formatMoney, microsToDecimalString } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  hasEconomics,
  isInCooldown,
  isProtectedCampaign,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const PROFITABLE_TARGET_RULE_VERSION = "profitable_target@2";

export interface ProfitableTargetInput {
  targetId: string;
  profileId?: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  currentBidMicros: number;
  metrics: WindowMetrics;
}

/**
 * profitable_target@2 — multiple orders, positive estimated ad profit, and
 * ACoS safely (<= 0.8x) below target → raise the bid cautiously, clamped to
 * at most +15% and capped by the profit-ceiling CPC and the configured max
 * bid (docs/plan.md §9). Version 2 values royalty on copies sold instead of
 * orders, so multi-copy orders are no longer treated as a single royalty.
 *
 * Requires KDP book economics — never infers profitability from revenue
 * alone. Suppressed for protected campaigns and during the cooldown after a
 * bid change on the same target.
 */
export function evaluateProfitableTarget(
  input: ProfitableTargetInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (!hasEconomics(ctx)) return null;
  if (isProtectedCampaign(ctx, input.campaignId)) return null;
  if (
    isInCooldown(ctx, { actionType: "update_bid", targetId: input.targetId })
  ) {
    return null;
  }

  const { minClicks, minOrders, acosMultiplier } = ctx.config.profitableTarget;
  const { clicks, orders, units, costMicros, salesMicros } = input.metrics;
  if (clicks < minClicks || orders < minOrders) return null;

  const targetAcos = ctx.targetAcos as number;
  const royaltyPerSaleMicros = ctx.royaltyPerSaleMicros as number;
  const observedAcos = acos(costMicros, salesMicros);
  if (observedAcos === null || observedAcos > acosMultiplier * targetAcos) {
    return null;
  }
  const copies = royaltyCopies(orders, units);
  const profitMicros = estimatedAdProfit(
    copies,
    royaltyPerSaleMicros,
    costMicros,
  );
  if (profitMicros <= 0) return null;

  const cvr = smoothedConversionRate(
    clicks,
    orders,
    ctx.config.smoothing.priorRate,
    ctx.config.smoothing.priorWeight,
  );
  const bid = proposedBid({
    currentBidMicros: input.currentBidMicros,
    targetAcos,
    observedAcos,
    smoothedCvr: cvr,
    royaltyPerSaleMicros,
    maxBidMicros: ctx.maxBidMicros,
    clampMin: ctx.config.bidClamp.min,
    clampMax: ctx.config.bidClamp.max,
    minRelativeChange: ctx.config.minBidRelativeChange,
  });
  if (bid === null || bid.bidMicros <= input.currentBidMicros) return null;

  const confidence = Math.min(
    evidenceConfidence(clicks, minClicks),
    evidenceConfidence(orders, minOrders),
  );
  return {
    type: "profitable_target",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId,
    targetId: input.targetId,
    searchTerm: null,
    currentValue: microsToDecimalString(input.currentBidMicros),
    proposedValue: microsToDecimalString(bid.bidMicros),
    rationale:
      `Target ${input.targetId} is profitable: ${orders} orders, estimated ad ` +
      `profit ${formatMoney(profitMicros, ctx.currency)}, observed ACoS ` +
      `${observedAcos.toFixed(4)} well below target ${targetAcos.toFixed(4)}. ` +
      `Raise the bid from ${microsToDecimalString(input.currentBidMicros)} to ` +
      `${microsToDecimalString(bid.bidMicros)} (clamped to at most +15%, capped ` +
      `by the break-even CPC and max bid).`,
    confidence,
    impactMicros: profitMicros,
    evidenceWindow: ctx.window,
    ruleVersion: PROFITABLE_TARGET_RULE_VERSION,
    evidenceInputs: {
      targetId: input.targetId,
      campaignId: input.campaignId,
      currentBidMicros: input.currentBidMicros,
      clicks,
      orders,
      units: units ?? 0,
      royaltyCopies: copies,
      costMicros,
      salesMicros,
      observedAcos,
      targetAcos,
      royaltyPerSaleMicros,
      profitMicros,
      smoothedCvr: cvr,
      clampedMultiplier: bid.clampedMultiplier,
      ceilingMicros: bid.ceilingMicros,
      minClicks,
      minOrders,
      acosMultiplier,
      window: ctx.window,
      ruleVersion: PROFITABLE_TARGET_RULE_VERSION,
    },
    requiresHumanReview: false,
  };
}
