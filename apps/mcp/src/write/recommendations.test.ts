import { describe, expect, it } from "vitest";
import { AuditEvent, ChangeSetKind, RecommendationState } from "./enums.js";
import {
  createRecommendationChangeSet,
  rejectRecommendation,
} from "./recommendations.js";
import { setupMockPool } from "./test-helpers.js";

describe("write/recommendations", () => {
  describe("createRecommendationChangeSet", () => {
    it("stages recommendations into Change Center and transitions state to approved", async () => {
      const { pool, tables } = setupMockPool();

      const res = await createRecommendationChangeSet(pool, "ws-1", [
        "rec-1",
        "rec-1", // duplicate
        "rec-missing", // dropped
      ]);

      expect(res.requestedCount).toBe(2);
      expect(res.validCount).toBe(1);
      expect(res.droppedIds).toEqual(["rec-missing"]);
      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.Recommendation);
      expect(tables.recommendations.find((r) => r.id === "rec-1")!.state).toBe(
        RecommendationState.Approved,
      );

      // Verified domain audit logged
      expect(
        tables.auditEvents.some((e) => e.event === AuditEvent.ChangeSetCreate),
      ).toBe(true);
    });

    it("does not approve recommendations that produced no action and adds them to droppedIds", async () => {
      const { pool, tables } = setupMockPool({
        recommendations: [
          {
            id: "rec-valid",
            profile_id: "prof-1",
            type: "expensive_target",
            state: "pending",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: "camp-1",
            ad_group_id: "ag-1",
            target_id: "tgt-1",
            search_term: null,
            current_value: "0.7500",
            proposed_value: "0.4500",
          },
          {
            id: "rec-unsupported-type",
            profile_id: "prof-1",
            type: "search_term_harvest",
            state: "pending",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: "camp-1",
            ad_group_id: "ag-1",
            target_id: "tgt-1",
            search_term: "dragon books",
            current_value: null,
            proposed_value: null,
          },
        ],
      });

      const res = await createRecommendationChangeSet(pool, "ws-1", [
        "rec-valid",
        "rec-unsupported-type",
      ]);

      expect(res.validCount).toBe(1);
      expect(res.droppedIds).toContain("rec-unsupported-type");
      expect(
        tables.recommendations.find((r) => r.id === "rec-valid")!.state,
      ).toBe(RecommendationState.Approved);
      expect(
        tables.recommendations.find((r) => r.id === "rec-unsupported-type")!
          .state,
      ).toBe(RecommendationState.Pending);
    });

    it("drops advisory-only recommendations (e.g. budget_constrained_winner) into droppedIds", async () => {
      const { pool } = setupMockPool({
        recommendations: [
          {
            id: "rec-valid",
            profile_id: "prof-1",
            type: "expensive_target",
            state: "pending",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: "camp-1",
            ad_group_id: "ag-1",
            target_id: "tgt-1",
            search_term: null,
            current_value: "0.7500",
            proposed_value: "0.4500",
          },
          {
            id: "rec-budget",
            profile_id: "prof-1",
            type: "budget_constrained_winner",
            state: "pending",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: "camp-1",
            ad_group_id: "ag-1",
            target_id: "tgt-1",
            search_term: null,
            current_value: null,
            proposed_value: null,
          },
        ],
      });

      const res = await createRecommendationChangeSet(pool, "ws-1", [
        "rec-valid",
        "rec-budget",
      ]);

      expect(res.validCount).toBe(1);
      expect(res.droppedIds).toContain("rec-budget");
    });

    it("throws when no valid recommendations are provided", async () => {
      const { pool } = setupMockPool();

      await expect(
        createRecommendationChangeSet(pool, "ws-1", []),
      ).rejects.toThrow("No recommendation ids provided");

      await expect(
        createRecommendationChangeSet(pool, "ws-1", ["nonexistent-id"]),
      ).rejects.toThrow("No valid recommendations found for workspace");
    });
  });

  describe("rejectRecommendation", () => {
    it("rejects recommendation, creates 60-day dismissal row, and records audit", async () => {
      const { pool, tables } = setupMockPool();

      const before = Date.now();
      const result = await rejectRecommendation(
        pool,
        "ws-1",
        "rec-1",
        "Manual price adjustment already done",
      );

      expect(result.rejected).toBe(true);
      expect(result.reason).toBe("Manual price adjustment already done");
      expect(tables.recommendations.find((r) => r.id === "rec-1")!.state).toBe(
        RecommendationState.Rejected,
      );
      expect(tables.recommendationDismissals).toHaveLength(1);
      expect(tables.recommendationDismissals[0].type).toBe("expensive_target");

      // Verify 60-day suppression date
      const rawUntil =
        tables.recommendationDismissals[0].dismissed_until ??
        tables.recommendationDismissals[0].dismissedUntil;
      const dismissedUntil = new Date(rawUntil).getTime();
      const expectedMin = before + 59 * 86_400_000;
      const expectedMax = before + 61 * 86_400_000;
      expect(dismissedUntil).toBeGreaterThan(expectedMin);
      expect(dismissedUntil).toBeLessThan(expectedMax);

      expect(
        tables.auditEvents.some(
          (e) => e.event === AuditEvent.RecommendationReject,
        ),
      ).toBe(true);
    });

    it("throws when recommendation is not in pending or approved state", async () => {
      const { pool } = setupMockPool({
        recommendations: [
          {
            id: "rec-already-rejected",
            profile_id: "prof-1",
            type: "expensive_target",
            state: "rejected",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: null,
            ad_group_id: null,
            target_id: null,
            search_term: null,
            current_value: null,
            proposed_value: null,
          },
          {
            id: "rec-applied",
            profile_id: "prof-1",
            type: "expensive_target",
            state: "applied",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            campaign_id: null,
            ad_group_id: null,
            target_id: null,
            search_term: null,
            current_value: null,
            proposed_value: null,
          },
        ],
      });

      await expect(
        rejectRecommendation(pool, "ws-1", "rec-already-rejected"),
      ).rejects.toThrow(
        "Recommendation 'rec-already-rejected' in state 'rejected' cannot be rejected",
      );

      await expect(
        rejectRecommendation(pool, "ws-1", "rec-applied"),
      ).rejects.toThrow(
        "Recommendation 'rec-applied' in state 'applied' cannot be rejected",
      );
    });

    it("throws when recommendation is not found in workspace", async () => {
      const { pool } = setupMockPool();

      await expect(
        rejectRecommendation(pool, "ws-1", "nonexistent-rec"),
      ).rejects.toThrow("Recommendation 'nonexistent-rec' not found");
    });
  });
});
