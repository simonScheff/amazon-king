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
  negativeKeywords: [],
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
    units: 2,
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

/** Two campaigns spending on the same shopper term (a cannibalization conflict). */
function cannibalizationStore() {
  const store = storeWithData();
  store.structure = {
    ...STRUCTURE,
    campaigns: [
      ...STRUCTURE.campaigns,
      {
        id: "11",
        amazonCampaignId: "c2",
        name: "Auto discovery",
        state: "enabled",
        targetingType: "auto",
        dailyBudget: "10.0000",
      },
    ],
    adGroups: [
      ...STRUCTURE.adGroups,
      {
        id: "21",
        campaignId: "11",
        amazonAdGroupId: "ag2",
        state: "enabled",
        defaultBid: null,
      },
    ],
    targets: [
      ...STRUCTURE.targets,
      {
        id: "31",
        campaignId: "11",
        adGroupId: "21",
        amazonTargetId: "t2",
        targetKind: "keyword",
        expression: { type: "keyword", value: "*" },
        matchType: "broad",
        bid: "1.0000",
        state: "enabled",
      },
    ],
  };
  store.facts.searchTerm = [
    fact({ subKey: "tractor colouring book", orders: 2, clicks: 4 }),
    fact({
      entityKey: "t2",
      campaignAmazonId: "c2",
      subKey: "tractor colouring book",
      orders: 4,
      clicks: 6,
    }),
  ];
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
    expect(expensive.ruleVersion).toBe("expensive_target@2");
    expect(expensive.evidenceInputs).toMatchObject({ targetId: "30" });

    // Re-running does not duplicate pending recommendations.
    await runHandler(handler, PAYLOAD);
    expect(store.recommendations).toHaveLength(2);
  });

  it("flags a term spending across two campaigns", async () => {
    const store = cannibalizationStore();
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    const conflict = store.recommendations.find(
      (rec) => rec.type === "cannibalization_conflict",
    );
    expect(conflict?.searchTerm).toBe("tractor colouring book");
  });

  it("stops flagging a term a campaign negative already blocks", async () => {
    const store = cannibalizationStore();
    store.structure = {
      ...store.structure,
      negativeKeywords: [
        {
          campaignId: "11",
          adGroupId: null,
          keywordText: "Tractor Colouring Book",
          matchType: "NEGATIVE_EXACT",
          state: "ENABLED",
        },
      ],
    };
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    expect(
      store.recommendations.filter(
        (rec) => rec.type === "cannibalization_conflict",
      ),
    ).toHaveLength(0);
  });

  it("expires a pending conflict once a negative resolves it", async () => {
    const store = cannibalizationStore();
    store.recommendations.push({
      profileId: PROFILE.id,
      type: "cannibalization_conflict",
      campaignId: null,
      adGroupId: null,
      targetId: null,
      searchTerm: "tractor colouring book",
      priority: 1,
      evidenceWindowStart: "2026-06-07",
      evidenceWindowEnd: "2026-08-05",
      currentValue: null,
      proposedValue: null,
      rationale: "raised by an earlier run",
      confidence: "0.500",
      ruleVersion: "cannibalization_conflict@2",
      dataFreshnessAt: "2026-08-06T06:00:00.000Z",
      expiresAt: "2026-08-09T06:00:00.000Z",
      evidenceInputs: {},
    });
    store.structure = {
      ...store.structure,
      negativeKeywords: [
        {
          campaignId: "11",
          adGroupId: null,
          keywordText: "tractor colouring book",
          matchType: "NEGATIVE_EXACT",
          state: "ENABLED",
        },
      ],
    };
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    expect(
      store.recommendations.some(
        (rec) => rec.type === "cannibalization_conflict",
      ),
    ).toBe(false);
  });

  it("does not re-raise a finding the owner dismissed", async () => {
    const store = storeWithData();
    store.dismissals.push({
      profileId: PROFILE.id,
      type: "wasteful_search_term",
      campaignId: "10",
      adGroupId: null,
      targetId: null,
      searchTerm: "junk term",
    });
    await runHandler(
      createRecommendationRunHandler(makeDeps({ store, now: () => NOW })),
      PAYLOAD,
    );
    expect(store.recommendations).toHaveLength(0);
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
