import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@amazon-king/database", () => ({
  audit: {},
  books: {},
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
    latestEconomicsForProfiles: vi.fn(),
    dailySeries: vi.fn(),
  },
}));

import { dashboard, metrics, profiles } from "@amazon-king/database";
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
      }),
    );
    vi.mocked(dashboard.latestEconomicsForProfiles).mockResolvedValue([]);
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
    expect(metrics.dashboardTotals).toHaveBeenCalledOnce();
    expect(metrics.dashboardTotals).toHaveBeenCalledWith(
      expect.anything(),
      US_PROFILE.id,
      "2026-07-15",
      "2026-08-13",
    );
    expect(dashboard.dailySeries).toHaveBeenCalledWith(
      expect.anything(),
      [US_PROFILE.id],
      "2026-07-15",
      "2026-08-13",
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

  it("adds configured royalty estimates to each daily point", async () => {
    vi.mocked(dashboard.latestEconomicsForProfiles).mockResolvedValue([
      {
        profilePk: US_PROFILE.id,
        estimatedRoyaltyPerSale: "4.250000",
        currency: "USD",
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
  });
});
