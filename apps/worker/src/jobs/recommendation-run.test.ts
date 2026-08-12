import { describe, expect, it } from "vitest";
import { createRecommendationRunHandler } from "./recommendation-run.js";
import { FakeStore, makeDeps, runHandler } from "../test-utils.js";
import type { DailyFact, ProfileRecord, StructureData } from "../store.js";

const PROFILE: ProfileRecord = {
  id: "7",
  amazonProfileId: "amz-profile-7",
  connectionId: "3",
  workspaceId: "1",
  region: "NA",
  currencyCode: "USD",
  enabled: true,
};

const NOW = new Date("2026-08-06T12:00:00.000Z");

const STRUCTURE: StructureData = {
  campaigns: [
    {
      id: "10",
      amazonCampaignId: "c1",
      name: "Manual exact",
      state: "enabled",
      targetingType: "manual",
      dailyBudget: "10.0000",
    },
  ],
  adGroups: [
    {
      id: "20",
      campaignId: "10",
      amazonAdGroupId: "ag1",
      state: "enabled",
      defaultBid: null,
    },
  ],
  ads: [
    {
      id: "40",
      adGroupId: "20",
      amazonAdId: "ad1",
      asin: "B001",
      state: "enabled",
    },
  ],
  targets: [
    {
      id: "30",
      campaignId: "10",
      adGroupId: "20",
      amazonTargetId: "t1",
      targetKind: "keyword",
      expression: { type: "keyword", value: "coloring book" },
      matchType: "broad",
      bid: "1.0000",
      state: "enabled",
    },
  ],
};

function fact(overrides: Partial<DailyFact>): DailyFact {
  return {
    entityKey: "t1",
    subKey: null,
    campaignAmazonId: "c1",
    date: "2026-08-05",
    currency: "USD",
    impressions: 300,
    clicks: 30,
    orders: 2,
    costMicros: 60_000_000,
    salesMicros: 20_000_000,
    ...overrides,
  };
}

function storeWithData(
  options: { economics?: FakeStore["economics"]; syncRun?: boolean } = {},
) {
  const store = new FakeStore();
  store.profiles.push(PROFILE);
  store.structure = STRUCTURE;
  store.facts.target = [fact({})];
  store.facts.searchTerm = [
    fact({
      subKey: "junk term",
      clicks: 25,
      orders: 0,
      costMicros: 12_000_000,
      salesMicros: 0,
    }),
  ];
  store.economics = options.economics ?? [];
  if (options.syncRun !== false) {
    store.syncRuns.push({
      id: "1",
      profileId: PROFILE.id,
      kind: "metrics",
      status: "complete",
      finishedAt: "2026-08-06T06:00:00.000Z",
      error: null,
    });
  }
  return store;
}

const PAYLOAD = { profileId: "7" };

describe("recommendation_run", () => {
  it("skips when there is no completed metrics sync (incomplete data)", async () => {
    const store = storeWithData({ syncRun: false });
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    expect(store.recommendations).toHaveLength(0);
  });

  it("skips when the last complete metrics sync is stale", async () => {
    const store = storeWithData();
    store.syncRuns[0]!.finishedAt = "2026-08-01T06:00:00.000Z"; // 5 days old
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    expect(store.recommendations).toHaveLength(0);
  });

  it("suppresses profit rules when KDP economics are missing", async () => {
    const store = storeWithData({ economics: [] });
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );

    const types = store.recommendations.map((rec) => rec.type);
    // The wasteful search term rule needs no economics and still fires.
    expect(types).toEqual(["wasteful_search_term"]);
    expect(types).not.toContain("expensive_target");
    expect(types).not.toContain("profitable_target");
    expect(types).not.toContain("budget_constrained_winner");
  });

  it("enables profit rules with user-entered economics and dedupes across windows", async () => {
    const store = storeWithData({
      economics: [
        {
          marketplaceAsin: "B001",
          currency: "USD",
          estimatedRoyaltyPerSale: "5.0000",
          targetAcos: "0.5000",
          goalMode: "profit",
          maxBid: null,
          maxDailyBudget: null,
        },
      ],
    });
    const handler = createRecommendationRunHandler(
      makeDeps({ store, now: () => NOW }),
    );
    await runHandler(handler, PAYLOAD);

    const types = store.recommendations.map((rec) => rec.type).sort();
    expect(types).toEqual(["expensive_target", "wasteful_search_term"]);

    const expensive = store.recommendations.find(
      (rec) => rec.type === "expensive_target",
    )!;
    expect(expensive.targetId).toBe("30");
    expect(expensive.currentValue).toBe("1.0000");
    // 60/20 = ACoS 3.0 vs target 0.5 → bid clamped down by 15%.
    expect(expensive.proposedValue).toBe("0.8500");
    expect(expensive.ruleVersion).toBe("expensive_target@1");
    expect(expensive.evidenceInputs).toMatchObject({ targetId: "30" });

    // Re-running does not duplicate pending recommendations.
    await runHandler(handler, PAYLOAD);
    expect(store.recommendations).toHaveLength(2);
  });

  it("expires stale recommendations before inserting new drafts", async () => {
    const store = storeWithData();
    store.expiredCount = 3;
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    // expireStaleRecommendations is invoked (count returned), insert still proceeds.
    expect(store.recommendations.length).toBeGreaterThan(0);
  });
});
