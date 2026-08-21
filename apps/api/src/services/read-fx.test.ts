import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";
import { FakeDb } from "../test/fake-db.js";

/**
 * All-market dashboard view (docs/fx-rates-all-market-plan.md §4): summary
 * with country=all, converted country-spend, FX sync health in
 * data-freshness, and the display-currency workspace setting. Runs the real
 * read service against the SQL-matching FakeDb.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z"); // Saturday

function setup(now: Date = NOW) {
  const db = new FakeDb();
  db.seedWorkspace();
  db.seedUser("owner@example.com");
  const connection = db.seedConnection();
  db.seedProfile({
    id: "profile-us",
    connection_id: connection.id,
    profile_id: "amazon-us",
    country_code: "US",
    currency_code: "USD",
  });
  db.seedProfile({
    id: "profile-de",
    connection_id: connection.id,
    profile_id: "amazon-de",
    region: "EU",
    country_code: "DE",
    currency_code: "EUR",
  });
  const service = createReadService({
    db: db as never,
    config: { killSwitch: false } as ApiConfig,
    logger: {} as never,
    now: () => now,
  });
  return { db, service, connection };
}

/** Friday fixings (USD pivot); the weekend has none, by design. */
function seedFridayRates(db: FakeDb): void {
  // An older fixing with distinct values catches lookups that pick the
  // wrong date.
  db.seedFxRate({
    rate_date: "2026-08-13",
    quote_currency: "EUR",
    rate: "1.0000",
  });
  db.seedFxRate({
    rate_date: "2026-08-13",
    quote_currency: "GBP",
    rate: "1.0000",
  });
  db.seedFxRate({
    rate_date: "2026-08-14",
    quote_currency: "EUR",
    rate: "0.8000",
  });
  db.seedFxRate({
    rate_date: "2026-08-14",
    quote_currency: "GBP",
    rate: "0.5000",
  });
}

function seedTwoCurrencyFacts(db: FakeDb): void {
  for (const metricDate of ["2026-08-14", "2026-08-15"]) {
    db.seedCampaignMetric({
      profile_id: "profile-us",
      metric_date: metricDate,
      cost: "10.0000",
      sales: "40.0000",
      orders: 2,
      units: 2,
      currency: "USD",
    });
    db.seedCampaignMetric({
      profile_id: "profile-de",
      metric_date: metricDate,
      cost: "10.0000",
      sales: "20.0000",
      orders: 1,
      units: 1,
      currency: "EUR",
    });
  }
}

