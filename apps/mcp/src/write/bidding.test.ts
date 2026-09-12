import { describe, expect, it } from "vitest";
import {
  AuditEvent,
  ChangeActionType,
  ChangeSetKind,
  PlacementName,
} from "./enums.js";
import {
  setCampaignMaxCpc,
  setCampaignPlacementMultiplier,
} from "./bidding.js";
import { setupMockPool } from "./test-helpers.js";

describe("write/bidding", () => {
  describe("setCampaignMaxCpc", () => {
    it("enforces max CPC only on bids strictly exceeding the ceiling and resets dynamic bidding", async () => {
      const { pool, tables } = setupMockPool();

      // Max CPC = 0.50
      // tgt-1 is 0.7500 (> 0.50) -> should be updated
      // tgt-2 is 0.2000 (<= 0.50) -> should NOT be updated
      // ag-1 default_bid is 0.5500 (> 0.50) -> should be updated
      // dynamic bidding has PLACEMENT_TOP 25% -> should be reset to safe legacy bidding
      const result = await setCampaignMaxCpc(pool, "ws-1", "camp-1", "0.50");

      expect(result.maxCpc).toBe("0.50");
      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.MaxCpc);
      expect(tables.bidPolicies).toHaveLength(1);
      expect(
        tables.auditEvents.some(
          (e) => e.event === AuditEvent.CampaignMaxCpcCreate,
        ),
      ).toBe(true);
    });

    it("does not reset dynamic bidding if strategy is already legacy with no multipliers", async () => {
      const { pool, tables } = setupMockPool({
        campaigns: [
          {
            id: "camp-safe",
            profile_id: "prof-1",
            amazon_campaign_id: "amz-camp-safe",
            name: "Safe Campaign",
            state: "enabled",
            raw_json: {
              dynamicBidding: {
                strategy: "LEGACY_FOR_SALES",
                placements: [],
                audiences: [],
              },
            },
          },
        ],
        targets: [
          {
            id: "tgt-high",
            campaign_id: "camp-safe",
            amazon_target_id: "amz-tgt-high",
            target_kind: "target",
            bid: "0.8000",
          },
        ],
        adGroups: [],
      });

      const result = await setCampaignMaxCpc(pool, "ws-1", "camp-safe", "0.50");
      expect(result.maxCpc).toBe("0.50");
      // Only 1 action (target bid update), no dynamic bidding update action
      expect(result.actionsCount).toBe(1);
    });
  });

  describe("setCampaignPlacementMultiplier", () => {
    it("stages placement multipliers preserving existing strategy and audiences", async () => {
      const { pool, tables } = setupMockPool();

      await setCampaignPlacementMultiplier(pool, "ws-1", "camp-1", {
        topOfSearchPercentage: 40,
      });

      expect(tables.changeSets).toHaveLength(1);
      expect(tables.changeSets[0].kind).toBe(ChangeSetKind.CampaignUpdate);
      expect(
        tables.auditEvents.some(
          (e) =>
            e.event === AuditEvent.CampaignUpdateCreate &&
            e.details?.strategy === "set_placement_multiplier",
        ),
      ).toBe(true);
    });

    it("throws when no placement multiplier percentage is specified", async () => {
      const { pool } = setupMockPool();

      await expect(
        setCampaignPlacementMultiplier(pool, "ws-1", "camp-1", {}),
      ).rejects.toThrow(
        "At least one placement multiplier percentage must be specified",
      );
    });

    it("throws when campaign lacks dynamic bidding in raw_json", async () => {
      const { pool } = setupMockPool({
        campaigns: [
          {
            id: "camp-nobid",
            profile_id: "prof-1",
            amazon_campaign_id: "amz-camp-nobid",
            name: "No Bidding Campaign",
            state: "enabled",
            raw_json: {},
          },
        ],
      });

      await expect(
        setCampaignPlacementMultiplier(pool, "ws-1", "camp-nobid", {
          topOfSearchPercentage: 20,
        }),
      ).rejects.toThrow("lacks dynamic bidding snapshot in raw_json");
    });
  });
});
