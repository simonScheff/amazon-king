/**
 * Central, typed configuration for every optimizer threshold. All rule
 * evidence thresholds, smoothing priors, bid clamps, cooldowns, and
 * protected-entity lists live here so a deployment (or a test) can tune
 * behavior without touching rule code. `DEFAULT_OPTIMIZER_CONFIG` encodes
 * the defaults from docs/plan.md §9–§10.
 */
export interface OptimizerConfig {
  /** Days after a related change during which contradictory rules stay quiet. */
  cooldownDays: number;
  /** Evidence older than this many days is stale (used by guardrails). */
  stalenessDays: number;
  /** Beta-style conversion-rate smoothing prior. */
  smoothing: { priorRate: number; priorWeight: number };
  /** Per-cooldown bid multiplier clamp (plan: 10–15%). */
  bidClamp: { min: number; max: number };
  /** Bid changes smaller than this relative delta are rejected as noise. */
  minBidRelativeChange: number;
  /** Negative-exact candidate: clicks with zero orders (Amazon guidance ~20). */
  wastefulSearchTerm: { minClicks: number };
  /** Bid-down rule: ACoS materially above target with real evidence. */
  expensiveTarget: {
    minClicks: number;
    minOrders: number;
    acosMultiplier: number;
  };
  /** Bid-up rule: proven profit, ACoS safely below target. */
  profitableTarget: {
    minClicks: number;
    minOrders: number;
    acosMultiplier: number;
  };
  /** Harvest a repeatedly converting shopper term from auto/broad targeting. */
  searchTermHarvest: { minOrders: number };
  /** Profitable campaign that keeps hitting its daily budget. */
  budgetConstrainedWinner: {
    minUtilization: number;
    minConstrainedDays: number;
    increasePct: number;
  };
  /** Diagnostic: ad attracts clicks but the book does not sell. */
  highCtrPoorConversion: {
    minCtr: number;
    minImpressions: number;
    maxCvr: number;
  };
  /** Diagnostic: active target receives almost no traffic over the window. */
  lowImpressions: { maxImpressions: number };
  /** Placement consistently profitable with enough volume. */
  placementOpportunity: {
    minClicks: number;
    minOrders: number;
    acosMultiplier: number;
    adjustPct: number;
  };
  /** Same shopper term targeted across overlapping campaigns. */
  cannibalizationConflict: { minCampaigns: number };
  /** Lower-cased search terms the optimizer may never negative. */
  protectedSearchTerms: string[];
  /** Campaigns the optimizer may never change bids/budgets on. */
  protectedCampaignIds: string[];
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  cooldownDays: 7,
  stalenessDays: 3,
  smoothing: { priorRate: 0.05, priorWeight: 20 },
  bidClamp: { min: 0.85, max: 1.15 },
  minBidRelativeChange: 0.01,
  wastefulSearchTerm: { minClicks: 20 },
  expensiveTarget: { minClicks: 10, minOrders: 1, acosMultiplier: 1.2 },
  profitableTarget: { minClicks: 10, minOrders: 2, acosMultiplier: 0.8 },
  searchTermHarvest: { minOrders: 2 },
  budgetConstrainedWinner: {
    minUtilization: 0.9,
    minConstrainedDays: 3,
    increasePct: 0.2,
  },
  highCtrPoorConversion: { minCtr: 0.003, minImpressions: 1000, maxCvr: 0.005 },
  lowImpressions: { maxImpressions: 100 },
  placementOpportunity: {
    minClicks: 20,
    minOrders: 2,
    acosMultiplier: 0.8,
    adjustPct: 0.1,
  },
  cannibalizationConflict: { minCampaigns: 2 },
  protectedSearchTerms: [],
  protectedCampaignIds: [],
};

/** Per-section partial overrides; scalar and array fields replace wholesale. */
export type OptimizerConfigOverrides = {
  [K in keyof OptimizerConfig]?: OptimizerConfig[K] extends readonly unknown[]
    ? OptimizerConfig[K]
    : OptimizerConfig[K] extends object
      ? Partial<OptimizerConfig[K]>
      : OptimizerConfig[K];
};

/** Merge overrides over the defaults (one nesting level deep). */
export function resolveOptimizerConfig(
  overrides: OptimizerConfigOverrides = {},
): OptimizerConfig {
  const result = { ...DEFAULT_OPTIMIZER_CONFIG } as OptimizerConfig;
  const mutable = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(overrides) as (keyof OptimizerConfig)[]) {
    const override = overrides[key];
    if (override === undefined) continue;
    const base = result[key];
    if (
      typeof base === "object" &&
      base !== null &&
      !Array.isArray(base) &&
      typeof override === "object" &&
      !Array.isArray(override)
    ) {
      mutable[key] = { ...base, ...override };
    } else {
      mutable[key] = override;
    }
  }
  return result;
}
