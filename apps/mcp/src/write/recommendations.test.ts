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
    it("rejects recommendation, creates 30-day dismissal row, and records audit", async () => {
      const { pool, tables } = setupMockPool();

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
      expect(
        tables.auditEvents.some(
          (e) => e.event === AuditEvent.RecommendationReject,
        ),
      ).toBe(true);
    });

    it("throws when recommendation is not found in workspace", async () => {
      const { pool } = setupMockPool();

      await expect(
        rejectRecommendation(pool, "ws-1", "nonexistent-rec"),
      ).rejects.toThrow("Recommendation 'nonexistent-rec' not found");
    });
  });
});
