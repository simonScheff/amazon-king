import { describe, expect, it } from "vitest";
import { AuditEvent, ChangeSetKind } from "./enums.js";
import {
  createCampaignNegativesChangeSet,
  createSearchTermExclusion,
} from "./negatives.js";
import { setupMockPool } from "./test-helpers.js";

describe("write/negatives", () => {
  describe("createCampaignNegativesChangeSet", () => {
    it("stages campaign negatives with clicks check and records audit", async () => {
      const { pool, tables } = setupMockPool();

      const created = (await createCampaignNegativesChangeSet(
        pool,
        "ws-1",
        "camp-1",
        ["sci-fi books", "sci-fi books", "B012345678"],
      )) as { changeSet: { id: string } };

      expect(created.changeSet).toBeDefined();
      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.Recommendation);
      expect(
        tables.auditEvents.some(
          (e) => e.event === AuditEvent.CampaignNegativesCreate,
        ),
      ).toBe(true);
    });

    it("throws when no terms are provided or all are empty", async () => {
      const { pool } = setupMockPool();

      await expect(
        createCampaignNegativesChangeSet(pool, "ws-1", "camp-1", []),
      ).rejects.toThrow("No search terms provided");

      await expect(
        createCampaignNegativesChangeSet(pool, "ws-1", "camp-1", ["   "]),
      ).rejects.toThrow("No search terms provided");
    });
  });

  describe("createSearchTermExclusion", () => {
    it("stages persistent search term exclusion across serving campaigns", async () => {
      const { pool, tables } = setupMockPool();

      const result = await createSearchTermExclusion(
        pool,
        "ws-1",
        "  sci-fi books  ",
      );

      expect(result.searchTerm).toBe("sci-fi books");
      expect(result.exclusionAdded).toBe(true);
      expect(tables.searchTermExclusions).toHaveLength(1);
      expect(tables.changeSets).toHaveLength(1);
      expect(
        tables.auditEvents.some(
          (e) => e.event === AuditEvent.SearchTermExclusionCreate,
        ),
      ).toBe(true);
    });

    it("skips campaigns already blocking the search term", async () => {
      const { pool, tables } = setupMockPool({
        negativeKeywords: [
          {
            id: "nk-1",
            campaign_id: "camp-1",
            keyword_text: "sci-fi books",
            state: "ENABLED",
          },
        ],
      });

      const result = await createSearchTermExclusion(
        pool,
        "ws-1",
        "sci-fi books",
      );

      expect(result.exclusionAdded).toBe(true);
      expect(tables.searchTermExclusions).toHaveLength(1);
      // Since camp-1 already blocks it, no change set is drafted
      expect(tables.changeSets).toHaveLength(0);
      expect(result.changeSets).toHaveLength(0);
    });
  });
});
