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
  structure: {},
  profiles: {
    listProfilesByWorkspace: vi.fn(),
  },
  metrics: {
    MixedCurrencyError: class MixedCurrencyError extends Error {},
    dashboardTotals: vi.fn(),
  },
  dashboard: {
    overviewRoyaltySeries: vi.fn(),
    dailySeries: vi.fn(),
  },
  fx: {
    // Rates are "synced" by default so single-country behavior keeps its
    // ratesAvailable gate; the FX view itself is covered by read-fx.test.ts.
    getLatestRateDate: vi.fn(async () => "2026-08-12"),
  },
}));

import { books, dashboard, fx, metrics, profiles } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";

const US_PROFILE = {
  id: "profile-us",
  connectionId: "connection-1",
  profileId: "amazon-us",
  accountId: null,
  region: "NA" as const,
  countryCode: "US",
  currencyCode: "USD",
  timezone: null,
  accountType: null,
  enabled: true,
  writeEnabled: false,
};

const UK_PROFILE = {
  ...US_PROFILE,
  id: "profile-uk",
  profileId: "amazon-uk",
  region: "EU" as const,
  countryCode: "GB",
  currencyCode: "GBP",
};

describe("dashboard country filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(profiles.listProfilesByWorkspace).mockResolvedValue([
      US_PROFILE,
      UK_PROFILE,
    ]);
    vi.mocked(metrics.dashboardTotals).mockImplementation(
      async (_db, profileId) => ({
        currency: profileId === US_PROFILE.id ? "USD" : "GBP",
        impressions: 100,
        clicks: 10,
        cost: "5.0000",
        sales: "20.0000",
        orders: 2,
        units: 2,
      }),
    );
    vi.mocked(dashboard.overviewRoyaltySeries).mockResolvedValue([]);
    vi.mocked(dashboard.dailySeries).mockImplementation(
      async (_db, profileIds) => [
        {
          date: "2026-08-13",
          profilePk: profileIds[0]!,
          cost: "5.000000",
          sales: "20.000000",
          orders: 2,
          currency: profileIds[0] === US_PROFILE.id ? "USD" : "GBP",
        },
      ],
    );
  });

  it("aggregates only enabled profiles in the requested country", async () => {
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardSummary("workspace-1", 30, "US");

    expect(result.currency).toBe("USD");
    // Current window plus the immediately preceding window of the same length.
    expect(metrics.dashboardTotals).toHaveBeenCalledTimes(2);
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-07-15",
      "2026-08-13",
      null,
    );
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-06-15",
      "2026-07-14",
      null,
    );
    expect(result.previous).toEqual({
      dateRange: { start: "2026-06-15", end: "2026-07-14" },
      totals: {
        impressions: 100,
        clicks: 10,
        cost: "5.0000",
        sales: "20.0000",
        orders: 2,
        units: 2,
        acos: 0.25,
        estimatedRoyalty: null,
        estimatedAdProfit: null,
      },
    });
    expect(dashboard.dailySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
      null,
    );
    expect(result.daily).toEqual([
      {
        date: "2026-08-13",
        cost: "5.0000",
        sales: "20.0000",
        orders: 2,
        estimatedRoyalty: null,
      },
    ]);
  });

  it("adds per-book per-market royalty estimates to each daily point", async () => {
    vi.mocked(dashboard.overviewRoyaltySeries).mockResolvedValue([
      {
        date: "2026-08-13",
        profilePk: US_PROFILE.id,
        currency: "USD",
        estimatedRoyalty: "8.5000",
        economicsMissing: false,
      },
    ]);
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardSummary("workspace-1", 30, "US");

    expect(result.daily?.[0]?.estimatedRoyalty).toBe("8.5000");
    expect(result.totals.estimatedRoyalty).toBe("8.5000");
    expect(dashboard.overviewRoyaltySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
      null,
    );
  });

  it("does not apply another book's marketplace royalty to the selected book", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "7",
      workspaceId: "workspace-1",
    } as never);
    vi.mocked(dashboard.overviewRoyaltySeries).mockResolvedValue([
      {
        date: "2026-08-13",
        profilePk: US_PROFILE.id,
        currency: "USD",
        estimatedRoyalty: "20.5800",
        economicsMissing: false,
      },
    ]);
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardSummary("workspace-1", 30, "US", [
      "7",
    ]);

    expect(result.totals.estimatedRoyalty).toBe("20.5800");
    expect(dashboard.overviewRoyaltySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
      [7n],
    );
  });

  it("forwards the product filter to the totals and daily series", async () => {
    vi.mocked(books.getBook).mockResolvedValue({
      id: "7",
      workspaceId: "workspace-1",
    } as never);
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    await service.dashboardSummary("workspace-1", 30, "US", ["7"]);

    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-07-15",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.dailySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
      [7n],
    );
    expect(dashboard.overviewRoyaltySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
      [7n],
    );
  });

  it("rejects an unknown book id with 404 before reading metrics", async () => {
    vi.mocked(books.getBook).mockResolvedValue(null);
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    await expect(
      service.dashboardSummary("workspace-1", 30, "US", ["42"]),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(metrics.dashboardTotals).not.toHaveBeenCalled();
  });

  it("uses UTC month-to-date and prior-month MTD for days=mtd", async () => {
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardSummary("workspace-1", "mtd", "US");

    expect(result.dateRange).toEqual({
      start: "2026-08-01",
      end: "2026-08-13",
    });
    expect(result.previous.dateRange).toEqual({
      start: "2026-07-01",
      end: "2026-07-13",
    });
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-08-01",
      "2026-08-13",
      null,
    );
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-07-01",
      "2026-07-13",
      null,
    );
  });

  it("clamps prior-month MTD when the previous month is shorter", async () => {
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-03-31T12:00:00.000Z"),
    });

    const result = await service.dashboardSummary("workspace-1", "mtd", "US");

    expect(result.dateRange).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
    });
    expect(result.previous.dateRange).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("reports ratesAvailable from fx coverage on a single-country view", async () => {
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    await expect(
      service.dashboardSummary("workspace-1", 30, "US"),
    ).resolves.toMatchObject({ currency: "USD", ratesAvailable: true });

    vi.mocked(fx.getLatestRateDate).mockResolvedValue(null);
    await expect(
      service.dashboardSummary("workspace-1", 30, "US"),
    ).resolves.toMatchObject({ currency: "USD", ratesAvailable: false });
  });
});

