import { describe, expect, it } from "vitest";
import type { ReadServiceConfig as ApiConfig } from "./types.js";
import { createReadService } from "./read.js";
import { FakeDb } from "@amazon-king/database/testing";

/**
 * Spend explorer reads (GET /api/spend/breakdown and /api/spend/tree): grain
 * aggregation, top-12 + other bucketing, previous-window spend, single-country
 * native currency vs. the converted all-market view, FX guardrails, and the
 * two-level treemap hierarchy. Runs the real read service against the
 * SQL-matching FakeDb.
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
  const service = createReadService({
    db: db as never,
    config: { killSwitch: false } as ApiConfig,
    logger: {} as never,
    now: () => now,
  });
  return { db, service, connection };
}

function setupTwoMarkets(now: Date = NOW) {
  const { db, service, connection } = setup(now);
  db.seedProfile({
    id: "profile-de",
    connection_id: connection.id,
    profile_id: "amazon-de",
    region: "EU",
    country_code: "DE",
    currency_code: "EUR",
  });
  return { db, service };
}

function seedCampaign(db: FakeDb, profilePk: string, id: string, name: string) {
  db.seedCampaign({
    id: `pk-${id}`,
    profile_id: profilePk,
    amazon_campaign_id: id,
    name,
  });
}

/** 7-day window 2026-08-09..15 (one fact per day) with the given daily cost. */
function seedWeekFacts(
  db: FakeDb,
  campaignId: string,
  dailyCost: string,
  dailySales = "0.0000",
  dailyOrders = 0,
): void {
  for (let day = 9; day <= 15; day += 1) {
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: campaignId,
      metric_date: `2026-08-${String(day).padStart(2, "0")}`,
      cost: dailyCost,
      sales: dailySales,
      orders: dailyOrders,
      units: dailyOrders,
    });
  }
}

describe("spend breakdown by campaign, single country", () => {
  it("aggregates per campaign with previous-window spend and zero-filled daily", async () => {
    const { db, service } = setup();
    seedCampaign(db, "profile-us", "camp-1", "Night Harbor — exact");
    seedCampaign(db, "profile-us", "camp-2", "Paper Sun — auto");
    seedWeekFacts(db, "camp-1", "10.0000", "20.0000", 2);
    seedWeekFacts(db, "camp-2", "4.0000");
    // Previous window: only camp-1 spent (camp-2 is new).
    for (let day = 2; day <= 8; day += 1) {
      db.seedCampaignMetric({
        profile_id: "profile-us",
        campaign_id: "camp-1",
        metric_date: `2026-08-0${day}`,
        cost: "5.0000",
        sales: "10.0000",
        orders: 1,
      });
    }

    const result = await service.spendBreakdown("1", "campaign", 7, "US");

    expect(result.grain).toBe("campaign");
    expect(result.dateRange).toEqual({
      start: "2026-08-09",
      end: "2026-08-15",
    });
    expect(result.previousDateRange).toEqual({
      start: "2026-08-02",
      end: "2026-08-08",
    });
    expect(result.currency).toBe("USD");
    expect(result.totals).toEqual({
      spend: "98.0000",
      sales: "140.0000",
      previousSpend: "35.0000",
    });
    expect(result.entities).toHaveLength(2);

    const [first, second] = result.entities;
    expect(first).toMatchObject({
      id: "camp-1",
      name: "Night Harbor — exact",
      spend: "70.0000",
      sales: "140.0000",
      orders: 14,
      acos: 0.5,
      previousSpend: "35.0000",
    });
    expect(first!.daily).toHaveLength(7);
    expect(first!.daily[0]).toEqual({
      date: "2026-08-09",
      spend: "10.0000",
    });
    // No sales → null ACoS (worst bucket), no previous spend → "0".
    expect(second).toMatchObject({
      id: "camp-2",
      name: "Paper Sun — auto",
      spend: "28.0000",
      acos: null,
      previousSpend: "0.0000",
    });

    expect(result.other.spend).toBe("0.0000");
    expect(result.other.daily).toHaveLength(7);
    expect(result.other.daily.every((point) => point.spend === "0.0000")).toBe(
      true,
    );
  });

  it("keeps the top 12 entities and folds the rest into other, per day too", async () => {
    const { db, service } = setup();
    // 14 campaigns spending 14..1 on the single day: the bottom two (2 + 1)
    // must land in `other`.
    for (let index = 1; index <= 14; index += 1) {
      const id = `camp-${String(index).padStart(2, "0")}`;
      seedCampaign(db, "profile-us", id, `Campaign ${index}`);
      db.seedCampaignMetric({
        profile_id: "profile-us",
        campaign_id: id,
        metric_date: "2026-08-14",
        cost: `${15 - index}.0000`,
      });
    }

    const result = await service.spendBreakdown("1", "campaign", 7, "US");

    expect(result.entities).toHaveLength(12);
    expect(result.entities[0]).toMatchObject({
      id: "camp-01",
      spend: "14.0000",
    });
    expect(result.entities.at(-1)).toMatchObject({
      id: "camp-12",
      spend: "3.0000",
    });
    expect(result.other.spend).toBe("3.0000");
    expect(result.other.daily.find((p) => p.date === "2026-08-14")).toEqual({
      date: "2026-08-14",
      spend: "3.0000",
    });
    expect(result.totals.spend).toBe("105.0000");
  });

  it("falls back to the campaign id when no campaign name is synced", async () => {
    const { db, service } = setup();
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: "camp-unsynced",
      metric_date: "2026-08-14",
      cost: "9.0000",
    });

    const result = await service.spendBreakdown("1", "campaign", 7, "US");

    expect(result.entities[0]).toMatchObject({
      id: "camp-unsynced",
      name: "camp-unsynced",
    });
  });
});

