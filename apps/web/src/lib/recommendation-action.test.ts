import type { Recommendation } from "@amazon-king/contracts";
import { describe, expect, it } from "vitest";
import { getRecommendationActionDetails } from "./recommendation-action";

function recommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id: "rec-1",
    type: "cannibalization_conflict",
    state: "pending",
    priority: 1,
    profileId: "profile-1",
    campaignId: null,
    campaign: null,
    adGroupId: null,
    targetId: null,
    searchTerm: "tractor colouring book",
    currentValue: null,
    proposedValue: null,
    rationale: "Two campaigns overlap.",
    confidence: 0.5,
    evidenceWindow: { start: "2026-06-14", end: "2026-08-12" },
    dataFreshness: "2026-08-13T02:01:00.000Z",
    ruleVersion: "cannibalization_conflict@2",
    expiresAt: "2026-08-16T02:01:00.000Z",
    createdAt: "2026-08-13T02:01:00.000Z",
    ...overrides,
  };
}

describe("getRecommendationActionDetails", () => {
  it("explains that a cannibalization finding cannot change campaigns", () => {
    const details = getRecommendationActionDetails(recommendation());

    expect(details.actionable).toBe(false);
    expect(details.title).toBe("No automatic Amazon Ads action");
    expect(details.approvalEffect).toContain("no approval step");
    expect(details.exclusions).toEqual(
      expect.arrayContaining([
        "No campaign will be created.",
        "No campaign will be selected, paused, or closed.",
        "Nothing will be sent to Amazon from this finding.",
      ]),
    );
  });

  it("describes a bid recommendation as a draft before a separate apply", () => {
    const details = getRecommendationActionDetails(
      recommendation({
        type: "expensive_target",
        targetId: "target-7",
        currentValue: "0.5000",
        proposedValue: "0.4500",
      }),
    );

    expect(details.actionable).toBe(true);
    expect(details.summary).toContain(
      "Target target-7: change the bid from 0.5000 to 0.4500.",
    );
    expect(details.approvalEffect).toContain("does not contact Amazon");
    expect(details.nextStep).toContain("Apply to Amazon");
  });

  it("names the exact negative search-term operation", () => {
    const details = getRecommendationActionDetails(
      recommendation({
        type: "wasteful_search_term",
        campaignId: "campaign-3",
        searchTerm: "tractor colouring book",
      }),
    );

    expect(details.actionable).toBe(true);
    expect(details.summary).toBe(
      "Add “tractor colouring book” as a negative exact in campaign campaign-3.",
    );
    expect(details.exclusions).toContain(
      "No campaign will be created, paused, or closed.",
    );
  });
});
