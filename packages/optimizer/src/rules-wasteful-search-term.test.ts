import { describe, expect, it } from "vitest";
import {
  evaluateWastefulSearchTerm,
  WASTEFUL_SEARCH_TERM_RULE_VERSION,
} from "./rules/wasteful-search-term.js";
import { makeContext, makeMetrics, TEST_NOW } from "./testUtils.js";

const baseInput = {
  searchTerm: "dragon coloring book",
  campaignId: "camp-1",
  metrics: makeMetrics({ clicks: 25, orders: 0, costMicros: 12_000_000 }),
};

describe("evaluateWastefulSearchTerm", () => {
  it("fires at exactly the click threshold with zero orders", () => {
    const ctx = makeContext();
    const draft = evaluateWastefulSearchTerm(
      { ...baseInput, metrics: makeMetrics({ clicks: 20, orders: 0 }) },
      ctx,
    );
    expect(draft).not.toBeNull();
    expect(draft!.type).toBe("wasteful_search_term");
    expect(draft!.ruleVersion).toBe(WASTEFUL_SEARCH_TERM_RULE_VERSION);
    expect(draft!.confidence).toBe(0.5); // exactly at threshold
    expect(draft!.impactMicros).toBe(20_000_000); // makeMetrics default cost
  });

  it("does not fire one click below the threshold", () => {
    const draft = evaluateWastefulSearchTerm(
      { ...baseInput, metrics: makeMetrics({ clicks: 19, orders: 0 }) },
      makeContext(),
    );
    expect(draft).toBeNull();
  });

  it("does not fire once the term has an order", () => {
    const draft = evaluateWastefulSearchTerm(
      { ...baseInput, metrics: makeMetrics({ clicks: 40, orders: 1 }) },
      makeContext(),
    );
    expect(draft).toBeNull();
  });

  it("is suppressed in launch/discovery mode", () => {
    const draft = evaluateWastefulSearchTerm(
      baseInput,
      makeContext({ goalMode: "launch" }),
    );
    expect(draft).toBeNull();
  });

  it("still fires in balanced and visibility modes", () => {
    for (const goalMode of ["balanced", "visibility", "profit"] as const) {
      expect(
        evaluateWastefulSearchTerm(baseInput, makeContext({ goalMode })),
      ).not.toBeNull();
    }
  });

  it("never negatives a protected term (case/space-insensitive)", () => {
    const ctx = makeContext(
      {},
      { protectedSearchTerms: ["  Dragon Coloring Book "] },
    );
    expect(evaluateWastefulSearchTerm(baseInput, ctx)).toBeNull();
  });

  it("is suppressed during the cooldown after a negative was added", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "add_negative_exact",
          targetId: null,
          campaignId: null,
          searchTerm: "dragon coloring book",
          changedAt: "2026-02-14T00:00:00.000Z",
        },
      ],
    });
    expect(evaluateWastefulSearchTerm(baseInput, ctx)).toBeNull();
  });

  it("fires again once the cooldown has passed", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "add_negative_exact",
          targetId: null,
          campaignId: null,
          searchTerm: "dragon coloring book",
          changedAt: "2026-02-01T00:00:00.000Z", // 14 days before TEST_NOW
        },
      ],
    });
    expect(evaluateWastefulSearchTerm(baseInput, ctx)).not.toBeNull();
  });

  it("does not confuse cooldowns of other terms or action types", () => {
    const ctx = makeContext({
      recentChanges: [
        {
          actionType: "add_negative_exact",
          targetId: null,
          campaignId: null,
          searchTerm: "unrelated term",
          changedAt: TEST_NOW,
        },
        {
          actionType: "update_bid",
          targetId: "t-1",
          campaignId: null,
          searchTerm: null,
          changedAt: TEST_NOW,
        },
      ],
    });
    expect(evaluateWastefulSearchTerm(baseInput, ctx)).not.toBeNull();
  });

  it("grows confidence with evidence beyond the threshold", () => {
    const atThreshold = evaluateWastefulSearchTerm(
      { ...baseInput, metrics: makeMetrics({ clicks: 20, orders: 0 }) },
      makeContext(),
    )!;
    const double = evaluateWastefulSearchTerm(
      { ...baseInput, metrics: makeMetrics({ clicks: 40, orders: 0 }) },
      makeContext(),
    )!;
    expect(atThreshold.confidence).toBe(0.5);
    expect(double.confidence).toBe(1);
  });

  it("records exact evidence inputs for reproducibility", () => {
    const draft = evaluateWastefulSearchTerm(baseInput, makeContext())!;
    expect(draft.evidenceInputs).toMatchObject({
      searchTerm: "dragon coloring book",
      clicks: 25,
      orders: 0,
      costMicros: 12_000_000,
      minClicks: 20,
      ruleVersion: WASTEFUL_SEARCH_TERM_RULE_VERSION,
    });
  });

  it("is deterministic for identical inputs", () => {
    const a = evaluateWastefulSearchTerm(baseInput, makeContext());
    const b = evaluateWastefulSearchTerm(baseInput, makeContext());
    expect(a).toEqual(b);
  });
});
