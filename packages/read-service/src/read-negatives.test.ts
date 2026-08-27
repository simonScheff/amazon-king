import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@amazon-king/database", () => ({
  audit: {},
  books: {
    getBook: vi.fn(),
  },
  changes: {},
  connections: {},
  enqueue: {},
  recommendations: {},
  reports: {},
  metrics: {
    MixedCurrencyError: class MixedCurrencyError extends Error {},
  },
  profiles: {},
  structure: {},
  dashboard: {
    listNegativeRollupRows: vi.fn(),
    listNegativeSpecRows: vi.fn(),
    listNegativeServingRows: vi.fn(),
    listNegativeTermCampaignRows: vi.fn(),
    listNegativeDailySeries: vi.fn(),
    listNegativeCandidateTerms: vi.fn(),
  },
}));

import { dashboard } from "@amazon-king/database";
import type { ReadServiceConfig as ApiConfig } from "./types.js";
import { createReadService } from "./read.js";

const PERIOD = {
  totals: {
    impressions: 80,
    clicks: 8,
    cost: "6.0000",
    sales: "12.0000",
    orders: 1,
    units: 1,
  },
  estimatedRoyalty: "5.0000",
  economicsMissing: false,
  mixedCurrency: false,
  currency: "USD",
};

const ROLLUP = {
  kind: "keyword" as const,
  value: "free books",
  valueKey: "free books",
  matchTypes: ["NEGATIVE_EXACT"],
  countryCodes: ["US"],
  structureCurrency: "USD",
  structureMixedCurrency: false,
  bookIds: ["42"],
  catalogBookId: null,
  excludedEverywhere: false,
  firstSeenAt: "2026-08-10T00:00:00.000Z",
  lastServedAt: "2026-08-13",
  blockingCampaignCount: 1,
  pausedCampaignCount: 0,
  window: PERIOD,
  before: {
    ...PERIOD,
    totals: { ...PERIOD.totals, orders: 3, cost: "9.0000", sales: "20.0000" },
  },
  dataCurrentThrough: "2026-08-13",
};

const BLOCKED_SPEC = {
  kind: "keyword" as const,
  valueKey: "free books",
  amazonNegativeId: "neg-blocked",
  matchType: "NEGATIVE_EXACT",
  level: "campaign" as const,
  amazonAdGroupId: null,
  adGroupName: null,
  negativeState: "enabled",
  firstSeenAt: "2026-08-10T00:00:00.000Z",
  amazonProfileId: "profile-us",
  amazonCampaignId: "campaign-blocked",
  campaignName: "Blocked",
  campaignState: "enabled",
  countryCode: "US",
  currency: "USD",
};

const FACT_BLOCKED = {
  amazonProfileId: "profile-us",
  countryCode: "US",
  amazonCampaignId: "campaign-blocked",
  name: "Blocked",
  state: "enabled",
  currency: "USD",
  totals: {
    impressions: 50,
    clicks: 5,
    cost: "4.0000",
    sales: "12.0000",
    orders: 1,
    units: 1,
  },
  estimatedRoyalty: "5.0000",
  economicsMissing: false,
  dataCurrentThrough: "2026-08-13",
  mixedCurrency: false,
};

const FACT_LEAK = {
  ...FACT_BLOCKED,
  amazonCampaignId: "campaign-leak",
  name: "Leak",
  totals: {
    impressions: 30,
    clicks: 3,
    cost: "2.0000",
    sales: "0.0000",
    orders: 0,
    units: 0,
  },
  estimatedRoyalty: "0.0000",
};

function serving(
  campaignId: string,
  adGroupId: string,
  campaignState = "enabled",
) {
  return {
    kind: "keyword" as const,
    valueKey: "free books",
    amazonProfileId: "profile-us",
    amazonCampaignId: campaignId,
    amazonAdGroupId: adGroupId,
    campaignName: campaignId,
    campaignState,
    countryCode: "US",
    currency: "USD",
  };
}

