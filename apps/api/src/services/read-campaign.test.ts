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
  profiles: {
    getProfile: vi.fn(),
    listProfilesByWorkspace: vi.fn(),
  },
  structure: {
    findCampaignByAmazonId: vi.fn(),
  },
  dashboard: {
    listCampaignRows: vi.fn(),
    listAdGroupRows: vi.fn(),
    listTargetRows: vi.fn(),
    listSearchTermRows: vi.fn(),
    listNegativeKeywordRows: vi.fn(),
    campaignDailySeries: vi.fn(),
  },
}));

import { books, dashboard, profiles, structure } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";

const CAMPAIGN = {
  id: "campaign-pk",
  profileId: "profile-pk",
  amazonProfileId: "amazon-profile",
  amazonCampaignId: "amazon-campaign",
  name: "General",
  state: "enabled",
  targetingType: "manual",
};

describe("campaign profitability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(structure.findCampaignByAmazonId).mockResolvedValue(CAMPAIGN);
    vi.mocked(profiles.getProfile).mockResolvedValue({
      id: "profile-pk",
      connectionId: "connection-pk",
      profileId: "amazon-profile",
      accountId: "ENTITY-1",
      region: "NA",
      countryCode: "US",
      currencyCode: "USD",
      timezone: null,
      accountType: null,
      enabled: true,
      writeEnabled: false,
    });
    vi.mocked(profiles.listProfilesByWorkspace).mockResolvedValue([
      {
        id: "profile-pk",
        connectionId: "connection-pk",
        profileId: "amazon-profile",
        accountId: "ENTITY-1",
        region: "NA",
        countryCode: "US",
        currencyCode: "USD",
        timezone: null,
        accountType: null,
        enabled: true,
        writeEnabled: false,
      },
    ]);
    vi.mocked(dashboard.listCampaignRows).mockResolvedValue([
      {
        campaignPk: "campaign-pk",
        profilePk: "profile-pk",
        amazonProfileId: "amazon-profile",
        amazonCampaignId: "amazon-campaign",
        name: "General",
        state: "enabled",
        currency: "USD",
        totals: {
          impressions: 100,
          clicks: 10,
          cost: "8.0000",
          sales: "20.0000",
          orders: 2,
          units: 2,
        },
        estimatedRoyalty: "10.0000",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-13",
        mixedCurrency: false,
        bookIds: ["42"],
      },
    ]);
    vi.mocked(dashboard.listAdGroupRows).mockResolvedValue([]);
    vi.mocked(dashboard.listTargetRows).mockResolvedValue([]);
    vi.mocked(dashboard.listSearchTermRows).mockResolvedValue([
      {
        id: "tractor gifts",
        name: "tractor gifts",
        state: "n/a",
        totals: {
          impressions: 9,
          clicks: 1,
          cost: "0.5000",
          sales: "8.3000",
          orders: 1,
          units: 1,
        },
        estimatedRoyalty: "4.0000",
        economicsMissing: false,
      },
      {
        id: "farm tractors",
        name: "farm tractors",
        state: "n/a",
        totals: {
          impressions: 2,
          clicks: 1,
          cost: "0.5000",
          sales: "0.0000",
          orders: 1,
          units: 1,
        },
        estimatedRoyalty: null,
        economicsMissing: true,
      },
    ]);
    vi.mocked(dashboard.listNegativeKeywordRows).mockResolvedValue([
      {
        id: "negative-1",
        keywordText: "free books",
        matchType: "NEGATIVE_EXACT",
        level: "ad_group",
        adGroupId: "amazon-ad-group",
        adGroupName: "Exact ad group",
        state: "ENABLED",
      },
    ]);
    vi.mocked(dashboard.campaignDailySeries).mockResolvedValue([
      {
        date: "2026-08-12",
        cost: "5.0000",
        sales: "12.0000",
        orders: 1,
        currency: "USD",
        estimatedRoyalty: "8.0000",
      },
      {
        date: "2026-08-13",
        cost: "3.0000",
        sales: "8.0000",
        orders: 1,
        currency: "USD",
        estimatedRoyalty: "2.0000",
      },
    ]);
  });

  function service() {
    return createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
  }

  it("returns profit totals and daily results for the requested window", async () => {
    const result = await service().getCampaignDetail(
      "workspace-pk",
      "amazon-campaign",
      7,
    );

    expect(dashboard.campaignDailySeries).toHaveBeenCalledWith(
      expect.anything(),
      "profile-pk",
      "amazon-campaign",
      "2026-08-07",
      "2026-08-13",
      null,
    );
    expect(result).toMatchObject({
      dateRange: { start: "2026-08-07", end: "2026-08-13" },
      currency: "USD",
      economicsMissing: false,
      dataCurrentThrough: "2026-08-13T00:00:00.000Z",
      campaign: {
        amazonConsoleUrl:
          "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
        totals: {
          acos: 0.4,
          estimatedRoyalty: "10.0000",
          estimatedAdProfit: "2.0000",
        },
      },
      daily: [
        { date: "2026-08-12", estimatedAdProfit: "3.0000" },
        { date: "2026-08-13", estimatedAdProfit: "-1.0000" },
      ],
      negativeKeywords: [
        {
          id: "negative-1",
          keywordText: "free books",
          level: "ad_group",
          adGroupName: "Exact ad group",
        },
      ],
      searchTerms: [
        {
          name: "tractor gifts",
          estimatedRoyalty: "4.0000",
          estimatedAdProfit: "3.5000",
          economicsMissing: false,
        },
        {
          name: "farm tractors",
          estimatedRoyalty: null,
          estimatedAdProfit: null,
          economicsMissing: true,
        },
      ],
    });
  });

  it("returns seven-day profitability with each campaign list row", async () => {
    const result = await service().listCampaigns("workspace-pk", 7);

    expect(dashboard.listCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      null,
    );
    expect(result).toEqual([
      expect.objectContaining({
        campaignId: "amazon-campaign",
        bookIds: ["42"],
        amazonConsoleUrl:
          "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
        profitability: {
          dateRange: { start: "2026-08-07", end: "2026-08-13" },
          currency: "USD",
          estimatedRoyalty: "10.0000",
          estimatedAdProfit: "2.0000",
          economicsMissing: false,
          dataCurrentThrough: "2026-08-13",
        },
      }),
    ]);
  });

  it("never reports partial profit when any advertised book lacks economics", async () => {
    vi.mocked(dashboard.campaignDailySeries).mockResolvedValue([
      {
        date: "2026-08-12",
        cost: "5.0000",
        sales: "12.0000",
        orders: 1,
        currency: "USD",
        estimatedRoyalty: "8.0000",
      },
      {
        date: "2026-08-13",
        cost: "3.0000",
        sales: "8.0000",
        orders: 1,
        currency: "USD",
        estimatedRoyalty: null,
      },
    ]);

    const result = await service().getCampaignDetail(
      "workspace-pk",
      "amazon-campaign",
      7,
    );

    expect(result?.economicsMissing).toBe(true);
    expect(result?.campaign.totals.estimatedRoyalty).toBeNull();
    expect(result?.campaign.totals.estimatedAdProfit).toBeNull();
    expect(result?.daily[1]?.estimatedAdProfit).toBeNull();
  });

  it("forwards the product filter to the campaign list query", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "7",
      workspaceId: "workspace-pk",
    } as never);

    await service().listCampaigns("workspace-pk", 7, ["7"]);

    expect(dashboard.listCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
  });

  it("forwards the product filter to every campaign detail query", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "7",
      workspaceId: "workspace-pk",
    } as never);

    await service().getCampaignDetail("workspace-pk", "amazon-campaign", 7, [
      "7",
    ]);

    expect(dashboard.listCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.listAdGroupRows).toHaveBeenCalledWith(
      expect.anything(),
      "campaign-pk",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.listTargetRows).toHaveBeenCalledWith(
      expect.anything(),
      "campaign-pk",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.listSearchTermRows).toHaveBeenCalledWith(
      expect.anything(),
      "profile-pk",
      "amazon-campaign",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.listNegativeKeywordRows).toHaveBeenCalledWith(
      expect.anything(),
      "campaign-pk",
      [7n],
    );
    expect(dashboard.campaignDailySeries).toHaveBeenCalledWith(
      expect.anything(),
      "profile-pk",
      "amazon-campaign",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
  });

  it("rejects an unknown book id with 404 before reading metrics", async () => {
    vi.mocked(books.getBook).mockResolvedValue(null);

    await expect(
      service().listCampaigns("workspace-pk", 7, ["42"]),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(dashboard.listCampaignRows).not.toHaveBeenCalled();
  });
});
