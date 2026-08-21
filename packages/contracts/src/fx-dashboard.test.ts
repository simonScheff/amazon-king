import { describe, expect, it } from "vitest";
import {
  countrySpendQuerySchema,
  countrySpendSchema,
  dashboardSummaryQuerySchema,
  dashboardSummarySchema,
  dataFreshnessResponseSchema,
  fxSyncResultSchema,
  workspaceSettingsUpdateSchema,
} from "./index.js";

/**
 * Schemas for the all-market dashboard view
 * (docs/fx-rates-all-market-plan.md §3).
 */

describe("dashboard summary query schema", () => {
  it("accepts the 'all' market literal alongside two-letter codes", () => {
    expect(dashboardSummaryQuerySchema.parse({ country: "all" }).country).toBe(
      "all",
    );
    expect(dashboardSummaryQuerySchema.parse({ country: "ALL" }).country).toBe(
      "all",
    );
    expect(dashboardSummaryQuerySchema.parse({ country: "de" }).country).toBe(
      "DE",
    );
    expect(dashboardSummaryQuerySchema.parse({}).country).toBe("US");
    expect(() =>
      dashboardSummaryQuerySchema.parse({ country: "alll" }),
    ).toThrow();
    expect(() =>
      dashboardSummaryQuerySchema.parse({ country: "USA" }),
    ).toThrow();
  });

  it("validates the optional display currency as ISO 4217", () => {
    expect(
      dashboardSummaryQuerySchema.parse({ country: "all", currency: "EUR" })
        .currency,
    ).toBe("EUR");
    expect(dashboardSummaryQuerySchema.parse({}).currency).toBeUndefined();
    expect(() =>
      dashboardSummaryQuerySchema.parse({ currency: "US1" }),
    ).toThrow();
    expect(() =>
      dashboardSummaryQuerySchema.parse({ currency: "us" }),
    ).toThrow();
  });

  it("parses the shared days and books params", () => {
    const query = dashboardSummaryQuerySchema.parse({
      days: "7",
      books: "7, 9,,",
    });
    expect(query.days).toBe(7);
    expect(query.books).toEqual(["7", "9"]);
    expect(dashboardSummaryQuerySchema.parse({}).books).toBeUndefined();
    expect(dashboardSummaryQuerySchema.parse({ days: "mtd" }).days).toBe("mtd");
  });
});

describe("country spend query schema", () => {
  it("carries an optional conversion currency", () => {
    expect(countrySpendQuerySchema.parse({}).currency).toBeUndefined();
    expect(countrySpendQuerySchema.parse({ currency: "GBP" }).currency).toBe(
      "GBP",
    );
    expect(() => countrySpendQuerySchema.parse({ currency: "GB" })).toThrow();
  });
});

describe("dashboard summary response schema", () => {
  const totals = {
    impressions: 0,
    clicks: 0,
    cost: "0.0000",
    sales: "0.0000",
    orders: 0,
    units: 0,
    acos: null,
    estimatedRoyalty: null,
    estimatedAdProfit: null,
  };
  const summary = {
    dateRange: { start: "2026-08-01", end: "2026-08-15" },
    currency: "GBP",
    totals,
    previous: {
      dateRange: { start: "2026-07-02", end: "2026-07-16" },
      totals,
    },
    economicsMissing: true,
    dataCurrentThrough: "2026-08-15T00:00:00.000Z",
  };

  it("requires ratesAvailable so the client can gate the all-market option", () => {
    expect(
      dashboardSummarySchema.parse({ ...summary, ratesAvailable: true })
        .ratesAvailable,
    ).toBe(true);
    expect(() => dashboardSummarySchema.parse(summary)).toThrow();
  });
});

