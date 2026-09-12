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
      expect(tables.changeSets[0].metadata.campaignPk).toBe("camp-1");
      expect(
        tables.auditEvents.some(
          (e) =>
            e.event === AuditEvent.CampaignUpdateCreate &&
            e.details?.state === "PAUSED",
        ),
      ).toBe(true);
    });

    it("throws when campaign is already in the requested state", async () => {
      const { pool } = setupMockPool();

      // camp-1 is enabled by default in fixture
      await expect(
        updateCampaignState(pool, "ws-1", "camp-1", "enabled"),
      ).rejects.toThrow("Campaign 'Space Novel Promo' is already enabled");
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
      expect(tables.changeSets[0].metadata.campaignPk).toBe("camp-1");
      expect(
        tables.auditEvents.some(
          (e) =>
            e.event === AuditEvent.CampaignUpdateCreate &&
            e.details?.strategy === "add_keywords",
        ),
      ).toBe(true);
    });

    it("throws when targeting_type is AUTO", async () => {
      const { pool } = setupMockPool({
        campaigns: [
          {
            id: "camp-auto",
            profile_id: "prof-1",
            amazon_campaign_id: "amz-camp-auto",
            name: "Auto Campaign",
            state: "enabled",
            targeting_type: "AUTO",
          },
        ],
      });

      await expect(
        addKeywordsToCampaign(pool, "ws-1", "camp-auto", [
          { keywordText: "space opera" },
        ]),
      ).rejects.toThrow(
        "Cannot add keywords to campaign 'Auto Campaign': AUTO targeting campaigns do not support manual keywords",
      );
    });

    it("deduplicates duplicate keywords in the same batch", async () => {
      const { pool, tables } = setupMockPool();

      await addKeywordsToCampaign(pool, "ws-1", "camp-1", [
        { keywordText: "space opera", matchType: "EXACT" },
        { keywordText: "  space opera  ", matchType: "EXACT" },
        { keywordText: "space opera", matchType: "BROAD" },
      ]);

      expect(tables.changeActions).toHaveLength(2);
    });

    it("throws when keywords array is empty or has only empty strings", async () => {
      const { pool } = setupMockPool();

      await expect(
        addKeywordsToCampaign(pool, "ws-1", "camp-1", []),
      ).rejects.toThrow("No keywords provided");

      await expect(
        addKeywordsToCampaign(pool, "ws-1", "camp-1", [{ keywordText: "   " }]),
      ).rejects.toThrow("Keyword text cannot be empty");
    });
  });
});
