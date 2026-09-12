import { describe, expect, it } from "vitest";
import {
  getOwnerUserId,
  requireCampaign,
  resolveAdGroupId,
  resolveCampaign,
} from "./common.js";
import { setupMockPool } from "./test-helpers.js";

describe("write/common", () => {
  it("resolves owner user id and fails closed when workspace has no owner", async () => {
    const { pool, tables } = setupMockPool();

    const ownerId = await getOwnerUserId(pool, "ws-1");
    expect(ownerId).toBe("user-owner-1");

    tables.workspaceMembers = [];
    await expect(getOwnerUserId(pool, "ws-1")).rejects.toThrow(
      "Workspace 'ws-1' has no owner",
    );
  });

  it("resolves campaign by internal id and amazon campaign id", async () => {
    const { pool } = setupMockPool();

    const byInternal = await resolveCampaign(pool, "ws-1", "camp-1");
    expect(byInternal?.name).toBe("Space Novel Promo");

    const byAmazon = await resolveCampaign(pool, "ws-1", "amz-camp-1");
    expect(byAmazon?.name).toBe("Space Novel Promo");

    const missing = await resolveCampaign(pool, "ws-1", "nonexistent");
    expect(missing).toBeNull();
  });

  it("requireCampaign throws when campaign is not found", async () => {
    const { pool } = setupMockPool();

    await expect(requireCampaign(pool, "ws-1", "missing-camp")).rejects.toThrow(
      "Campaign 'missing-camp' not found in workspace",
    );
  });

  it("requireCampaign throws when profile is read-only", async () => {
    const { pool } = setupMockPool({
      amazonProfiles: [
        {
          id: "prof-1",
          connection_id: "conn-1",
          enabled: true,
          write_enabled: false,
        },
      ],
    });

    await expect(requireCampaign(pool, "ws-1", "camp-1")).rejects.toThrow(
      "Profile is read-only; enable writes before creating change sets",
    );
  });

  it("requireCampaign throws when campaign is archived on Amazon", async () => {
    const { pool } = setupMockPool({
      campaigns: [
        {
          id: "camp-archived",
          profile_id: "prof-1",
          amazon_campaign_id: "amz-camp-archived",
          name: "Old Archived Novel",
          state: "archived",
        },
      ],
    });

    await expect(
      requireCampaign(pool, "ws-1", "camp-archived"),
    ).rejects.toThrow(
      "Campaign 'Old Archived Novel' is archived on Amazon and cannot be modified",
    );
  });

  it("resolves ad group id by id or falls back to first non-archived ad group in campaign", async () => {
    const { pool } = setupMockPool({
      adGroups: [
        {
          id: "ag-archived",
          campaign_id: "camp-1",
          amazon_ad_group_id: "amz-ag-archived",
          name: "Archived AdGroup",
          default_bid: "0.50",
          state: "ARCHIVED",
        },
        {
          id: "ag-enabled",
          campaign_id: "camp-1",
          amazon_ad_group_id: "amz-ag-enabled",
          name: "Active AdGroup",
          default_bid: "0.60",
          state: "ENABLED",
        },
      ],
    });

    // Explicit valid ad group
    const explicit = await resolveAdGroupId(pool, "camp-1", "ag-archived");
    expect(explicit).toBe("ag-archived");

    // Explicit non-existent ad group throws
    await expect(
      resolveAdGroupId(pool, "camp-1", "missing-ag"),
    ).rejects.toThrow("Ad group 'missing-ag' not found in campaign");

    // Fallback skips archived and selects enabled
    const fallback = await resolveAdGroupId(pool, "camp-1");
    expect(fallback).toBe("ag-enabled");
  });
});
