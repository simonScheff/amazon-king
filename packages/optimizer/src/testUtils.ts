import type { IsoDate, IsoDateTime } from "@amazon-king/contracts";
import {
  DEFAULT_OPTIMIZER_CONFIG,
  resolveOptimizerConfig,
  type OptimizerConfigOverrides,
} from "./config.js";
import type { RuleContext } from "./rules/types.js";
import type { WindowMetrics } from "./types.js";

/** Fixed clock for deterministic tests. */
export const TEST_NOW: IsoDateTime = "2026-02-15T12:00:00.000Z";
export const TEST_WINDOW = {
  start: "2026-02-02" as IsoDate,
  end: "2026-02-15" as IsoDate,
};

export function makeContext(
  overrides: Partial<RuleContext> = {},
  configOverrides: OptimizerConfigOverrides = {},
): RuleContext {
  return {
    config: resolveOptimizerConfig(configOverrides),
    goalMode: "profit",
    targetAcos: 0.3,
    royaltyPerSaleMicros: 4_000_000, // $4.00 royalty per sale
    currency: "USD",
    maxBidMicros: 5_000_000,
    maxDailyBudgetMicros: 100_000_000,
    recentChanges: [],
    window: TEST_WINDOW,
    now: TEST_NOW,
    ...overrides,
  };
}

export function makeMetrics(
  overrides: Partial<WindowMetrics> = {},
): WindowMetrics {
  return {
    impressions: 5_000,
    clicks: 100,
    orders: 10,
    costMicros: 20_000_000, // $20
    salesMicros: 80_000_000, // $80
    ...overrides,
  };
}

export { DEFAULT_OPTIMIZER_CONFIG };
