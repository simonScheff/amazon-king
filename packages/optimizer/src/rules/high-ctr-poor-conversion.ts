import { conversionRate } from "../calc.js";
import { formatMoney } from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const HIGH_CTR_POOR_CONVERSION_RULE_VERSION =
  "high_ctr_poor_conversion@1";

export interface HighCtrPoorConversionInput {
  profileId?: string | null;
  campaignId: string | null;
  adGroupId?: string | null;
  targetId?: string | null;
  metrics: WindowMetrics;
}

/**
 * high_ctr_poor_conversion@1 — the ad attracts clicks (CTR >= 0.3% with
 * >= 1000 impressions) but the book does not sell (CVR below the floor).
 * This is diagnostic only: the Ads API cannot fix the KDP listing, so no
 * bid/budget value is proposed — the rationale flags cover, price,
 * subtitle, listing, or audience mismatch for human review.
 */
export function evaluateHighCtrPoorConversion(
  input: HighCtrPoorConversionInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  const { minCtr, minImpressions, maxCvr } = ctx.config.highCtrPoorConversion;
  const { impressions, clicks, orders, costMicros } = input.metrics;
  if (impressions < minImpressions) return null;

  const ctr = clicks / impressions;
  if (ctr < minCtr) return null;
  const cvr = conversionRate(orders, clicks) ?? 0;
  if (cvr >= maxCvr) return null;

  const confidence = evidenceConfidence(impressions, minImpressions);
  return {
    type: "high_ctr_poor_conversion",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId ?? null,
    targetId: input.targetId ?? null,
    searchTerm: null,
    currentValue: null,
    proposedValue: null,
    rationale:
      `The ad gets clicked (CTR ${(ctr * 100).toFixed(2)}% over ` +
      `${impressions} impressions) but converts at only ${(cvr * 100).toFixed(2)}%, ` +
      `spending ${formatMoney(costMicros, ctx.currency)} for ${orders} order(s). ` +
      `Shoppers interested enough to click do not buy: review the cover, price, ` +
      `subtitle, listing copy, and audience match. The Ads API cannot fix the ` +
      `KDP listing — no automatic change is proposed.`,
    confidence,
    impactMicros: costMicros,
    evidenceWindow: ctx.window,
    ruleVersion: HIGH_CTR_POOR_CONVERSION_RULE_VERSION,
    evidenceInputs: {
      campaignId: input.campaignId,
      targetId: input.targetId ?? null,
      impressions,
      clicks,
      orders,
      costMicros,
      ctr,
      cvr,
      minCtr,
      minImpressions,
      maxCvr,
      window: ctx.window,
      ruleVersion: HIGH_CTR_POOR_CONVERSION_RULE_VERSION,
    },
    requiresHumanReview: true,
  };
}
