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
  },
}));

import { books, dashboard } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";

const ROLLUP_ROW = {
  searchTerm: "fantasy books",
  campaignCount: 2,
  currency: "USD",
  totals: {
    impressions: 100,
    clicks: 10,
    cost: "8.0000",
    sales: "20.0000",
    orders: 2,
  },
  estimatedRoyalty: "10.0000",
  economicsMissing: false,
  dataCurrentThrough: "2026-08-13",
  mixedCurrency: false,
};

const CAMPAIGN_ROW = {
  amazonProfileId: "amazon-profile",
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
  },
  estimatedRoyalty: "6.0000",
  economicsMissing: false,
  dataCurrentThrough: "2026-08-13",
  mixedCurrency: false,
};

describe("search terms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dashboard.listSearchTermRollupRows).mockResolvedValue([
      ROLLUP_ROW,
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
    );
    expect(result).toEqual([
      {
        searchTerm: "fantasy books",
        campaignCount: 2,
        currency: "USD",
        totals: {
          impressions: 100,
          clicks: 10,
          cost: "8.0000",
          sales: "20.0000",
          orders: 2,
          acos: 0.4,
        },
        estimatedRoyalty: "10.0000",
        estimatedAdProfit: "2.0000",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-13",
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
        acos: 0.4,
        estimatedRoyalty: "10.0000",
        estimatedAdProfit: "2.0000",
      },
      economicsMissing: false,
      dataCurrentThrough: "2026-08-13",
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

  it("refuses to combine campaigns in different currencies", async () => {
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
      id: "book-1",
      workspaceId: "workspace-pk",
    } as never);

    await service().listSearchTerms("workspace-pk", 7, "book-1");
    expect(dashboard.listSearchTermRollupRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "2026-08-07",
      "2026-08-13",
      "book-1",
    );

    await service().getSearchTermDetail(
      "workspace-pk",
      "fantasy books",
      7,
      "book-1",
    );
    expect(dashboard.listSearchTermCampaignRows).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      "fantasy books",
      "2026-08-07",
      "2026-08-13",
      "book-1",
    );
  });

  it("rejects a book filter that is not part of the workspace", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "book-9",
      workspaceId: "other-workspace",
    } as never);

    await expect(
      service().listSearchTerms("workspace-pk", 7, "book-9"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(dashboard.listSearchTermRollupRows).not.toHaveBeenCalled();
  });
});