describe("dashboard summary with country=all", () => {
  it("converts every market per fact date into the display currency", async () => {
    const { db, service } = setup();
    db.tables.workspaces[0]!.display_currency = "GBP";
    seedFridayRates(db);
    seedTwoCurrencyFacts(db);

    // USD→GBP 0.5, so 10 USD → 5 GBP; EUR→GBP = 0.5/0.8 = 0.625, so
    // 10 EUR → 6.25 GBP. The Saturday fact converts at Friday's fixing.
    const result = await service.dashboardSummary("1", 7, "all");

    expect(result.currency).toBe("GBP");
    expect(result.ratesAvailable).toBe(true);
    expect(result.dateRange).toEqual({
      start: "2026-08-09",
      end: "2026-08-15",
    });
    expect(result.totals).toEqual({
      impressions: 40,
      clicks: 4,
      cost: "22.5000",
      sales: "65.0000",
      orders: 6,
      units: 6,
      acos: 22.5 / 65,
      estimatedRoyalty: null,
      estimatedAdProfit: null,
    });
    // The immediately preceding window has no facts.
    expect(result.previous.dateRange).toEqual({
      start: "2026-08-02",
      end: "2026-08-08",
    });
    expect(result.previous.totals.cost).toBe("0.0000");
    expect(result.economicsMissing).toBe(true);
    expect(result.dataCurrentThrough).toBe("2026-08-15T00:00:00.000Z");
    expect(result.daily).toEqual([
      {
        date: "2026-08-14",
        cost: "11.2500",
        sales: "32.5000",
        orders: 3,
        estimatedRoyalty: null,
      },
      {
        date: "2026-08-15",
        cost: "11.2500",
        sales: "32.5000",
        orders: 3,
        estimatedRoyalty: null,
      },
    ]);
  });

  it("converts royalty per copy with each book's own marketplace economics", async () => {
    const { db, service } = setup();
    db.tables.workspaces[0]!.display_currency = "GBP";
    seedFridayRates(db);
    db.seedBook({ id: "1" });
    db.seedAd({
      id: "ad-us",
      profile_id: "profile-us",
      amazon_ad_id: "amz-ad-us",
      asin: "B0BOOK0001",
    });
    db.seedAd({
      id: "ad-de",
      profile_id: "profile-de",
      amazon_ad_id: "amz-ad-de",
      asin: "B0BOOK0001",
    });
    db.seedBookProfileLink({
      book_id: "1",
      profile_id: "profile-us",
      marketplace_asin: "B0BOOK0001",
    });
    db.seedBookProfileLink({
      book_id: "1",
      profile_id: "profile-de",
      marketplace_asin: "B0BOOK0001",
    });
    db.seedBookEconomics({
      book_id: "1",
      profile_id: "profile-us",
      currency: "USD",
      estimated_royalty_per_sale: "7.0000",
    });
    db.seedBookEconomics({
      book_id: "1",
      profile_id: "profile-de",
      currency: "EUR",
      estimated_royalty_per_sale: "6.0000",
    });
    // One US order shipping two copies: two royalties (2 × 7 USD = 14 USD).
    db.seedAdvertisedProductMetric({
      profile_id: "profile-us",
      ad_id: "amz-ad-us",
      metric_date: "2026-08-14",
      orders: 1,
      units: 2,
      currency: "USD",
    });
    // Three DE orders imported before units existed: degrades to orders
    // (3 × 6 EUR = 18 EUR).
    db.seedAdvertisedProductMetric({
      profile_id: "profile-de",
      ad_id: "amz-ad-de",
      metric_date: "2026-08-14",
      orders: 3,
      units: 0,
      currency: "EUR",
    });

    const result = await service.dashboardSummary("1", 7, "all");

    // 14 USD × 0.5 = 7 GBP; 18 EUR × 0.625 = 11.25 GBP.
    expect(result.totals.estimatedRoyalty).toBe("18.2500");
    expect(result.totals.estimatedAdProfit).toBe("18.2500");
    expect(result.economicsMissing).toBe(false);
  });

  it("defaults the display currency from the workspace and honors an explicit override", async () => {
    const { db, service } = setup();
    db.tables.workspaces[0]!.display_currency = "EUR";
    seedFridayRates(db);
    seedTwoCurrencyFacts(db);

    // Display EUR: 10 USD → 8 EUR; 10 EUR → 10 EUR. Per day 18, two days 36.
    const fromWorkspace = await service.dashboardSummary("1", 7, "all");
    expect(fromWorkspace.currency).toBe("EUR");
    expect(fromWorkspace.totals.cost).toBe("36.0000");

    const override = await service.dashboardSummary(
      "1",
      7,
      "all",
      undefined,
      "GBP",
    );
    expect(override.currency).toBe("GBP");
    expect(override.totals.cost).toBe("22.5000");
  });

  it("returns ratesAvailable false and no fabricated totals when no rates are synced", async () => {
    const { db, service } = setup();
    db.tables.workspaces[0]!.display_currency = "GBP";
    seedTwoCurrencyFacts(db);

    const result = await service.dashboardSummary("1", 7, "all");

    expect(result.ratesAvailable).toBe(false);
    expect(result.currency).toBe("GBP");
    expect(result.totals.cost).toBe("0.0000");
    expect(result.totals.sales).toBe("0.0000");
    expect(result.totals.estimatedRoyalty).toBeNull();
    expect(result.previous.totals.cost).toBe("0.0000");
    expect(result.daily).toEqual([]);
    expect(result.economicsMissing).toBe(true);
  });

  it("rejects with 409 when stored rates do not cover the whole window", async () => {
    const { db, service } = setup();
    // EUR fixings exist, but none for the requested GBP display currency.
    db.seedFxRate({
      rate_date: "2026-08-14",
      quote_currency: "EUR",
      rate: "0.8000",
    });
    seedTwoCurrencyFacts(db);

    await expect(
      service.dashboardSummary("1", 7, "all", undefined, "GBP"),
    ).rejects.toMatchObject({ statusCode: 409, code: "FX_RATES_INCOMPLETE" });
  });
});

