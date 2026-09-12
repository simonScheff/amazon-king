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

  it("resolves ad group id by id or falls back to first ad group in campaign", async () => {
    const { pool } = setupMockPool();

    // Explicit valid ad group
    const explicit = await resolveAdGroupId(pool, "camp-1", "ag-1");
    expect(explicit).toBe("ag-1");

    // Explicit non-existent ad group throws
    await expect(
      resolveAdGroupId(pool, "camp-1", "missing-ag"),
    ).rejects.toThrow("Ad group 'missing-ag' not found in campaign");

    // Fallback to first ad group when not specified
    const fallback = await resolveAdGroupId(pool, "camp-1");
    expect(fallback).toBe("ag-1");
  });
});
