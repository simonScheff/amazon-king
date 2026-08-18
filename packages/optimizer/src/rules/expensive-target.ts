import {
  acos,
  estimatedAdProfit,
  proposedBid,
  royaltyCopies,
  smoothedConversionRate,
} from "../calc.js";
import {
  formatMoney,
  microsToDecimalString,
  roundMicrosToDp,
} from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  hasEconomics,
  isInCooldown,
  isProtectedCampaign,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const EXPENSIVE_TARGET_RULE_VERSION = "expensive_target@2";

export interface ExpensiveTargetInput {
  targetId: string;
  profileId?: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  currentBidMicros: number;
  metrics: WindowMetrics;
}

/**
 * expensive_target@2 — orders exist but estimated ad profit is negative or
 * ACoS is materially (>= 1.2x) above target → reduce the bid, clamped to at
 * most -15% per cooldown period (docs/plan.md §9). Version 2 values royalty on
 * copies sold instead of orders, so multi-copy orders are no longer treated as
 * a single royalty.
 *
 * This is a profit-down-bid action: it requires KDP book economics and is
 * suppressed entirely in launch/discovery mode. Without economics it must
 * not fire (disabled, not guessed). Also suppressed for protected campaigns
 * and during the cooldown after a bid change on the same target.
 */
export function evaluateExpensiveTarget(
  input: ExpensiveTargetInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (ctx.goalMode === "launch") return null;
  if (!hasEconomics(ctx)) return null;
  if (isProtectedCampaign(ctx, input.campaignId)) return null;
  if (
    isInCooldown(ctx, { actionType: "update_bid", targetId: input.targetId })
  ) {
    return null;
  }

  const { minClicks, minOrders, acosMultiplier } = ctx.config.expensiveTarget;
  const { clicks, orders, units, costMicros, salesMicros } = input.metrics;
  if (clicks < minClicks || orders < minOrders) return null;

  const targetAcos = ctx.targetAcos as number;
  const royaltyPerSaleMicros = ctx.royaltyPerSaleMicros as number;
  const observedAcos = acos(costMicros, salesMicros);
  const copies = royaltyCopies(orders, units);
  const profitMicros = estimatedAdProfit(
    copies,
    royaltyPerSaleMicros,
    costMicros,
  );
  const acosTooHigh =
    observedAcos !== null && observedAcos >= acosMultiplier * targetAcos;
  const profitNegative = profitMicros < 0;
  if (!acosTooHigh && !profitNegative) return null;

  const cvr = smoothedConversionRate(
    clicks,
    orders,
    ctx.config.smoothing.priorRate,
    ctx.config.smoothing.priorWeight,
  );
  const bid = proposedBid({
    currentBidMicros: input.currentBidMicros,
    targetAcos,
    observedAcos: observedAcos ?? acosMultiplier * targetAcos,
    smoothedCvr: cvr,
    royaltyPerSaleMicros,
    maxBidMicros: ctx.maxBidMicros,
    clampMin: ctx.config.bidClamp.min,
    clampMax: ctx.config.bidClamp.max,
    minRelativeChange: ctx.config.minBidRelativeChange,
  });
  if (bid === null || bid.bidMicros >= input.currentBidMicros) return null;

  // Guardrail consistency: the profit-ceiling CPC can sit far below the
  // clamped bid; the per-cooldown 15% cap applies in both directions, so the
  // recommendation never proposes a cut deeper than the clamp band.
  const floorMicros = roundMicrosToDp(
    input.currentBidMicros * ctx.config.bidClamp.min,
  );
  const finalBidMicros = Math.max(bid.bidMicros, floorMicros);
  if (finalBidMicros >= input.currentBidMicros) return null;

  const excessSpendMicros = Math.max(
    0,
    Math.round(costMicros - targetAcos * salesMicros),
  );
  const impactMicros = Math.max(
    Math.abs(Math.min(profitMicros, 0)),
    excessSpendMicros,
  );
  const confidence = Math.min(
    evidenceConfidence(clicks, minClicks),
    evidenceConfidence(orders, minOrders),
  );
  const acosText =
    observedAcos === null
      ? "n/a (no attributed sales yet)"
      : observedAcos.toFixed(4);
  return {
    type: "expensive_target",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId,
    targetId: input.targetId,
    searchTerm: null,
    currentValue: microsToDecimalString(input.currentBidMicros),
    proposedValue: microsToDecimalString(finalBidMicros),
    rationale:
      `Target ${input.targetId} has ${orders} order(s) but is losing money: ` +
      `estimated ad profit is ${formatMoney(profitMicros, ctx.currency)} and ` +
      `observed ACoS ${acosText} vs target ${targetAcos.toFixed(4)}. ` +
      `Lower the bid from ${microsToDecimalString(input.currentBidMicros)} to ` +
      `${microsToDecimalString(finalBidMicros)} (clamped to at most -15%).`,
    confidence,
    impactMicros,
    evidenceWindow: ctx.window,
    ruleVersion: EXPENSIVE_TARGET_RULE_VERSION,
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
      floorMicros,
      finalBidMicros,
      minClicks,
      minOrders,
      acosMultiplier,
      window: ctx.window,
      ruleVersion: EXPENSIVE_TARGET_RULE_VERSION,
    },
    requiresHumanReview: false,
  };
}
