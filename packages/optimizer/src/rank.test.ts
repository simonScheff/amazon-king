import { describe, expect, it } from "vitest";
import { rankRecommendations } from "./rank.js";
import type { RecommendationDraft } from "./rules/types.js";
import { TEST_WINDOW } from "./testUtils.js";

function draft(overrides: Partial<RecommendationDraft>): RecommendationDraft {
  return {
    type: "wasteful_search_term",
    profileId: null,
    campaignId: "camp-1",
    adGroupId: null,
    targetId: null,
    searchTerm: null,
    currentValue: null,
    proposedValue: null,
    rationale: "test",
    confidence: 0.5,
    impactMicros: 0,
    evidenceWindow: TEST_WINDOW,
    ruleVersion: "wasteful_search_term@1",
    evidenceInputs: {},
    requiresHumanReview: false,
    ...overrides,
  };
}

describe("rankRecommendations", () => {
  it("orders by economic impact, highest first", () => {
    const ranked = rankRecommendations([
      draft({ searchTerm: "low", impactMicros: 1_000_000 }),
      draft({ searchTerm: "high", impactMicros: 9_000_000 }),
      draft({ searchTerm: "mid", impactMicros: 5_000_000 }),
    ]);
    expect(ranked.map((r) => r.searchTerm)).toEqual(["high", "mid", "low"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("breaks impact ties by confidence", () => {
    const ranked = rankRecommendations([
      draft({ searchTerm: "unsure", impactMicros: 5_000_000, confidence: 0.5 }),
      draft({ searchTerm: "sure", impactMicros: 5_000_000, confidence: 0.9 }),
    ]);
    expect(ranked.map((r) => r.searchTerm)).toEqual(["sure", "unsure"]);
  });

  it("is fully deterministic for equal impact and confidence", () => {
    const input = [
      draft({ searchTerm: "b-term", impactMicros: 1 }),
      draft({ searchTerm: "a-term", impactMicros: 1 }),
      draft({ searchTerm: "c-term", impactMicros: 1 }),
    ];
    const first = rankRecommendations(input);
    const second = rankRecommendations([...input].reverse());
    expect(first.map((r) => r.searchTerm)).toEqual([
      "a-term",
      "b-term",
      "c-term",
    ]);
    expect(second.map((r) => r.searchTerm)).toEqual([
      "a-term",
      "b-term",
      "c-term",
    ]);
  });

  it("maps rank onto the 1-5 priority scale (top = 1)", () => {
    const ranked = rankRecommendations(
      Array.from({ length: 10 }, (_, i) =>
        draft({ searchTerm: `term-${i}`, impactMicros: 10 - i }),
      ),
    );
    expect(ranked[0]!.priority).toBe(1);
    expect(ranked[9]!.priority).toBe(5);
    for (const r of ranked) {
      expect(r.priority).toBeGreaterThanOrEqual(1);
      expect(r.priority).toBeLessThanOrEqual(5);
    }
  });

  it("assigns priority 1 to a single draft", () => {
    const ranked = rankRecommendations([draft({})]);
    expect(ranked[0]!.priority).toBe(1);
    expect(ranked[0]!.rank).toBe(1);
  });

  it("handles an empty batch", () => {
    expect(rankRecommendations([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [
      draft({ searchTerm: "a", impactMicros: 1 }),
      draft({ searchTerm: "b", impactMicros: 2 }),
    ];
    rankRecommendations(input);
    expect(input.map((d) => d.searchTerm)).toEqual(["a", "b"]);
  });
});
