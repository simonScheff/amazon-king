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
    listSearchTermRollupRows: vi.fn(),
    listSearchTermCampaignRows: vi.fn(),
    searchTermDailySeries: vi.fn(),
  },
}));

import { books, dashboard } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";

const ROLLUP_ROW = {
  searchTerm: "fantasy books",
  campaignCount: 2,
  countryCodes: ["US"],
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
};

const CAMPAIGN_ROW = {
  amazonProfileId: "amazon-profile",
  countryCode: "US",
  amazonCampaignId: "amazon-campaign",
  name: "General",
  state: "enabled",
  currency: "USD",
  totals: {
    impressions: 60,
    clicks: 6,
    cost: "5.0000",
    sales: "12.0000",
    orders: 1,
    units: 1,
  },
  estimatedRoyalty: "6.0000",
  economicsMissing: false,
  dataCurrentThrough: "2026-08-13",
  mixedCurrency: false,
};

const DAILY_POINT = {
  date: "2026-08-13",
  cost: "5.0000",
  sales: "12.0000",
  orders: 1,
  currency: "USD",
  estimatedRoyalty: "6.0000",
};

describe("search terms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dashboard.listSearchTermRollupRows).mockResolvedValue([
      ROLLUP_ROW,
    ]);
    vi.mocked(dashboard.searchTermDailySeries).mockResolvedValue([
      DAILY_POINT,
      { ...DAILY_POINT, date: "2026-08-12", estimatedRoyalty: null },
    ]);
    vi.mocked(dashboard.listSearchTermCampaignRows).mockResolvedValue([
      CAMPAIGN_ROW,
      {
        ...CAMPAIGN_ROW,
        amazonCampaignId: "amazon-campaign-2",
        name: "Research",
        totals: {
          impressions: 40,
          clicks: 4,
          cost: "3.0000",
          sales: "8.0000",
          orders: 1,
          units: 1,
        },
        estimatedRoyalty: "4.0000",
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

  it("aggregates each search term across campaigns with profitability", async () => {
    const result = await service().listSearchTerms("workspace-pk", 7);

    expect(dashboard.listSearchTermRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      null,
      null,
    );
    expect(result).toEqual([
      {
        searchTerm: "fantasy books",
        campaignCount: 2,
        countryCodes: ["US"],
        currency: "USD",
        totals: {
          impressions: 100,
          clicks: 10,
          cost: "8.0000",
          sales: "20.0000",
          orders: 2,
          units: 2,
          acos: 0.4,
        },
        estimatedRoyalty: "10.0000",
        estimatedAdProfit: "2.0000",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-13",
        bookIds: ["42"],
      },
    ]);
  });

  it("refuses to aggregate a term that mixes currencies", async () => {
    vi.mocked(dashboard.listSearchTermRollupRows).mockResolvedValue([
      { ...ROLLUP_ROW, mixedCurrency: true },
    ]);

    await expect(
      service().listSearchTerms("workspace-pk", 7),
    ).rejects.toMatchObject({ statusCode: 409, code: "MIXED_CURRENCY" });
  });

  it("returns the per-campaign breakdown with combined totals", async () => {
    const result = await service().getSearchTermDetail(
      "workspace-pk",
      "fantasy books",
      7,
    );

    expect(dashboard.listSearchTermCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "2026-08-07",
      "2026-08-13",
      null,
    );
    expect(dashboard.searchTermDailySeries).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "US",
      "2026-08-07",
      "2026-08-13",
      null,
    );
    expect(result).toMatchObject({
      searchTerm: "fantasy books",
      dateRange: { start: "2026-08-07", end: "2026-08-13" },
      currency: "USD",
      totals: {
        impressions: 100,
        clicks: 10,
        cost: "8.0000",
        sales: "20.0000",
        orders: 2,
        units: 2,
        acos: 0.4,
        estimatedRoyalty: "10.0000",
        estimatedAdProfit: "2.0000",
      },
      economicsMissing: false,
      dataCurrentThrough: "2026-08-13",
      daily: [
        {
          date: "2026-08-13",
          cost: "5.0000",
          sales: "12.0000",
          estimatedRoyalty: "6.0000",
          estimatedAdProfit: "1.0000",
        },
        {
          date: "2026-08-12",
          cost: "5.0000",
          sales: "12.0000",
          estimatedRoyalty: null,
          estimatedAdProfit: null,
        },
      ],
      campaigns: [
        { campaignId: "amazon-campaign", estimatedAdProfit: "1.0000" },
        { campaignId: "amazon-campaign-2", estimatedAdProfit: "1.0000" },
      ],
    });
  });

  it("returns null when no campaign advertised the term", async () => {
    vi.mocked(dashboard.listSearchTermCampaignRows).mockResolvedValue([]);

    await expect(
      service().getSearchTermDetail("workspace-pk", "unknown term", 7),
    ).resolves.toBeNull();
    expect(dashboard.searchTermDailySeries).not.toHaveBeenCalled();
  });

  it("never reports partial profit when any campaign lacks economics", async () => {
    vi.mocked(dashboard.listSearchTermCampaignRows).mockResolvedValue([
      CAMPAIGN_ROW,
      {
        ...CAMPAIGN_ROW,
        amazonCampaignId: "amazon-campaign-2",
        estimatedRoyalty: null,
        economicsMissing: true,
      },
    ]);

    const result = await service().getSearchTermDetail(
      "workspace-pk",
      "fantasy books",
      7,
    );

    expect(result?.economicsMissing).toBe(true);
    expect(result?.totals.estimatedRoyalty).toBeNull();
    expect(result?.totals.estimatedAdProfit).toBeNull();
    // Per-campaign rows keep their own economics state.
    expect(result?.campaigns[0]?.estimatedAdProfit).toBe("1.0000");
    expect(result?.campaigns[1]?.estimatedAdProfit).toBeNull();
  });

  it("returns one market at a time when campaigns use different currencies", async () => {
    vi.mocked(dashboard.listSearchTermCampaignRows).mockResolvedValue([
      CAMPAIGN_ROW,
      {
        ...CAMPAIGN_ROW,
        amazonProfileId: "amazon-profile-gb",
        amazonCampaignId: "amazon-campaign-2",
        countryCode: "GB",
        currency: "EUR",
      },
    ]);

    const defaultMarket = await service().getSearchTermDetail(
      "workspace-pk",
      "fantasy books",
      7,
    );
    expect(defaultMarket).toMatchObject({
      countryCode: "US",
      availableCountryCodes: ["US", "GB"],
      currency: "USD",
      campaigns: [{ campaignId: "amazon-campaign" }],
    });

    const gbMarket = await service().getSearchTermDetail(
      "workspace-pk",
      "fantasy books",
      7,
      null,
      "GB",
    );
    expect(gbMarket).toMatchObject({
      countryCode: "GB",
      availableCountryCodes: ["US", "GB"],
      currency: "EUR",
      campaigns: [{ campaignId: "amazon-campaign-2" }],
    });
    expect(dashboard.searchTermDailySeries).toHaveBeenLastCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "GB",
      "2026-08-07",
      "2026-08-13",
      null,
    );
  });

  it("still refuses to combine currencies inside one market", async () => {
    vi.mocked(dashboard.listSearchTermCampaignRows).mockResolvedValue([
      CAMPAIGN_ROW,
      {
        ...CAMPAIGN_ROW,
        amazonCampaignId: "amazon-campaign-2",
        currency: "EUR",
      },
    ]);

    await expect(
      service().getSearchTermDetail("workspace-pk", "fantasy books", 7),
    ).rejects.toMatchObject({ statusCode: 409, code: "MIXED_CURRENCY" });
  });

  it("passes a workspace-owned book filter through to the queries", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "7",
      workspaceId: "workspace-pk",
    } as never);

    await service().listSearchTerms("workspace-pk", 7, ["7"]);
    expect(dashboard.listSearchTermRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      [7n],
      null,
    );

    await service().getSearchTermDetail("workspace-pk", "fantasy books", 7, [
      "7",
    ]);
    expect(dashboard.listSearchTermCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.searchTermDailySeries).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "US",
      "2026-08-07",
      "2026-08-13",
      [7n],
    );
  });

  it("resolves each selected book and passes the union to the queries", async () => {
    vi.mocked(books.getBook).mockImplementation(async (_db, id) => {
      if (id === "7" || id === "9") {
        return { id, workspaceId: "workspace-pk" } as never;
      }
      return null;
    });

    await service().listSearchTerms("workspace-pk", 7, ["7", "9"]);

    expect(books.getBook).toHaveBeenCalledTimes(2);
    expect(dashboard.listSearchTermRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      [7n, 9n],
      null,
    );
  });

  it("passes a market filter through to the rollup query", async () => {
    await service().listSearchTerms("workspace-pk", 7, null, "DE");
    expect(dashboard.listSearchTermRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      null,
      "DE",
    );
  });

  it("rejects a book filter that is not part of the workspace", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "book-9",
      workspaceId: "other-workspace",
    } as never);

    await expect(
      service().listSearchTerms("workspace-pk", 7, ["book-9"]),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(dashboard.listSearchTermRollupRows).not.toHaveBeenCalled();
  });

  it("rejects an unknown book id with 404", async () => {
    vi.mocked(books.getBook).mockResolvedValue(null);

    await expect(
      service().listSearchTerms("workspace-pk", 7, ["42"]),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service().getSearchTermDetail("workspace-pk", "fantasy books", 7, ["42"]),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(dashboard.listSearchTermRollupRows).not.toHaveBeenCalled();
    expect(dashboard.listSearchTermCampaignRows).not.toHaveBeenCalled();
  });
});