describe("spend breakdown by search term", () => {
  it("merges the same term across campaigns", async () => {
    const { db, service } = setup();
    seedCampaign(db, "profile-us", "camp-1", "One");
    seedCampaign(db, "profile-us", "camp-2", "Two");
    for (const [campaignId, cost] of [
      ["camp-1", "3.0000"],
      ["camp-2", "2.0000"],
    ] as const) {
      db.seedSearchTermMetric({
        profile_id: "profile-us",
        campaign_id: campaignId,
        search_term: "harbor mystery",
        metric_date: "2026-08-14",
        cost,
        sales: "10.0000",
        orders: 1,
      });
    }

    const result = await service.spendBreakdown("1", "searchTerm", 7, "US");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      id: "harbor mystery",
      name: "harbor mystery",
      spend: "5.0000",
      sales: "20.0000",
      orders: 2,
      acos: 0.25,
    });
    expect(
      result.entities[0]!.daily.find((p) => p.date === "2026-08-14")?.spend,
    ).toBe("5.0000");
  });
});

describe("spend breakdown, all markets", () => {
  it("returns zeroed figures with ratesAvailable false when no rates are stored", async () => {
    const { db, service } = setupTwoMarkets();
    db.seedCampaignMetric({
      profile_id: "profile-us",
      metric_date: "2026-08-14",
      cost: "10.0000",
    });

    const result = await service.spendBreakdown("1", "market", 7, "all");

    expect(result.ratesAvailable).toBe(false);
    expect(result.currency).toBe("USD");
    expect(result.entities).toEqual([]);
    expect(result.totals.spend).toBe("0.0000");
    expect(result.other.daily).toHaveLength(7);
  });

  it("converts every market per fact date into the display currency", async () => {
    const { db, service } = setupTwoMarkets();
    db.tables.workspaces[0]!.display_currency = "GBP";
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
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: "camp-1",
      metric_date: "2026-08-14",
      cost: "10.0000",
      sales: "40.0000",
      currency: "USD",
    });
    db.seedCampaignMetric({
      profile_id: "profile-de",
      campaign_id: "camp-2",
      metric_date: "2026-08-14",
      cost: "10.0000",
      sales: "20.0000",
      currency: "EUR",
    });

    // USD→GBP 0.5 → 5; EUR→GBP 0.5/0.8 = 0.625 → 6.25.
    const result = await service.spendBreakdown("1", "market", 7, "all");

    expect(result.ratesAvailable).toBe(true);
    expect(result.currency).toBe("GBP");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toMatchObject({
      id: "DE",
      spend: "6.2500",
      sales: "12.5000",
    });
    expect(result.entities[1]).toMatchObject({
      id: "US",
      spend: "5.0000",
      sales: "20.0000",
    });
    expect(result.totals.spend).toBe("11.2500");
  });

  it("rejects with FX_RATES_INCOMPLETE when a fact's date has no fixing", async () => {
    const { db, service } = setupTwoMarkets();
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
    // An EUR fact before the first stored fixing has no covering rate.
    db.seedCampaignMetric({
      profile_id: "profile-de",
      metric_date: "2026-08-10",
      cost: "10.0000",
      currency: "EUR",
    });

    await expect(
      service.spendBreakdown("1", "market", 7, "all", "GBP"),
    ).rejects.toMatchObject({ statusCode: 409, code: "FX_RATES_INCOMPLETE" });
  });
});

