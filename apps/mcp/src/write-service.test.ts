import { describe, expect, it } from "vitest";
import { createMcpWriteService } from "./write-service.js";
import { setupMockPool } from "./write/test-helpers.js";

describe("createMcpWriteService facade", () => {
  it("exposes all required methods on the interface and delegates correctly", async () => {
    const { pool, tables } = setupMockPool();
    const service = createMcpWriteService(pool);

    // Verify all 8 methods are defined
    expect(typeof service.createRecommendationChangeSet).toBe("function");
    expect(typeof service.createCampaignNegativesChangeSet).toBe("function");
    expect(typeof service.createSearchTermExclusion).toBe("function");
    expect(typeof service.setCampaignMaxCpc).toBe("function");
    expect(typeof service.updateCampaignState).toBe("function");
    expect(typeof service.addKeywordsToCampaign).toBe("function");
    expect(typeof service.setCampaignPlacementMultiplier).toBe("function");
    expect(typeof service.rejectRecommendation).toBe("function");

    // Exercise recommendation change set through facade
    const recRes = (await service.createRecommendationChangeSet("ws-1", [
      "rec-1",
    ])) as { validCount: number };
    expect(recRes.validCount).toBe(1);

    // Exercise state update through facade
    await service.updateCampaignState("ws-1", "camp-1", "paused");

    // Exercise negatives through facade
    await service.createCampaignNegativesChangeSet("ws-1", "camp-1", [
      "sci-fi books",
    ]);

    // Exercise max cpc through facade
    const maxCpcRes = (await service.setCampaignMaxCpc(
      "ws-1",
      "camp-1",
      "0.50",
    )) as { maxCpc: string };
    expect(maxCpcRes.maxCpc).toBe("0.50");

    // All change sets were drafted through the facade
    expect(tables.changeSets.length).toBeGreaterThanOrEqual(4);
  });
});
