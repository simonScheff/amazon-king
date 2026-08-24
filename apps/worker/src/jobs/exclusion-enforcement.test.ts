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

/**
 * c1 serves the excluded term and does not block it; c2 serves it but already
 * blocks it with a campaign-level negative exact; c3 serves it but is paused;
 * c4 is enabled and unblocked but never served the term (no facts).
 */
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
    {
      id: "11",
      amazonCampaignId: "c2",
      name: "Auto discovery",
      state: "enabled",
      targetingType: "auto",
      dailyBudget: "10.0000",
    },
    {
      id: "12",
      amazonCampaignId: "c3",
      name: "Paused campaign",
      state: "paused",
      targetingType: "manual",
      dailyBudget: "10.0000",
    },
    {
      id: "13",
      amazonCampaignId: "c4",
      name: "Never served the term",
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
    {
      id: "21",
      campaignId: "11",
      amazonAdGroupId: "ag2",
      state: "enabled",
      defaultBid: null,
    },
    {
      id: "22",
      campaignId: "12",
      amazonAdGroupId: "ag3",
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
    {
      id: "32",
      campaignId: "12",
      adGroupId: "22",
      amazonTargetId: "t3",
      targetKind: "keyword",
      expression: { type: "keyword", value: "*" },
      matchType: "broad",
      bid: "1.0000",
      state: "enabled",
    },
  ],
  negativeKeywords: [
    {
      campaignId: "11",
      adGroupId: null,
      keywordText: "junk term",
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    },
  ],
  negativeTargets: [],
};

function junkTermFact(overrides: Partial<DailyFact>): DailyFact {
  return {
    entityKey: "t1",
    subKey: "junk term",
    campaignAmazonId: "c1",
    date: "2026-08-05",
    currency: "USD",
    impressions: 300,
    clicks: 25,
    orders: 0,
    units: 0,
    costMicros: 12_000_000,
    salesMicros: 0,
    ...overrides,
  };
}

function storeWithExclusion() {
  const store = new FakeStore();
  store.profiles.push(PROFILE);
  store.structure = STRUCTURE;
  store.facts.searchTerm = [
    junkTermFact({}),
    // c2 and c3 served the term too — blocked and paused respectively.
    junkTermFact({ entityKey: "t2", campaignAmazonId: "c2" }),
    junkTermFact({ entityKey: "t3", campaignAmazonId: "c3" }),
  ];
  store.syncRuns.push({
    id: "1",
    profileId: PROFILE.id,
    kind: "metrics",
    status: "complete",
    finishedAt: "2026-08-06T06:00:00.000Z",
    error: null,
  });
  store.exclusions.push({
    id: "1",
    workspaceId: "1",
    searchTerm: "junk term",
    createdAt: "2026-08-01T10:00:00.000Z",
  });
  return store;
}

function run(store: FakeStore) {
  return runHandler(createRecommendationRunHandler(makeDeps({ store })), {
    profileId: PROFILE.id,
  });
}

describe("search term exclusion enforcement", () => {
  it("drafts only for unblocked enabled campaigns that served the term", async () => {
    const store = storeWithExclusion();

    await run(store);

    // c2 already blocks the term, c3 is paused, c4 never served it: only c1.
    expect(store.exclusionSets).toHaveLength(1);
    expect(store.exclusionSets[0]).toMatchObject({
      profileId: PROFILE.id,
      searchTerm: "junk term",
      campaignIds: ["10"],
    });
    // The excluded term is protected: no wasteful_search_term nag for it.
    expect(
      store.recommendations.filter(
        (rec) =>
          rec.type === "wasteful_search_term" && rec.searchTerm === "junk term",
      ),
    ).toHaveLength(0);
  });

  it("produces no duplicate drafts on a rerun", async () => {
    const store = storeWithExclusion();

    await run(store);
    await run(store);

    expect(store.exclusionSets).toHaveLength(1);
  });

  it("drafts for an existing campaign only once it starts serving the term", async () => {
    const store = storeWithExclusion();

    await run(store);
    // c4 exists and is enabled, but no facts show it serving the term yet.
    expect(store.exclusionSets).toHaveLength(1);

    // The next sync brings facts: c4 is now serving the excluded term.
    store.structure.adGroups.push({
      id: "23",
      campaignId: "13",
      amazonAdGroupId: "ag4",
      state: "enabled",
      defaultBid: null,
    });
    store.structure.targets.push({
      id: "33",
      campaignId: "13",
      adGroupId: "23",
      amazonTargetId: "t4",
      targetKind: "keyword",
      expression: { type: "keyword", value: "*" },
      matchType: "broad",
      bid: "1.0000",
      state: "enabled",
    });
    store.facts.searchTerm.push(
      junkTermFact({ entityKey: "t4", campaignAmazonId: "c4" }),
    );
    await run(store);

    expect(store.exclusionSets).toHaveLength(2);
    expect(store.exclusionSets[1]).toMatchObject({
      profileId: PROFILE.id,
      searchTerm: "junk term",
      campaignIds: ["13"],
    });
  });

  it("covers a campaign created after the exclusion was recorded once its facts arrive", async () => {
    const store = storeWithExclusion();

    await run(store);
    // A brand-new enabled campaign appears and immediately serves the term.
    store.structure.campaigns.push({
      id: "14",
      amazonCampaignId: "c5",
      name: "New campaign",
      state: "enabled",
      targetingType: "manual",
      dailyBudget: "5.0000",
    });
    store.facts.searchTerm.push(
      junkTermFact({ entityKey: "t1", campaignAmazonId: "c5" }),
    );
    await run(store);

    expect(store.exclusionSets).toHaveLength(2);
    expect(store.exclusionSets[1]).toMatchObject({
      profileId: PROFILE.id,
      searchTerm: "junk term",
      campaignIds: ["14"],
    });
  });

  it("stays quiet when the workspace owner cannot be resolved", async () => {
    const store = storeWithExclusion();
    store.ownerUserId = null;

    await run(store);

    expect(store.exclusionSets).toHaveLength(0);
  });
});