describe("dashboard country spend conversion", () => {
  it("adds converted totals next to native ones when a currency is requested", async () => {
    const { db, service, connection } = setup();
    seedFridayRates(db);
    seedTwoCurrencyFacts(db);
    // A market the stored rates do not cover at all.
    db.seedProfile({
      id: "profile-jp",
      connection_id: connection.id,
      profile_id: "amazon-jp",
      region: "FE",
      country_code: "JP",
      currency_code: "JPY",
    });
    db.seedCampaignMetric({
      profile_id: "profile-jp",
      metric_date: "2026-08-14",
      cost: "1000",
      currency: "JPY",
    });

    const result = await service.dashboardCountrySpend(
      "1",
      7,
      undefined,
      "GBP",
    );

    expect(result.currency).toBe("GBP");
    // Native ordering by spend desc: JP (1000) > US = DE (20).
    expect(result.countries).toEqual([
      {
        countryCode: "JP",
        currency: "JPY",
        spend: "1000.0000",
        convertedSpend: null,
      },
      {
        countryCode: "US",
        currency: "USD",
        spend: "20.0000",
        convertedSpend: "10.0000",
      },
      {
        countryCode: "DE",
        currency: "EUR",
        spend: "20.0000",
        convertedSpend: "12.5000",
      },
    ]);
  });

  it("omits converted fields when no currency is requested", async () => {
    const { db, service } = setup();
    seedTwoCurrencyFacts(db);

    const result = await service.dashboardCountrySpend("1", 7);

    expect(result.currency).toBeUndefined();
    expect(result.countries).toEqual([
      { countryCode: "US", currency: "USD", spend: "20.0000" },
      { countryCode: "DE", currency: "EUR", spend: "20.0000" },
    ]);
  });
});

describe("data freshness FX status", () => {
  it("reports never_run when fx_sync has never run and no rates exist", async () => {
    const { service } = setup();

    const result = await service.dataFreshness("1");

    expect(result.fxRates).toEqual({
      latestRateDate: null,
      lastRunState: "never_run",
      lastRunAt: null,
      lastError: null,
      stale: true,
    });
    // Per-profile freshness is still present.
    expect(result.profiles).toHaveLength(4);
  });

  it("reports a successful run and fresh rates", async () => {
    const { db, service } = setup();
    db.seedFxRate({ rate_date: "2026-08-14", quote_currency: "EUR" });
    db.tables.jobQueue.push({
      id: "job-1",
      type: "fx_sync",
      payload: {},
      status: "done",
      attempts: 1,
      finished_at: new Date("2026-08-14T17:01:00.000Z"),
      last_error: null,
    });

    const result = await service.dataFreshness("1");

    expect(result.fxRates).toEqual({
      latestRateDate: "2026-08-14",
      lastRunState: "succeeded",
      lastRunAt: "2026-08-14T17:01:00.000Z",
      lastError: null,
      stale: false,
    });
  });

  it("reports a failed run with its error", async () => {
    const { db, service } = setup();
    db.seedFxRate({ rate_date: "2026-08-13", quote_currency: "EUR" });
    db.tables.jobQueue.push({
      id: "job-1",
      type: "fx_sync",
      payload: {},
      status: "dead",
      attempts: 5,
      finished_at: new Date("2026-08-14T17:01:00.000Z"),
      last_error: "Frankfurter rates request failed: HTTP 502",
    });

    const result = await service.dataFreshness("1");

    expect(result.fxRates.lastRunState).toBe("failed");
    expect(result.fxRates.lastError).toBe(
      "Frankfurter rates request failed: HTTP 502",
    );
    expect(result.fxRates.lastRunAt).toBe("2026-08-14T17:01:00.000Z");
    // Friday's fixing is a day short on Saturday: stale.
    expect(result.fxRates.stale).toBe(true);
  });

  it("treats a Friday fixing as fresh through the weekend and Monday", async () => {
    const { db } = setup();
    db.seedFxRate({ rate_date: "2026-08-14", quote_currency: "EUR" });

    for (const [now, stale] of [
      [new Date("2026-08-15T12:00:00.000Z"), false], // Saturday
      [new Date("2026-08-16T12:00:00.000Z"), false], // Sunday
      [new Date("2026-08-17T12:00:00.000Z"), false], // Monday
      [new Date("2026-08-18T12:00:00.000Z"), true], // Tuesday: Monday's missing
    ] as const) {
      const service = createReadService({
        db: db as never,
        config: { killSwitch: false } as ApiConfig,
        logger: {} as never,
        now: () => now,
      });
      const result = await service.dataFreshness("1");
      expect(result.fxRates.stale).toBe(stale);
    }
  });
});

