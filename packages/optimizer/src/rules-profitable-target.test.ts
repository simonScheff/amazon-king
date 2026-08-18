import { describe, expect, it } from "vitest";
import {
  evaluateProfitableTarget,
  PROFITABLE_TARGET_RULE_VERSION,
} from "./rules/profitable-target.js";
import { makeContext, makeMetrics, TEST_NOW } from "./testUtils.js";

/**
 * ACoS 0.2 vs target 0.3 (raw multiplier 1.5, clamped to 1.15), smoothed
 * CVR 11/70 ≈ 0.157, royalty $4 → ceiling ≈ $0.63 > clamped bid $0.575.
 */
const baseInput = {
  targetId: "t-1",
  campaignId: "camp-1",
  adGroupId: "ag-1",
  currentBidMicros: 500_000, // $0.50
  metrics: makeMetrics({
    clicks: 50,
    orders: 10,
    costMicros: 20_000_000,
    salesMicros: 100_000_000,
  }),
};

describe("evaluateProfitableTarget", () => {
  it("fires and proposes a +15% clamped increase", () => {
    const draft = evaluateProfitableTarget(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.type).toBe("profitable_target");
    expect(draft.ruleVersion).toBe(PROFITABLE_TARGET_RULE_VERSION);
    expect(draft.currentValue).toBe("0.5000");
    expect(draft.proposedValue).toBe("0.5750"); // exactly +15%
    expect(draft.confidence).toBe(1);
  });

  it("caps the increase at the profit-ceiling CPC when it binds", () => {
    // Royalty $3.50 → ceiling = (11/70) x 3.5 = $0.55, between current and clamp.
    const draft = evaluateProfitableTarget(
      baseInput,
      makeContext({ royaltyPerSaleMicros: 3_500_000 }),
    )!;
    expect(draft.proposedValue).toBe("0.5500");
  });

  it("caps the increase at the configured max bid", () => {
    const draft = evaluateProfitableTarget(
      baseInput,
      makeContext({ maxBidMicros: 520_000 }),
    )!;
    expect(draft.proposedValue).toBe("0.5200");
  });

  it("does not fire when the max bid is already at or below the current bid", () => {
    expect(
      evaluateProfitableTarget(
        baseInput,
        makeContext({ maxBidMicros: 490_000 }),
      ),
    ).toBeNull();
  });

  it("does not fire without book economics", () => {
    expect(
      evaluateProfitableTarget(
        baseInput,
        makeContext({ royaltyPerSaleMicros: null }),
      ),
    ).toBeNull();
    expect(
      evaluateProfitableTarget(baseInput, makeContext({ targetAcos: null })),
    ).toBeNull();
  });

  it("requires at least the minimum orders (boundary)", () => {
    const below = evaluateProfitableTarget(
      {
        ...baseInput,
        currentBidMicros: 150_000,
        metrics: makeMetrics({
          clicks: 50,
          orders: 1,
          costMicros: 3_000_000,
          salesMicros: 100_000_000,
        }),
      },
      makeContext(),
    );
    expect(below).toBeNull();

    const at = evaluateProfitableTarget(
      {
        ...baseInput,
        currentBidMicros: 150_000,
        metrics: makeMetrics({
          clicks: 50,
          orders: 2,
          costMicros: 6_000_000,
          salesMicros: 100_000_000,
        }),
      },
      makeContext(),
    );
    expect(at).not.toBeNull();
  });

  it("requires ACoS safely below target (boundary at 0.8x)", () => {
    const atBoundary = evaluateProfitableTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 50,
          orders: 10,
          costMicros: 24_000_000,
          salesMicros: 100_000_000, // ACoS exactly 0.24 = 0.8 x 0.3
        }),
      },
      makeContext(),
    );
    expect(atBoundary).not.toBeNull();

    const above = evaluateProfitableTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 50,
          orders: 10,
          costMicros: 24_100_000,
          salesMicros: 100_000_000, // ACoS 0.241 > 0.24
        }),
      },
      makeContext(),
    );
    expect(above).toBeNull();
  });

  it("requires strictly positive estimated ad profit", () => {
    const draft = evaluateProfitableTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 50,
          orders: 5,
          costMicros: 20_000_000, // profit = 5 x 4 - 20 = 0
          salesMicros: 100_000_000,
        }),
      },
      makeContext(),
    );
    expect(draft).toBeNull();
  });

  it("earns a royalty per copy, not per order", () => {
    // 10 orders shipping 16 copies at $4 royalty against $20 spend: valuing
    // orders reports $20 of profit, valuing copies the real $44.
    const metrics = makeMetrics({
      clicks: 50,
      orders: 10,
      units: 16,
      costMicros: 20_000_000,
      salesMicros: 100_000_000,
    });
    const draft = evaluateProfitableTarget(
      { ...baseInput, metrics },
      makeContext(),
    )!;
    expect(draft).not.toBeNull();
    expect(draft.impactMicros).toBe(44_000_000);
    expect(draft.evidenceInputs).toMatchObject({
      orders: 10,
      units: 16,
      royaltyCopies: 16,
      profitMicros: 44_000_000,
    });
  });

  it("never proposes a bid change on a protected campaign", () => {
    const ctx = makeContext({}, { protectedCampaignIds: ["camp-1"] });
    expect(evaluateProfitableTarget(baseInput, ctx)).toBeNull();
  });

  it("is suppressed during the cooldown after a bid change on the target", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "update_bid",
          targetId: "t-1",
          campaignId: null,
          searchTerm: null,
          changedAt: TEST_NOW,
        },
      ],
    });
    expect(evaluateProfitableTarget(baseInput, ctx)).toBeNull();
  });

  it("still fires in launch mode (only down-bids and negatives are suppressed)", () => {
    expect(
      evaluateProfitableTarget(baseInput, makeContext({ goalMode: "launch" })),
    ).not.toBeNull();
  });

  it("respects the minimum clicks boundary", () => {
    expect(
      evaluateProfitableTarget(
        {
          ...baseInput,
          metrics: makeMetrics({
            clicks: 9,
            orders: 10,
            costMicros: 20_000_000,
            salesMicros: 100_000_000,
          }),
        },
        makeContext(),
      ),
    ).toBeNull();
  });

  it("is deterministic for identical inputs", () => {
    expect(evaluateProfitableTarget(baseInput, makeContext())).toEqual(
      evaluateProfitableTarget(baseInput, makeContext()),
    );
  });
});