describe("country spend response schema", () => {
  it("allows converted totals next to native ones", () => {
    const parsed = countrySpendSchema.parse({
      dateRange: { start: "2026-08-01", end: "2026-08-15" },
      currency: "GBP",
      countries: [
        {
          countryCode: "DE",
          currency: "EUR",
          spend: "10.0000",
          convertedSpend: "6.2500",
        },
        {
          countryCode: "JP",
          currency: "JPY",
          spend: "100",
          convertedSpend: null,
        },
      ],
    });
    expect(parsed.countries[1]!.convertedSpend).toBeNull();
  });

  it("still validates the pre-conversion shape without the new fields", () => {
    const parsed = countrySpendSchema.parse({
      dateRange: { start: "2026-08-01", end: "2026-08-15" },
      countries: [{ countryCode: "US", currency: "USD", spend: "5.0000" }],
    });
    expect(parsed.currency).toBeUndefined();
    expect(parsed.countries[0]!.convertedSpend).toBeUndefined();
  });
});

describe("data freshness response schema", () => {
  const fxRates = {
    latestRateDate: "2026-08-14",
    lastRunState: "succeeded",
    lastRunAt: "2026-08-14T17:01:00.000Z",
    lastError: null,
    stale: false,
  };

  it("wraps per-profile freshness with the workspace FX status", () => {
    const parsed = dataFreshnessResponseSchema.parse({
      profiles: [
        {
          profileId: "amz-1",
          dataset: "metrics",
          lastSuccessAt: "2026-08-14T05:00:00.000Z",
          completeThrough: "2026-08-13",
        },
      ],
      fxRates,
    });
    expect(parsed.fxRates.lastRunState).toBe("succeeded");
    expect(parsed.profiles).toHaveLength(1);
  });

  it("accepts the never-run and failed states", () => {
    const neverRun = dataFreshnessResponseSchema.parse({
      profiles: [],
      fxRates: {
        latestRateDate: null,
        lastRunState: "never_run",
        lastRunAt: null,
        lastError: null,
        stale: true,
      },
    });
    expect(neverRun.fxRates.latestRateDate).toBeNull();

    const failed = dataFreshnessResponseSchema.parse({
      profiles: [],
      fxRates: {
        latestRateDate: "2026-08-13",
        lastRunState: "failed",
        lastRunAt: "2026-08-14T17:01:00.000Z",
        lastError: "Frankfurter rates request failed: HTTP 502",
        stale: true,
      },
    });
    expect(failed.fxRates.lastError).toContain("HTTP 502");

    expect(() =>
      dataFreshnessResponseSchema.parse({
        profiles: [],
        fxRates: { ...fxRates, lastRunState: "done" },
      }),
    ).toThrow();
  });
});

describe("fx sync result schema", () => {
  it("is the freshness FX status plus the queued flag", () => {
    const parsed = fxSyncResultSchema.parse({
      latestRateDate: "2026-08-14",
      lastRunState: "succeeded",
      lastRunAt: "2026-08-14T17:01:00.000Z",
      lastError: null,
      stale: false,
      queued: true,
    });
    expect(parsed.queued).toBe(true);

    const deduped = fxSyncResultSchema.parse({
      latestRateDate: null,
      lastRunState: "never_run",
      lastRunAt: null,
      lastError: null,
      stale: true,
      queued: false,
    });
    expect(deduped.lastRunState).toBe("never_run");

    expect(() =>
      fxSyncResultSchema.parse({
        latestRateDate: null,
        lastRunState: "never_run",
        lastRunAt: null,
        lastError: null,
        stale: true,
      }),
    ).toThrow();
  });
});

describe("workspace settings update schema", () => {
  it("accepts a valid display currency and rejects bad codes", () => {
    expect(
      workspaceSettingsUpdateSchema.parse({ displayCurrency: "EUR" })
        .displayCurrency,
    ).toBe("EUR");
    expect(() =>
      workspaceSettingsUpdateSchema.parse({ displayCurrency: "eur" }),
    ).toThrow();
    expect(() => workspaceSettingsUpdateSchema.parse({})).toThrow();
  });
});
