import { describe, expect, it } from "vitest";
import {
  evaluateExpensiveTarget,
  EXPENSIVE_TARGET_RULE_VERSION,
} from "./rules/expensive-target.js";
import { makeContext, makeMetrics, TEST_NOW } from "./testUtils.js";

/** ACoS 2.0 vs target 0.3, negative profit — clearly expensive. */
const baseInput = {
  targetId: "t-1",
  campaignId: "camp-1",
  adGroupId: "ag-1",
  currentBidMicros: 1_000_000, // $1.00
  metrics: makeMetrics({
    clicks: 100,
    orders: 2,
    costMicros: 40_000_000,
    salesMicros: 20_000_000,
  }),
};

describe("evaluateExpensiveTarget", () => {
  it("fires on ACoS materially above target and proposes a clamped decrease", () => {
    const draft = evaluateExpensiveTarget(baseInput, makeContext())!;
    expect(draft).not.toBeNull();
    expect(draft.type).toBe("expensive_target");
    expect(draft.ruleVersion).toBe(EXPENSIVE_TARGET_RULE_VERSION);
    expect(draft.currentValue).toBe("1.0000");
    // Break-even CPC sits far below the clamped bid, so the proposal is
    // exactly the -15% per-cooldown floor.
    expect(draft.proposedValue).toBe("0.8500");
  });

  it("fires at exactly 1.2x target ACoS", () => {
    const draft = evaluateExpensiveTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 100,
          orders: 10,
          costMicros: 36_000_000,
          salesMicros: 100_000_000, // ACoS exactly 0.36 = 1.2 x 0.3
        }),
      },
      makeContext(),
    );
    expect(draft).not.toBeNull();
  });

  it("does not fire one tick below 1.2x target ACoS when profit is positive", () => {
    const draft = evaluateExpensiveTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 100,
          orders: 10,
          costMicros: 35_900_000,
          salesMicros: 100_000_000, // ACoS 0.359 < 0.36; profit = 40 - 35.9 > 0
        }),
      },
      makeContext(),
    );
    expect(draft).toBeNull();
  });

  it("fires on negative estimated ad profit even below the ACoS multiplier", () => {
    const draft = evaluateExpensiveTarget(
      {
        ...baseInput,
        metrics: makeMetrics({
          clicks: 100,
          orders: 2,
          costMicros: 20_000_000,
          salesMicros: 100_000_000, // ACoS 0.20 (fine) but profit = 8 - 20 < 0
        }),
      },
      makeContext(),
    );
    expect(draft).not.toBeNull();
    expect(draft!.proposedValue).toBe("0.8500");
  });

  it("is suppressed in launch/discovery mode", () => {
    expect(
      evaluateExpensiveTarget(baseInput, makeContext({ goalMode: "launch" })),
    ).toBeNull();
  });

  it("does not fire without book economics (disabled, not guessed)", () => {
    expect(
      evaluateExpensiveTarget(
        baseInput,
        makeContext({ royaltyPerSaleMicros: null }),
      ),
    ).toBeNull();
    expect(
      evaluateExpensiveTarget(baseInput, makeContext({ targetAcos: null })),
    ).toBeNull();
  });

  it("never proposes a bid change on a protected campaign", () => {
    const ctx = makeContext({}, { protectedCampaignIds: ["camp-1"] });
    expect(evaluateExpensiveTarget(baseInput, ctx)).toBeNull();
  });

  it("is suppressed during the cooldown after a bid change on the target", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "update_bid",
          targetId: "t-1",
          campaignId: null,
          searchTerm: null,
          changedAt: "2026-02-14T00:00:00.000Z",
        },
      ],
    });
    expect(evaluateExpensiveTarget(baseInput, ctx)).toBeNull();
  });

  it("ignores cooldowns of other targets", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "update_bid",
          targetId: "t-other",
          campaignId: null,
          searchTerm: null,
          changedAt: TEST_NOW,
        },
      ],
    });
    expect(evaluateExpensiveTarget(baseInput, ctx)).not.toBeNull();
  });

  it("respects the minimum clicks boundary", () => {
    const below = evaluateExpensiveTarget(
      { ...baseInput, metrics: makeMetrics({ clicks: 9, orders: 2 }) },
      makeContext(),
    );
    expect(below).toBeNull();
    const at = evaluateExpensiveTarget(
      { ...baseInput, metrics: makeMetrics({ clicks: 10, orders: 2 }) },
      makeContext(),
    );
    expect(at).not.toBeNull();
  });

  it("requires at least one order", () => {
    const draft = evaluateExpensiveTarget(
      { ...baseInput, metrics: makeMetrics({ clicks: 100, orders: 0 }) },
      makeContext(),
    );
    expect(draft).toBeNull();
  });

  it("is deterministic for identical inputs", () => {
    const a = evaluateExpensiveTarget(baseInput, makeContext());
    const b = evaluateExpensiveTarget(baseInput, makeContext());
    expect(a).toEqual(b);
  });

  it("records exact evidence inputs including the clamp floor", () => {
    const draft = evaluateExpensiveTarget(baseInput, makeContext())!;
    expect(draft.evidenceInputs).toMatchObject({
      targetId: "t-1",
      currentBidMicros: 1_000_000,
      clampedMultiplier: 0.85,
      floorMicros: 850_000,
      finalBidMicros: 850_000,
      ruleVersion: EXPENSIVE_TARGET_RULE_VERSION,
    });
  });
});
