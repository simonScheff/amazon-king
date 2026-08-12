import { estimatedAdProfit } from "../calc.js";
import {
  formatMoney,
  microsToDecimalString,
  roundMicrosToDp,
} from "../money.js";
import type { WindowMetrics } from "../types.js";
import {
  evidenceConfidence,
  isProtectedCampaign,
  type RecommendationDraft,
  type RuleContext,
} from "./types.js";

export const BUDGET_CONSTRAINED_WINNER_RULE_VERSION =
  "budget_constrained_winner@1";

export interface BudgetConstrainedWinnerInput {
  campaignId: string;
  profileId?: string | null;
  dailyBudgetMicros: number;
  /** Spend per day over the evidence window, one entry per day. */
  dailySpendMicros: number[];
  metrics: WindowMetrics;
}

/**
 * budget_constrained_winner@1 — a profitable campaign is regularly budget
 * constrained (spend >= 90% of daily budget on enough days) → suggest a
 * budget increase, capped by the configured increase percentage and the
 * profile's max daily budget (docs/plan.md §9).
 *
 * Profitability requires KDP economics — it is never inferred from revenue
 * alone, so the rule does not fire when economics are missing.
 */
export function evaluateBudgetConstrainedWinner(
  input: BudgetConstrainedWinnerInput,
  ctx: RuleContext,
): RecommendationDraft | null {
  if (ctx.royaltyPerSaleMicros === null) return null;
  if (isProtectedCampaign(ctx, input.campaignId)) return null;
  if (input.dailyBudgetMicros <= 0) return null;

  const { minUtilization, minConstrainedDays, increasePct } =
    ctx.config.budgetConstrainedWinner;
  const constrainedDays = input.dailySpendMicros.filter(
    (spend) => spend >= minUtilization * input.dailyBudgetMicros,
  ).length;
  if (constrainedDays < minConstrainedDays) return null;

  const profitMicros = estimatedAdProfit(
    input.metrics.orders,
    ctx.royaltyPerSaleMicros,
    input.metrics.costMicros,
  );
  if (profitMicros <= 0) return null;

  const uncapped = roundMicrosToDp(input.dailyBudgetMicros * (1 + increasePct));
  const proposedMicros =
    ctx.maxDailyBudgetMicros !== null
      ? Math.min(uncapped, ctx.maxDailyBudgetMicros)
      : uncapped;
  if (proposedMicros <= input.dailyBudgetMicros) return null;

  const confidence = evidenceConfidence(constrainedDays, minConstrainedDays);
  return {
    type: "budget_constrained_winner",
    profileId: input.profileId ?? null,
    campaignId: input.campaignId,
    adGroupId: null,
    targetId: null,
    searchTerm: null,
    currentValue: microsToDecimalString(input.dailyBudgetMicros),
    proposedValue: microsToDecimalString(proposedMicros),
    rationale:
      `Campaign ${input.campaignId} is profitable (estimated ad profit ` +
      `${formatMoney(profitMicros, ctx.currency)}) but spent at least ` +
      `${Math.round(minUtilization * 100)}% of its daily budget on ` +
      `${constrainedDays} day(s) in the window. Raise the daily budget from ` +
      `${microsToDecimalString(input.dailyBudgetMicros)} to ` +
      `${microsToDecimalString(proposedMicros)} to stop capping a winner.`,
    confidence,
    impactMicros: profitMicros,
    evidenceWindow: ctx.window,
    ruleVersion: BUDGET_CONSTRAINED_WINNER_RULE_VERSION,
    evidenceInputs: {
      campaignId: input.campaignId,
      dailyBudgetMicros: input.dailyBudgetMicros,
      dailySpendMicros: input.dailySpendMicros,
      constrainedDays,
      minUtilization,
      minConstrainedDays,
      increasePct,
      orders: input.metrics.orders,
      costMicros: input.metrics.costMicros,
      royaltyPerSaleMicros: ctx.royaltyPerSaleMicros,
      profitMicros,
      maxDailyBudgetMicros: ctx.maxDailyBudgetMicros,
      window: ctx.window,
      ruleVersion: BUDGET_CONSTRAINED_WINNER_RULE_VERSION,
    },
    requiresHumanReview: false,
  };
}