describe("spend tree", () => {
  it("builds campaign → search terms for a single country, capping children", async () => {
    const { db, service } = setup();
    seedCampaign(db, "profile-us", "camp-1", "Night Harbor — exact");
    seedCampaign(db, "profile-us", "camp-2", "Paper Sun — auto");
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: "camp-1",
      metric_date: "2026-08-14",
      cost: "20.0000",
      sales: "40.0000",
    });
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: "camp-2",
      metric_date: "2026-08-14",
      cost: "5.0000",
    });
    // 11 terms on camp-1: the top 10 stay, the rest folds into "Other".
    for (let index = 1; index <= 11; index += 1) {
      db.seedSearchTermMetric({
        profile_id: "profile-us",
        campaign_id: "camp-1",
        search_term: `term-${index}`,
        metric_date: "2026-08-14",
        cost: "1.0000",
      });
    }
    db.seedSearchTermMetric({
      profile_id: "profile-us",
      campaign_id: "camp-2",
      search_term: "paper sun",
      metric_date: "2026-08-14",
      cost: "4.0000",
      sales: "8.0000",
    });

    const result = await service.spendTree("1", 7, "US");

    expect(result.currency).toBe("USD");
    expect(result.roots).toHaveLength(2);
    const [first, second] = result.roots;
    expect(first).toMatchObject({
      id: "camp-1",
      name: "Night Harbor — exact",
      kind: "campaign",
      spend: "20.0000",
      sales: "40.0000",
      acos: 0.5,
    });
    expect(first!.children).toHaveLength(11);
    expect(first!.children[10]).toMatchObject({
      id: "other",
      name: "Other",
      kind: "searchTerm",
      spend: "1.0000",
    });
    expect(second).toMatchObject({
      id: "camp-2",
      kind: "campaign",
      spend: "5.0000",
      acos: null,
    });
    expect(second!.children).toHaveLength(1);
    expect(second!.children[0]).toMatchObject({
      id: "paper sun",
      kind: "searchTerm",
      acos: 0.5,
    });
  });

  it("synthesizes a parent for search-term facts without a campaign fact", async () => {
    const { db, service } = setup();
    db.seedSearchTermMetric({
      profile_id: "profile-us",
      campaign_id: "camp-lonely",
      search_term: "orphan term",
      metric_date: "2026-08-14",
      cost: "7.0000",
    });

    const result = await service.spendTree("1", 7, "US");

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).toMatchObject({
      id: "camp-lonely",
      name: "camp-lonely",
      kind: "campaign",
      spend: "7.0000",
    });
    expect(result.roots[0]!.children[0]).toMatchObject({
      id: "orphan term",
      spend: "7.0000",
    });
  });

  it("builds market → campaigns across all markets, converted", async () => {
    const { db, service } = setupTwoMarkets();
    db.tables.workspaces[0]!.display_currency = "GBP";
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
    seedCampaign(db, "profile-us", "camp-1", "US campaign");
    seedCampaign(db, "profile-de", "camp-2", "DE campaign");
    db.seedCampaignMetric({
      profile_id: "profile-us",
      campaign_id: "camp-1",
      metric_date: "2026-08-14",
      cost: "10.0000",
      sales: "40.0000",
      currency: "USD",
    });
    db.seedCampaignMetric({
      profile_id: "profile-de",
      campaign_id: "camp-2",
      metric_date: "2026-08-14",
      cost: "10.0000",
      currency: "EUR",
    });

    const result = await service.spendTree("1", 7, "all");

    expect(result.ratesAvailable).toBe(true);
    expect(result.currency).toBe("GBP");
    expect(result.roots).toHaveLength(2);
    // DE converts to 6.25 GBP and outranks the US market's 5.
    expect(result.roots[0]).toMatchObject({
      id: "DE",
      kind: "market",
      spend: "6.2500",
    });
    expect(result.roots[1]).toMatchObject({
      id: "US",
      kind: "market",
      spend: "5.0000",
    });
    expect(result.roots[1]!.children[0]).toMatchObject({
      id: "camp-1",
      name: "US campaign",
      kind: "campaign",
      spend: "5.0000",
      sales: "20.0000",
      acos: 0.25,
    });
  });

  it("returns empty roots with ratesAvailable false when no rates are stored", async () => {
    const { db, service } = setupTwoMarkets();
    db.seedCampaignMetric({
      profile_id: "profile-us",
      metric_date: "2026-08-14",
      cost: "10.0000",
    });

    const result = await service.spendTree("1", 7, "all");

    expect(result.ratesAvailable).toBe(false);
    expect(result.roots).toEqual([]);
  });
});
