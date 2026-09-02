import { describe, expect, it } from "vitest";
import type { ReadServiceConfig as ApiConfig } from "./types.js";
import { createReadService } from "./read.js";
import { FakeDb } from "@amazon-king/database/testing";

/**
 * KDP daily profit (GET /api/kdp/daily-profit): one month of per-day
 * profitability — real KDP royalty per royalty posting date next to the
 * estimated
 * ad-attributed royalty and the ad spend, all markets converted per day into
 * the display currency. Runs the real read service against the
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
  return { db, service };
}

/** One linked US book with economics and an ad, for the estimated ad royalty. */
function seedUsBook(db: FakeDb): void {
  db.seedBook({ id: "7", workspace_id: "1", title: "Tractor" });
  db.seedBookProfileLink({
    book_id: "7",
    profile_id: "profile-us",
    marketplace_asin: "B0TRCUS001",
  });
  db.seedBookEconomics({
    book_id: "7",
    profile_id: "profile-us",
    effective_from: "2026-01-01",
    currency: "USD",
    estimated_royalty_per_sale: "3.4000",
  });
  db.seedAd({
    id: "a1",
    profile_id: "profile-us",
    amazon_ad_id: "ad-1",
    asin: "B0TRCUS001",
  });
}

/** Friday EUR fixing (USD pivot); weekend dates fall back to it. */
function seedEurRate(db: FakeDb): void {
  db.seedFxRate({
    rate_date: "2026-08-14",
    quote_currency: "EUR",
    rate: "0.8000",
  });
}

function dayOf(
  result: Awaited<
    ReturnType<ReturnType<typeof setup>["service"]["kdpDailyProfit"]>
  >,
  date: string,
) {
  const day = result.daily.find((entry) => entry.date === date);
  expect(day, `day ${date}`).toBeDefined();
  return day!;
}