describe("dashboard country spend", () => {
  const CA_PROFILE = {
    ...US_PROFILE,
    id: "profile-ca",
    profileId: "amazon-ca",
    countryCode: "CA",
    currencyCode: "CAD",
  };
  const US_PROFILE_2 = {
    ...US_PROFILE,
    id: "profile-us-2",
    profileId: "amazon-us-2",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(profiles.listProfilesByWorkspace).mockResolvedValue([
      US_PROFILE,
      US_PROFILE_2,
      UK_PROFILE,
      CA_PROFILE,
    ]);
    vi.mocked(metrics.dashboardTotals).mockImplementation(
      async (_db, profileId) => {
        if (profileId === CA_PROFILE.id) return null; // no metrics in window
        const cost =
          profileId === UK_PROFILE.id
            ? "20.0000"
            : profileId === US_PROFILE_2.id
              ? "7.0000"
              : "5.0000";
        return {
          currency: profileId === UK_PROFILE.id ? "GBP" : "USD",
          impressions: 100,
          clicks: 10,
          cost,
          sales: "0.0000",
          orders: 0,
          units: 0,
        };
      },
    );
  });

  it("sums profiles per country and sorts countries by spend descending", async () => {
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardCountrySpend("workspace-1", 7);

    expect(result.dateRange).toEqual({
      start: "2026-08-07",
      end: "2026-08-13",
    });
    // GB (20) > US (5 + 7 = 12); CA has no metrics and is omitted.
    expect(result.countries).toEqual([
      { countryCode: "GB", currency: "GBP", spend: "20.0000" },
      { countryCode: "US", currency: "USD", spend: "12.0000" },
    ]);
  });

  it("ignores disabled profiles", async () => {
    vi.mocked(profiles.listProfilesByWorkspace).mockResolvedValue([
      { ...UK_PROFILE, enabled: false },
      US_PROFILE,
    ]);
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    const result = await service.dashboardCountrySpend("workspace-1", 7);

    expect(result.countries).toEqual([
      { countryCode: "US", currency: "USD", spend: "5.0000" },
    ]);
  });

  it("forwards the product filter to every profile's totals", async () => {
    vi.mocked(books.getBook).mockImplementation(async (_db, id) => {
      if (id === "7" || id === "9") {
        return { id, workspaceId: "workspace-1" } as never;
      }
      return null;
    });
    const service = createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    await service.dashboardCountrySpend("workspace-1", 7, ["7", "9"]);

    expect(metrics.dashboardTotals).toHaveBeenCalledTimes(4);
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-08-07",
      "2026-08-13",
      [7n, 9n],
    );
  });
});
