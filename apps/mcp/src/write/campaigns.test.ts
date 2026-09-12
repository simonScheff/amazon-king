import { describe, expect, it } from "vitest";
import { AuditEvent, ChangeSetKind } from "./enums.js";
import { addKeywordsToCampaign, updateCampaignState } from "./campaigns.js";
import { setupMockPool } from "./test-helpers.js";

describe("write/campaigns", () => {
  describe("updateCampaignState", () => {
    it("stages campaign state change into Change Center and records audit", async () => {
      const { pool, tables } = setupMockPool();

      const created = (await updateCampaignState(
        pool,
        "ws-1",
        "camp-1",
        "paused",
      )) as { changeSet: { id: string } };

      expect(created.changeSet).toBeDefined();
      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.CampaignUpdate);
      expect(tables.changeSets[0].metadata.state).toBe("PAUSED");
      expect(
        tables.auditEvents.some(
          (e) =>
            e.event === AuditEvent.CampaignUpdateCreate &&
            e.details?.state === "PAUSED",
        ),
      ).toBe(true);
    });
  });

  describe("addKeywordsToCampaign", () => {
    it("stages keyword creation actions with ad group resolution and records audit", async () => {
      const { pool, tables } = setupMockPool();

      const created = (await addKeywordsToCampaign(pool, "ws-1", "camp-1", [
        { keywordText: "space opera", bid: "0.45" },
        { keywordText: "sci fi adventure", matchType: "PHRASE" },
      ])) as { changeSet: { id: string } };

      expect(created.changeSet).toBeDefined();
      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.CampaignUpdate);
      expect(tables.changeSets[0].metadata.strategy).toBe("add_keywords");
      expect(
        tables.auditEvents.some(
          (e) =>
            e.event === AuditEvent.CampaignUpdateCreate &&
            e.details?.strategy === "add_keywords",
        ),
      ).toBe(true);
    });

    it("throws when keywords array is empty", async () => {
      const { pool } = setupMockPool();

      await expect(
        addKeywordsToCampaign(pool, "ws-1", "camp-1", []),
      ).rejects.toThrow("No keywords provided");
    });
  });
});