describe("kdp daily profit", () => {
  it("merges ad spend, estimated ad royalty, and real KDP royalty per day", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    // 2026-08-14 (US): 10 USD spend; 2 copies x 3.40 = 6.80 estimated ad
    // royalty; 8.00 real KDP royalty → organic 1.20, profit −2.00.
    db.seedCampaignMetric({
      profile_id: "profile-us",
      metric_date: "2026-08-14",
      cost: "10.0000",
    });
    db.seedAdvertisedProductMetric({
      profile_id: "profile-us",
      ad_id: "ad-1",
      metric_date: "2026-08-14",
      units_sold_clicks14d: 2,
      purchases14d: 1,
    });
    db.seedKdpSaleTransaction({
      book_id: "7",
      profile_id: "profile-us",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "5.00",
    });
    db.seedKdpSaleTransaction({
      book_id: "7",
      profile_id: "profile-us",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "3.00",
    });
    // 2026-08-15 (DE): 10 EUR spend → 12.50 USD at Friday's fixing; an
    // unlinked-ASIN 8 EUR sale (real money, no book filter) → 10.00 USD;
    // no ad facts → ad royalty is a real zero, organic the full 10.00.
    db.seedCampaignMetric({
      profile_id: "profile-de",
      metric_date: "2026-08-15",
      cost: "10.0000",
      currency: "EUR",
    });
    db.seedKdpSaleTransaction({
      book_id: null,
      profile_id: null,
      marketplace: "Amazon.de",
      order_date: "2026-08-14",
      royalty_date: "2026-08-15",
      royalty: "8.00",
      currency: "EUR",
    });

    const result = await service.kdpDailyProfit("1", { month: "2026-08-01" });

    expect(result.month).toBe("2026-08-01");
    expect(result.currency).toBe("USD");
    expect(result.ratesAvailable).toBe(true);
    expect(result.economicsMissing).toBe(false);
    expect(result.kdpImported).toBe(true);
    // Current month is capped at today (the 15th), zero-filled from the 1st.
    expect(result.daily).toHaveLength(15);
    expect(dayOf(result, "2026-08-14")).toEqual({
      date: "2026-08-14",
      adSpend: "10.0000",
      adRoyalty: "6.8000",
      organicRoyalty: "1.2000",
      totalRoyalty: "8.0000",
      profit: "-2.0000",
    });
    expect(dayOf(result, "2026-08-15")).toEqual({
      date: "2026-08-15",
      adSpend: "12.5000",
      adRoyalty: "0.0000",
      organicRoyalty: "10.0000",
      totalRoyalty: "10.0000",
      profit: "-2.5000",
    });
    expect(dayOf(result, "2026-08-01")).toEqual({
      date: "2026-08-01",
      adSpend: "0.0000",
      adRoyalty: "0.0000",
      organicRoyalty: "0.0000",
      totalRoyalty: "0.0000",
      profit: "0.0000",
    });
  });

  it("clamps organic at zero when the ad estimate exceeds the KDP total", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    db.seedAdvertisedProductMetric({
      profile_id: "profile-us",
      ad_id: "ad-1",
      metric_date: "2026-08-14",
      units_sold_clicks14d: 3,
      purchases14d: 2,
    });
    db.seedKdpSaleTransaction({
      book_id: "7",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "8.00",
    });

    const result = await service.kdpDailyProfit("1", { month: "2026-08-01" });

    // Ad estimate 3 × 3.40 = 10.20 > 8.00 real — attribution windows never
    // align perfectly, so organic clamps to zero like the sales-mix chart.
    expect(dayOf(result, "2026-08-14")).toMatchObject({
      adRoyalty: "10.2000",
      organicRoyalty: "0.0000",
      totalRoyalty: "8.0000",
      profit: "8.0000",
    });
  });

  it("buckets royalty by posting date, not order date — like the KDP dashboard", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    // Ordered in July, royalty posted in August: KDP's own reports and the
    // import period label this an August sale, so the chart must too.
    db.seedKdpSaleTransaction({
      book_id: "7",
      profile_id: "profile-us",
      order_date: "2026-07-31",
      royalty_date: "2026-08-02",
      royalty: "3.43",
    });

    const august = await service.kdpDailyProfit("1", { month: "2026-08-01" });
    expect(august.kdpImported).toBe(true);
    expect(dayOf(august, "2026-08-02")).toMatchObject({
      totalRoyalty: "3.4300",
      organicRoyalty: "3.4300",
      profit: "3.4300",
    });

    // July has no posted royalties, so it reads as never imported.
    const july = await service.kdpDailyProfit("1", { month: "2026-07-01" });
    expect(july.kdpImported).toBe(false);
    expect(dayOf(july, "2026-07-31").totalRoyalty).toBeNull();
  });

  it("reports an unimported month with null KDP figures", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    db.seedCampaignMetric({
      profile_id: "profile-us",
      metric_date: "2026-07-10",
      cost: "4.0000",
    });

    const result = await service.kdpDailyProfit("1", { month: "2026-07-01" });

    expect(result.kdpImported).toBe(false);
    // A past month is returned in full.
    expect(result.daily).toHaveLength(31);
    expect(dayOf(result, "2026-07-10")).toEqual({
      date: "2026-07-10",
      adSpend: "4.0000",
      adRoyalty: "0.0000",
      organicRoyalty: null,
      totalRoyalty: null,
      profit: null,
    });
  });

  it("hides the ad/organic split when economics are missing but keeps real profit", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    // A DE ad with a linked book but no economics row for the marketplace.
    db.seedBookProfileLink({
      book_id: "7",
      profile_id: "profile-de",
      marketplace_asin: "B0TRCDE001",
    });
    db.seedAd({
      id: "a2",
      profile_id: "profile-de",
      amazon_ad_id: "ad-de",
      asin: "B0TRCDE001",
    });
    db.seedAdvertisedProductMetric({
      profile_id: "profile-de",
      ad_id: "ad-de",
      metric_date: "2026-08-14",
      units_sold_clicks14d: 0,
      purchases14d: 1,
      currency: "EUR",
    });
    db.seedCampaignMetric({
      profile_id: "profile-de",
      metric_date: "2026-08-14",
      cost: "4.0000",
      currency: "EUR",
    });
    db.seedKdpSaleTransaction({
      book_id: "7",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "6.00",
    });

    const result = await service.kdpDailyProfit("1", { month: "2026-08-01" });

    expect(result.economicsMissing).toBe(true);
    expect(dayOf(result, "2026-08-14")).toEqual({
      date: "2026-08-14",
      adSpend: "5.0000",
      adRoyalty: null,
      organicRoyalty: null,
      totalRoyalty: "6.0000",
      profit: "1.0000",
    });
  });

  it("filters the KDP side and the ad side by book", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    seedEurRate(db);
    db.seedBook({ id: "8", workspace_id: "1", title: "Other" });
    db.seedKdpSaleTransaction({
      book_id: "7",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "5.00",
    });
    db.seedKdpSaleTransaction({
      book_id: "8",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "3.00",
    });
    db.seedKdpSaleTransaction({
      book_id: null,
      profile_id: null,
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "2.00",
    });

    const all = await service.kdpDailyProfit("1", { month: "2026-08-01" });
    expect(dayOf(all, "2026-08-14").totalRoyalty).toBe("10.0000");

    const filtered = await service.kdpDailyProfit("1", {
      month: "2026-08-01",
      book: "7",
    });
    expect(dayOf(filtered, "2026-08-14").totalRoyalty).toBe("5.0000");

    await expect(
      service.kdpDailyProfit("1", { month: "2026-08-01", book: "999" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns ratesAvailable false with an empty series when fx_rates is empty", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    db.seedKdpSaleTransaction({
      book_id: "7",
      order_date: "2026-08-13",
      royalty_date: "2026-08-14",
      royalty: "5.00",
    });

    const result = await service.kdpDailyProfit("1", { month: "2026-08-01" });

    expect(result.ratesAvailable).toBe(false);
    expect(result.daily).toEqual([]);
  });

  it("throws FX_RATES_INCOMPLETE when a fact day lacks a covering fixing", async () => {
    const { db, service } = setup();
    seedUsBook(db);
    // Rates start on the 14th; an EUR fact on the 1st has no fixing.
    seedEurRate(db);
    db.seedCampaignMetric({
      profile_id: "profile-de",
      metric_date: "2026-08-01",
      cost: "10.0000",
      currency: "EUR",
    });

    await expect(
      service.kdpDailyProfit("1", { month: "2026-08-01" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "FX_RATES_INCOMPLETE" });
  });
});
