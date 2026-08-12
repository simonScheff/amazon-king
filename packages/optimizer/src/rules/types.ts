import type {
  CurrencyCode,
  GoalMode,
  IsoDateTime,
  RecommendationType,
} from "@amazon-king/contracts";
import type { OptimizerConfig } from "../config.js";
import { parseIsoDateTime } from "../dates.js";
import type { EvidenceWindow, RecentChange, WindowMetrics } from "../types.js";

export type { EvidenceWindow, RecentChange, WindowMetrics };

/**
 * Shared, per-evaluation context handed to every rule. Carries the book's
 * economics (nullable — profit rules must not fire without them), the goal
 * mode, recent changes for cooldown suppression, and the injected clock so
 * rule output is fully deterministic for a given input.
 */
export interface RuleContext {
  config: OptimizerConfig;
  goalMode: GoalMode;
  /** Target ACoS (0–1 fraction) or null when economics are missing. */
  targetAcos: number | null;
  /** Estimated KDP royalty per attributed sale in micros, or null. */
  royaltyPerSaleMicros: number | null;
  currency: CurrencyCode;
  maxBidMicros: number | null;
  maxDailyBudgetMicros: number | null;
  recentChanges: RecentChange[];
  window: EvidenceWindow;
  /** Injected clock — rules never read the wall clock themselves. */
  now: IsoDateTime;
}

/**
 * A recommendation as produced by a rule, before persistence. `currentValue`
 * / `proposedValue` are string-encoded decimals (4 dp) or null when the
 * action has no scalar value (e.g. add-negative, diagnostics).
 * `evidenceInputs` holds the exact immutable metric/rule inputs so the
 * recommendation is reproducible (maps to recommendation_evidence.inputs).
 */
export interface RecommendationDraft {
  type: RecommendationType;
  profileId: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  targetId: string | null;
  searchTerm: string | null;
  currentValue: string | null;
  proposedValue: string | null;
  rationale: string;
  confidence: number;
  /** Absolute estimated economic impact in micros; drives ranking. */
  impactMicros: number;
  evidenceWindow: EvidenceWindow;
  ruleVersion: string;
  evidenceInputs: Record<string, unknown>;
  requiresHumanReview: boolean;
}

/** True when the KDP economics needed by profit rules are present. */
export function hasEconomics(ctx: RuleContext): boolean {
  return ctx.royaltyPerSaleMicros !== null && ctx.targetAcos !== null;
}

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

export function isProtectedSearchTerm(ctx: RuleContext, term: string): boolean {
  const normalized = normalizeTerm(term);
  return ctx.config.protectedSearchTerms.some(
    (protectedTerm) => normalizeTerm(protectedTerm) === normalized,
  );
}

export function isProtectedCampaign(
  ctx: RuleContext,
  campaignId: string | null,
): boolean {
  return (
    campaignId !== null && ctx.config.protectedCampaignIds.includes(campaignId)
  );
}

const MS_PER_DAY = 86_400_000;

/**
 * Cooldown suppression (docs/plan.md §9–§10): after a related write, rules
 * that would contradict it stay quiet for `cooldownDays`. A change "matches"
 * when every field set in `match` equals the change's field.
 */
export function isInCooldown(
  ctx: RuleContext,
  match: Partial<
    Pick<RecentChange, "actionType" | "targetId" | "campaignId" | "searchTerm">
  >,
): boolean {
  const cutoff =
    parseIsoDateTime(ctx.now) - ctx.config.cooldownDays * MS_PER_DAY;
  return ctx.recentChanges.some((change) => {
    if (parseIsoDateTime(change.changedAt) < cutoff) return false;
    return (Object.keys(match) as (keyof typeof match)[]).every(
      (key) => match[key] === undefined || change[key] === match[key],
    );
  });
}

/**
 * Confidence from evidence sufficiency: 0.5 at exactly the required
 * threshold, growing toward 1.0 as evidence reaches 2x the requirement.
 * Rules combine dimensions with `Math.min` (weakest link wins).
 */
export function evidenceConfidence(observed: number, required: number): number {
  if (required <= 0) return 1;
  return Math.min(1, observed / (2 * required));
}