describe("negatives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dashboard.listNegativeRollupRows).mockResolvedValue([ROLLUP]);
    vi.mocked(dashboard.listNegativeSpecRows).mockResolvedValue([BLOCKED_SPEC]);
    vi.mocked(dashboard.listNegativeServingRows).mockResolvedValue([
      serving("campaign-blocked", "ag-blocked"),
      serving("campaign-leak", "ag-leak"),
    ]);
    vi.mocked(dashboard.listNegativeTermCampaignRows).mockResolvedValue([
      FACT_BLOCKED,
      FACT_LEAK,
    ]);
    vi.mocked(dashboard.listNegativeDailySeries).mockResolvedValue([
      {
        date: "2026-08-13",
        cost: "6.0000",
        sales: "12.0000",
        orders: 1,
        currency: "USD",
        estimatedRoyalty: "5.0000",
      },
    ]);
    vi.mocked(dashboard.listNegativeCandidateTerms).mockResolvedValue([]);
  });

  function service() {
    return createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
  }

  it("counts enabled campaigns that still serve a fully unblocked term", async () => {
    const result = await service().listNegatives("workspace-pk", 7);

    expect(dashboard.listNegativeRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      null,
      null,
      null,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "keyword",
      value: "free books",
      blockingCampaignCount: 1,
      stillServingCampaignCount: 1,
      before: { orders: 3, cost: "9.0000", acos: 0.45 },
      window: { orders: 1, cost: "6.0000", estimatedAdProfit: "-1.0000" },
    });
  });

  it("does not count a leak when every serving ad group is negated", async () => {
    vi.mocked(dashboard.listNegativeServingRows).mockResolvedValue([
      serving("campaign-blocked", "ag-blocked"),
    ]);

    const result = await service().listNegatives("workspace-pk", 7);
    expect(result[0]?.stillServingCampaignCount).toBe(0);
  });

  it("treats a campaign as still serving when only some ad groups are negated", async () => {
    vi.mocked(dashboard.listNegativeSpecRows).mockResolvedValue([
      {
        ...BLOCKED_SPEC,
        amazonCampaignId: "campaign-partial",
        level: "ad_group",
        amazonAdGroupId: "ag-1",
        adGroupName: "One",
      },
    ]);
    vi.mocked(dashboard.listNegativeServingRows).mockResolvedValue([
      serving("campaign-partial", "ag-1"),
      serving("campaign-partial", "ag-2"),
    ]);

    const result = await service().listNegatives("workspace-pk", 7);
    expect(result[0]?.stillServingCampaignCount).toBe(1);
  });

  it("ignores paused campaigns when counting still-serving leaks", async () => {
    vi.mocked(dashboard.listNegativeServingRows).mockResolvedValue([
      serving("campaign-blocked", "ag-blocked"),
      serving("campaign-leak", "ag-leak", "paused"),
    ]);

    const result = await service().listNegatives("workspace-pk", 7);
    expect(result[0]?.stillServingCampaignCount).toBe(0);
  });

  it("refuses to aggregate mixed-currency negative metrics", async () => {
    vi.mocked(dashboard.listNegativeRollupRows).mockResolvedValue([
      {
        ...ROLLUP,
        window: { ...PERIOD, mixedCurrency: true },
      },
    ]);

    await expect(
      service().listNegatives("workspace-pk", 7),
    ).rejects.toMatchObject({ statusCode: 409, code: "MIXED_CURRENCY" });
  });

  it("splits detail campaigns into running-on vs not-running-on", async () => {
    const pausedSpec = {
      ...BLOCKED_SPEC,
      amazonNegativeId: "neg-paused",
      amazonCampaignId: "campaign-paused",
      campaignName: "Paused",
      campaignState: "paused",
    };
    vi.mocked(dashboard.listNegativeSpecRows).mockResolvedValue([
      BLOCKED_SPEC,
      pausedSpec,
    ]);

    const result = await service().getNegativeDetail(
      "workspace-pk",
      "keyword",
      "free books",
      7,
    );

    expect(result).toMatchObject({
      kind: "keyword",
      value: "free books",
      countryCode: "US",
      stillServingCampaignCount: 1,
      hasSearchTermFacts: true,
    });
    expect(
      result?.blockingCampaigns.map((row) => row.campaignId).sort(),
    ).toEqual(["campaign-blocked", "campaign-paused"]);
    expect(
      result?.blockingCampaigns.find(
        (row) => row.campaignId === "campaign-blocked",
      )?.currentlyBlocks,
    ).toBe(true);
    expect(
      result?.blockingCampaigns.find(
        (row) => row.campaignId === "campaign-paused",
      )?.currentlyBlocks,
    ).toBe(false);
    expect(result?.unblockedCampaigns).toEqual([
      expect.objectContaining({
        campaignId: "campaign-leak",
        name: "Leak",
      }),
    ]);
  });

  it("returns phrase matches capped from candidate shopper terms", async () => {
    vi.mocked(dashboard.listNegativeSpecRows).mockResolvedValue([
      { ...BLOCKED_SPEC, matchType: "NEGATIVE_PHRASE" },
    ]);
    vi.mocked(dashboard.listNegativeRollupRows).mockResolvedValue([
      { ...ROLLUP, matchTypes: ["NEGATIVE_PHRASE"] },
    ]);
    vi.mocked(dashboard.listNegativeCandidateTerms).mockResolvedValue([
      "best free books for kids",
      "unrelated query",
    ]);

    const result = await service().getNegativeDetail(
      "workspace-pk",
      "keyword",
      "free books",
      7,
    );

    expect(dashboard.listNegativeCandidateTerms).toHaveBeenCalled();
    expect(result?.matchedTerms).toEqual(["best free books for kids"]);
  });

  it("returns null when the negative is unknown", async () => {
    vi.mocked(dashboard.listNegativeSpecRows).mockResolvedValue([]);

    await expect(
      service().getNegativeDetail("workspace-pk", "keyword", "missing", 7),
    ).resolves.toBeNull();
  });
});
