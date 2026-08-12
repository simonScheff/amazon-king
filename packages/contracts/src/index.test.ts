import { describe, expect, it } from "vitest";
import { recommendationSchema, sessionInfoSchema } from "./index.js";

describe("contracts smoke test", () => {
  it("round-trips a SessionInfo payload", () => {
    const payload = {
      userId: "usr_1",
      workspaceId: "wsp_1",
      email: "owner@example.com",
      expiresAt: "2026-08-06T20:00:00Z",
      csrfToken: "csrf-token-123",
    };
    const parsed = sessionInfoSchema.parse(payload);
    expect(sessionInfoSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it("accepts a valid Recommendation with string-encoded decimals", () => {
    const parsed = recommendationSchema.parse({
      id: "rec_1",
      type: "wasteful_search_term",
      state: "pending",
      priority: 2,
      profileId: "prf_1",
      campaignId: "cmp_1",
      adGroupId: null,
      targetId: null,
      searchTerm: "dragon coloring book",
      currentValue: "0.45",
      proposedValue: null,
      rationale: "34 clicks, $15.30 spend, zero orders in the evidence window.",
      confidence: 0.82,
      evidenceWindow: { start: "2026-07-01", end: "2026-07-31" },
      dataFreshness: "2026-08-05T00:00:00Z",
      ruleVersion: "wasteful_search_term.v1",
      expiresAt: "2026-08-12T00:00:00Z",
      createdAt: "2026-08-05T12:00:00Z",
    });
    expect(parsed.currentValue).toBe("0.45");
  });

  it("rejects a float-style money payload with too many decimals", () => {
    expect(() =>
      sessionInfoSchema.parse({
        userId: "u",
        workspaceId: "w",
        email: "not-an-email",
        expiresAt: "x",
        csrfToken: "c",
      }),
    ).toThrow();
  });
});