describe("manual FX sync request", () => {
  const AUTH = {
    sessionId: "session-1",
    userId: "1",
    workspaceId: "1",
    email: "owner@example.com",
    sessionTokenHash: "hash-1",
    sessionCreatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  const META = { ip: "127.0.0.1", userAgent: "vitest" };

  it("enqueues one fx_sync job, audits it, and returns the current status", async () => {
    const { db, service } = setup();
    db.seedFxRate({ rate_date: "2026-08-14", quote_currency: "EUR" });

    const result = await service.requestFxSync(AUTH, META);

    expect(result.queued).toBe(true);
    expect(result.latestRateDate).toBe("2026-08-14");
    expect(result.stale).toBe(false);
    // A freshly enqueued pending job (attempts = 0) does not count as a run,
    // exactly like the freshness endpoint reads it.
    expect(result.lastRunState).toBe("never_run");
    expect(result.lastRunAt).toBeNull();
    const jobs = db.tables.jobQueue.filter((j) => j.type === "fx_sync");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: {}, status: "pending" });
    const event = db.tables.auditEvents.find(
      (row) => row.event === "fx_sync.request",
    );
    expect(event).toMatchObject({
      workspace_id: "1",
      actor_user_id: "1",
      entity_type: "job_queue",
      entity_id: jobs[0]!.id,
      ip: "127.0.0.1",
      session_id: "session-1",
    });
  });

  it("dedupes against a pending fx_sync job instead of stacking duplicates", async () => {
    const { db, service } = setup();

    const first = await service.requestFxSync(AUTH, META);
    const second = await service.requestFxSync(AUTH, META);

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(db.tables.jobQueue.filter((j) => j.type === "fx_sync")).toHaveLength(
      1,
    );
    // Both requests are audited; the deduped one has no job id.
    const events = db.tables.auditEvents.filter(
      (row) => row.event === "fx_sync.request",
    );
    expect(events).toHaveLength(2);
    expect(events[1]!.entity_id).toBeNull();
  });

  it("dedupes against a running fx_sync job and reports it as running", async () => {
    const { db, service } = setup();
    db.tables.jobQueue.push({
      id: "job-1",
      type: "fx_sync",
      payload: {},
      status: "running",
      attempts: 1,
      heartbeat_at: new Date("2026-08-15T11:59:00.000Z"),
      last_error: null,
    });

    const result = await service.requestFxSync(AUTH, META);

    expect(result.queued).toBe(false);
    expect(result.lastRunState).toBe("running");
    expect(db.tables.jobQueue.filter((j) => j.type === "fx_sync")).toHaveLength(
      1,
    );
  });

  it("enqueues again once the previous run finished", async () => {
    const { db, service } = setup();
    db.tables.jobQueue.push({
      id: "job-1",
      type: "fx_sync",
      payload: {},
      status: "done",
      attempts: 1,
      finished_at: new Date("2026-08-14T17:01:00.000Z"),
      last_error: null,
    });

    const result = await service.requestFxSync(AUTH, META);

    expect(result.queued).toBe(true);
    expect(result.lastRunState).toBe("succeeded");
    expect(db.tables.jobQueue.filter((j) => j.type === "fx_sync")).toHaveLength(
      2,
    );
  });
});

describe("workspace display currency setting", () => {
  it("updates the workspace row and writes an audit event", async () => {
    const { db, service } = setup();

    const result = await service.updateWorkspaceSettings(
      {
        sessionId: "session-1",
        userId: "1",
        workspaceId: "1",
        email: "owner@example.com",
        sessionTokenHash: "hash-1",
        sessionCreatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      { displayCurrency: "EUR" },
      { ip: "127.0.0.1", userAgent: "vitest" },
    );

    expect(result).toEqual({ displayCurrency: "EUR" });
    expect(db.tables.workspaces[0]!.display_currency).toBe("EUR");
    const auditEvent = db.tables.auditEvents.find(
      (row) => row.event === "workspace.settings_update",
    );
    expect(auditEvent).toMatchObject({
      workspace_id: "1",
      entity_type: "workspace",
      details: { displayCurrency: "EUR" },
    });
  });
});
