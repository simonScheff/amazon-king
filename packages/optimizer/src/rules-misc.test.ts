import { describe, expect, it } from "vitest";
import {
  evaluateBudgetConstrainedWinner,
  BUDGET_CONSTRAINED_WINNER_RULE_VERSION,
} from "./rules/budget-constrained-winner.js";
import {
  evaluateCannibalizationConflict,
  CANNIBALIZATION_CONFLICT_RULE_VERSION,
} from "./rules/cannibalization-conflict.js";
import {
  evaluateHighCtrPoorConversion,
  HIGH_CTR_POOR_CONVERSION_RULE_VERSION,
} from "./rules/high-ctr-poor-conversion.js";
import {
  evaluateLowImpressions,
  LOW_IMPRESSIONS_RULE_VERSION,
} from "./rules/low-impressions.js";
import {
  evaluatePlacementOpportunity,
  PLACEMENT_OPPORTUNITY_RULE_VERSION,
} from "./rules/placement-opportunity.js";
import {
  evaluateSearchTermHarvest,
  SEARCH_TERM_HARVEST_RULE_VERSION,
} from "./rules/search-term-harvest.js";
import { makeContext, makeMetrics } from "./testUtils.js";

describe("evaluateSearchTermHarvest", () => {
  const baseInput = {
    searchTerm: "spicy dragon romance",
    sourceCampaignId: "camp-auto",
    sourceTargetingType: "auto" as const,
    alreadyTargetedExactly: false,
    metrics: makeMetrics({ clicks: 40, orders: 3 }),
  };

  it("fires for a repeatedly converting term in auto targeting", () => {
    const draft = evaluateSearchTermHarvest(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(SEARCH_TERM_HARVEST_RULE_VERSION);
    expect(draft.requiresHumanReview).toBe(true);
    // Smoothed CVR = (3 + 1) / (40 + 20) = 0.0667; break-even CPC = 0.0667 x $4 = $0.2667
    expect(draft.proposedValue).toBe("0.2667");
  });

  it("fires in broad targeting but not in exact/manual targeting", () => {
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, sourceTargetingType: "broad" },
        makeContext(),
      ),
    ).not.toBeNull();
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, sourceTargetingType: "exact" },
        makeContext(),
      ),
    ).toBeNull();
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, sourceTargetingType: "phrase" },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("respects the minimum orders boundary", () => {
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, metrics: makeMetrics({ orders: 2 }) },
        makeContext(),
      ),
    ).not.toBeNull();
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, metrics: makeMetrics({ orders: 1 }) },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("skips terms already targeted exactly (duplicate/conflict avoidance)", () => {
    expect(
      evaluateSearchTermHarvest(
        { ...baseInput, alreadyTargetedExactly: true },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("proposes no starting bid without economics", () => {
    const draft = evaluateSearchTermHarvest(
      baseInput,
      makeContext({ royaltyPerSaleMicros: null }),
    )!;
    expect(draft).not.toBeNull();
    expect(draft.proposedValue).toBeNull();
  });

  it("still fires in launch mode (harvesting feeds discovery)", () => {
    expect(
      evaluateSearchTermHarvest(baseInput, makeContext({ goalMode: "launch" })),
    ).not.toBeNull();
  });
});

describe("evaluateBudgetConstrainedWinner", () => {
  const baseInput = {
    campaignId: "camp-1",
    dailyBudgetMicros: 10_000_000, // $10/day
    dailySpendMicros: [9_500_000, 9_200_000, 9_800_000, 5_000_000],
    metrics: makeMetrics({ orders: 20, costMicros: 60_000_000 }),
  };

  it("fires for a profitable campaign constrained on enough days", () => {
    const draft = evaluateBudgetConstrainedWinner(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(BUDGET_CONSTRAINED_WINNER_RULE_VERSION);
    expect(draft.currentValue).toBe("10.0000");
    expect(draft.proposedValue).toBe("12.0000"); // +20% default step
  });

  it("never infers profitability without economics", () => {
    expect(
      evaluateBudgetConstrainedWinner(
        baseInput,
        makeContext({ royaltyPerSaleMicros: null }),
      ),
    ).toBeNull();
  });

  it("does not fire when the campaign is not profitable", () => {
    expect(
      evaluateBudgetConstrainedWinner(
        {
          ...baseInput,
          metrics: makeMetrics({ orders: 10, costMicros: 60_000_000 }),
        },
        makeContext(),
      ),
    ).toBeNull(); // profit = 10 x 4 - 60 < 0
  });

  it("respects the constrained-days boundary", () => {
    const twoDays = evaluateBudgetConstrainedWinner(
      {
        ...baseInput,
        dailySpendMicros: [9_500_000, 9_200_000, 1_000_000, 1_000_000],
      },
      makeContext(),
    );
    expect(twoDays).toBeNull();
    const threeDays = evaluateBudgetConstrainedWinner(
      {
        ...baseInput,
        dailySpendMicros: [9_000_000, 9_500_000, 9_200_000, 1_000_000],
      },
      makeContext(),
    );
    expect(threeDays).not.toBeNull();
  });

  it("counts utilization at exactly 90% of budget as constrained", () => {
    const draft = evaluateBudgetConstrainedWinner(
      { ...baseInput, dailySpendMicros: [9_000_000, 9_000_000, 9_000_000] },
      makeContext(),
    );
    expect(draft).not.toBeNull();
  });

  it("caps the proposal at the max daily budget", () => {
    const draft = evaluateBudgetConstrainedWinner(
      baseInput,
      makeContext({ maxDailyBudgetMicros: 11_000_000 }),
    )!;
    expect(draft.proposedValue).toBe("11.0000");
  });

  it("does not fire when already at the budget ceiling", () => {
    expect(
      evaluateBudgetConstrainedWinner(
        baseInput,
        makeContext({ maxDailyBudgetMicros: 10_000_000 }),
      ),
    ).toBeNull();
  });

  it("never touches a protected campaign", () => {
    const ctx = makeContext({}, { protectedCampaignIds: ["camp-1"] });
    expect(evaluateBudgetConstrainedWinner(baseInput, ctx)).toBeNull();
  });
});

describe("evaluateHighCtrPoorConversion", () => {
  const baseInput = {
    campaignId: "camp-1",
    targetId: "t-1",
    metrics: makeMetrics({
      impressions: 2_000,
      clicks: 10,
      orders: 0,
      costMicros: 5_000_000,
    }),
  };

  it("fires on high CTR with CVR below the floor", () => {
    const draft = evaluateHighCtrPoorConversion(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(HIGH_CTR_POOR_CONVERSION_RULE_VERSION);
    expect(draft.proposedValue).toBeNull(); // diagnostic only
    expect(draft.requiresHumanReview).toBe(true);
    expect(draft.rationale).toContain("cannot fix the KDP listing");
  });

  it("respects the impressions boundary", () => {
    expect(
      evaluateHighCtrPoorConversion(
        {
          ...baseInput,
          metrics: makeMetrics({ impressions: 999, clicks: 5, orders: 0 }),
        },
        makeContext(),
      ),
    ).toBeNull();
    expect(
      evaluateHighCtrPoorConversion(
        {
          ...baseInput,
          metrics: makeMetrics({ impressions: 1_000, clicks: 5, orders: 0 }),
        },
        makeContext(),
      ),
    ).not.toBeNull();
  });

  it("respects the CTR boundary (0.3%)", () => {
    // CTR exactly 0.003 fires; one click less does not.
    expect(
      evaluateHighCtrPoorConversion(
        {
          ...baseInput,
          metrics: makeMetrics({ impressions: 1_000, clicks: 3, orders: 0 }),
        },
        makeContext(),
      ),
    ).not.toBeNull();
    expect(
      evaluateHighCtrPoorConversion(
        {
          ...baseInput,
          metrics: makeMetrics({ impressions: 1_000, clicks: 2, orders: 0 }),
        },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("does not fire when CVR is at or above the floor", () => {
    // 1 order / 200 clicks = 0.005 = floor -> no fire
    expect(
      evaluateHighCtrPoorConversion(
        {
          ...baseInput,
          metrics: makeMetrics({ impressions: 10_000, clicks: 200, orders: 1 }),
        },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("fires in launch mode too (diagnostic, not a spend action)", () => {
    expect(
      evaluateHighCtrPoorConversion(
        baseInput,
        makeContext({ goalMode: "launch" }),
      ),
    ).not.toBeNull();
  });
});

describe("evaluateLowImpressions", () => {
  const baseInput = {
    targetId: "t-1",
    campaignId: "camp-1",
    adGroupId: "ag-1",
    state: "enabled",
    currentBidMicros: 500_000,
    metrics: makeMetrics({ impressions: 42 }),
  };

  it("fires for an active target below the impressions threshold", () => {
    const draft = evaluateLowImpressions(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(LOW_IMPRESSIONS_RULE_VERSION);
    expect(draft.proposedValue).toBeNull(); // never raises bids automatically
    expect(draft.currentValue).toBe("0.5000");
  });

  it("respects the threshold boundary", () => {
    expect(
      evaluateLowImpressions(
        { ...baseInput, metrics: makeMetrics({ impressions: 99 }) },
        makeContext(),
      ),
    ).not.toBeNull();
    expect(
      evaluateLowImpressions(
        { ...baseInput, metrics: makeMetrics({ impressions: 100 }) },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("ignores paused or archived targets", () => {
    for (const state of ["paused", "archived"]) {
      expect(
        evaluateLowImpressions({ ...baseInput, state }, makeContext()),
      ).toBeNull();
    }
  });
});

describe("evaluatePlacementOpportunity", () => {
  const baseInput = {
    campaignId: "camp-1",
    placement: "PLACEMENT_TOP",
    currentModifierPct: 0,
    metrics: makeMetrics({
      clicks: 50,
      orders: 5,
      costMicros: 15_000_000,
      salesMicros: 100_000_000, // ACoS 0.15 <= 0.24; profit = 20 - 15 > 0
    }),
  };

  it("fires for a consistently profitable placement and proposes a capped step", () => {
    const draft = evaluatePlacementOpportunity(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(PLACEMENT_OPPORTUNITY_RULE_VERSION);
    expect(draft.currentValue).toBe("0.0000");
    expect(draft.proposedValue).toBe("0.1000"); // single +10% step
  });

  it("does not fire without economics", () => {
    expect(
      evaluatePlacementOpportunity(
        baseInput,
        makeContext({ targetAcos: null }),
      ),
    ).toBeNull();
    expect(
      evaluatePlacementOpportunity(
        baseInput,
        makeContext({ royaltyPerSaleMicros: null }),
      ),
    ).toBeNull();
  });

  it("respects the orders and clicks boundaries", () => {
    expect(
      evaluatePlacementOpportunity(
        { ...baseInput, metrics: makeMetrics({ clicks: 19, orders: 5 }) },
        makeContext(),
      ),
    ).toBeNull();
    expect(
      evaluatePlacementOpportunity(
        { ...baseInput, metrics: makeMetrics({ clicks: 50, orders: 1 }) },
        makeContext(),
      ),
    ).toBeNull();
    expect(
      evaluatePlacementOpportunity(
        {
          ...baseInput,
          metrics: makeMetrics({
            clicks: 20,
            orders: 2,
            costMicros: 5_000_000,
            salesMicros: 100_000_000,
          }),
        },
        makeContext(),
      ),
    ).not.toBeNull();
  });

  it("does not fire when ACoS is not safely below target", () => {
    expect(
      evaluatePlacementOpportunity(
        {
          ...baseInput,
          metrics: makeMetrics({
            clicks: 50,
            orders: 5,
            costMicros: 30_000_000,
            salesMicros: 100_000_000,
          }),
        },
        makeContext(),
      ),
    ).toBeNull(); // ACoS 0.30 > 0.24
  });

  it("never touches a protected campaign", () => {
    const ctx = makeContext({}, { protectedCampaignIds: ["camp-1"] });
    expect(evaluatePlacementOpportunity(baseInput, ctx)).toBeNull();
  });
});

describe("evaluateCannibalizationConflict", () => {
  const baseInput = {
    searchTerm: "dragon coloring book",
    campaigns: [
      { campaignId: "camp-1", orders: 3, costMicros: 10_000_000 },
      { campaignId: "camp-2", orders: 1, costMicros: 8_000_000 },
    ],
  };

  it("fires when the same term is targeted in two campaigns", () => {
    const draft = evaluateCannibalizationConflict(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.ruleVersion).toBe(CANNIBALIZATION_CONFLICT_RULE_VERSION);
    expect(draft.requiresHumanReview).toBe(true);
    expect(draft.impactMicros).toBe(18_000_000);
    expect(draft.confidence).toBe(0.5);
    expect(draft.rationale).toContain("camp-1");
    expect(draft.rationale).toContain("camp-2");
  });

  it("does not fire for a single campaign", () => {
    expect(
      evaluateCannibalizationConflict(
        { ...baseInput, campaigns: [baseInput.campaigns[0]!] },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("grows confidence with more overlapping campaigns", () => {
    const four = evaluateCannibalizationConflict(
      {
        ...baseInput,
        campaigns: [
          ...baseInput.campaigns,
          { campaignId: "camp-3", orders: 0, costMicros: 1_000_000 },
          { campaignId: "camp-4", orders: 0, costMicros: 1_000_000 },
        ],
      },
      makeContext(),
    )!;
    expect(four.confidence).toBe(1);
  });

  it("does not fire once a negative leaves only one competing campaign", () => {
    expect(
      evaluateCannibalizationConflict(
        {
          ...baseInput,
          campaigns: [
            baseInput.campaigns[0]!,
            { ...baseInput.campaigns[1]!, blockedByNegative: true },
          ],
        },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("excludes blocked campaigns from spend, rationale, and evidence", () => {
    const draft = evaluateCannibalizationConflict(
      {
        ...baseInput,
        campaigns: [
          ...baseInput.campaigns,
          { campaignId: "camp-3", orders: 0, costMicros: 5_000_000 },
          {
            campaignId: "camp-4",
            orders: 2,
            costMicros: 7_000_000,
            blockedByNegative: true,
          },
        ],
      },
      makeContext(),
    )!;
    expect(draft.impactMicros).toBe(23_000_000);
    expect(draft.rationale).toContain("3 campaigns");
    expect(draft.rationale).not.toContain("camp-4");
    expect(draft.evidenceInputs.excludedCampaigns).toEqual([
      {
        campaignId: "camp-4",
        orders: 2,
        costMicros: 7_000_000,
        blockedByNegative: true,
      },
    ]);
  });
});
