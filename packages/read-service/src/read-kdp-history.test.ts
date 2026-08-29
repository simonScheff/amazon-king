import { describe, expect, it } from "vitest";
import { FakeDb } from "@amazon-king/database/testing";
import {
  kdpHistorySchema,
  kdpTransactionsPageSchema,
} from "@amazon-king/contracts";
import { createReadService } from "./read.js";
import type {
  AuthContext,
  ReadServiceConfig,
  ReadServiceLogger,
} from "./types.js";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "1",
  email: "owner@example.com",
  sessionTokenHash: "hash",
  sessionCreatedAt: new Date("2026-08-27T00:00:00Z"),
  expiresAt: new Date("2026-08-28T00:00:00Z"),
};

function makeService(db: FakeDb) {
  return createReadService({
    db: db as never,
    config: {} as ReadServiceConfig,
    logger: {} as ReadServiceLogger,
  });
}

/** Workspace 1: two profiles, one linked book with economics history. */
function seedCatalog(db: FakeDb) {
  db.seedWorkspace("1");
  db.seedConnection({ id: "c1", workspace_id: "1" });
  db.seedProfile({
    id: "p1",
    connection_id: "c1",
    profile_id: "amz-us",
    country_code: "US",
    currency_code: "USD",
  });
  db.seedProfile({
    id: "p2",
    connection_id: "c1",
    profile_id: "amz-uk",
    country_code: "UK",
    currency_code: "GBP",
  });
  db.seedBook({
    id: "b1",
    workspace_id: "1",
    title: "Tractor",
    cover_json: { imageUrl: "https://example.com/tractor.png" },
  });
  db.seedBookProfileLink({
    book_id: "b1",
    profile_id: "p1",
    marketplace_asin: "B0TRCUS001",
  });
  db.seedBookEconomics({
    book_id: "b1",
    profile_id: "p1",
    effective_from: "2026-01-01",
    estimated_royalty_per_sale: "3.4000",
  });
  db.seedBookEconomics({
    book_id: "b1",
    profile_id: "p1",
    effective_from: "2026-08-15",
    estimated_royalty_per_sale: "3.6000",
  });
  // Ads facts for the ad-side of the sales mix.
  db.seedAd({
    id: "a1",
    profile_id: "p1",
    amazon_ad_id: "ad-1",
    asin: "B0TRCUS001",
  });
}

describe("kdp history", () => {
  it("returns per-book monthly series with ad units and effective-dated royalty", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    // July: two standard sales. August: three standard sales — one ordered
    // July 31, counted in its royalty month like the KDP dashboard does —
    // plus one expanded-distribution sale.
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      order_date: "2026-07-10",
      royalty_date: "2026-07-13",
    });
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      order_date: "2026-07-12",
      royalty_date: "2026-07-15",
    });
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      order_date: "2026-07-31",
      royalty_date: "2026-08-02",
    });
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      order_date: "2026-08-10",
      royalty_date: "2026-08-13",
    });
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      order_date: "2026-08-12",
      royalty_date: "2026-08-15",
    });
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
      royalty_type: "40%",
      transaction_type: "Expanded Distribution Channels",
      order_date: "2026-08-11",
      royalty_date: "2026-08-20",
    });
    // August ad facts: 2 copies (units win) + 3 copies (units 0 → orders).
    db.seedAdvertisedProductMetric({
      profile_id: "p1",
      ad_id: "ad-1",
      metric_date: "2026-08-03",
      units_sold_clicks14d: 2,
      purchases14d: 1,
    });
    db.seedAdvertisedProductMetric({
      profile_id: "p1",
      ad_id: "ad-1",
      metric_date: "2026-08-20",
      units_sold_clicks14d: 0,
      purchases14d: 3,
    });
    // September has ad units but no KDP import: the month still shows.
    db.seedAdvertisedProductMetric({
      profile_id: "p1",
      ad_id: "ad-1",
      metric_date: "2026-09-02",
      units_sold_clicks14d: 1,
      purchases14d: 1,
    });
    const service = makeService(db);

    const history = await service.getKdpHistory("1");

    expect(kdpHistorySchema.parse(history)).toBeTruthy();
    expect(history.series).toHaveLength(1);
    const series = history.series[0]!;
    expect(series).toMatchObject({
      bookId: "b1",
      title: "Tractor",
      profileId: "amz-us",
      countryCode: "US",
      currency: "USD",
      coverImageUrl: "https://example.com/tractor.png",
    });
    expect(series.months).toEqual([
      {
        month: "2026-07-01",
        kdpStandardUnits: 2,
        kdpExpandedUnits: 0,
        adUnits: 0,
        royaltyPerSale: "3.4000",
      },
      {
        month: "2026-08-01",
        kdpStandardUnits: 3,
        kdpExpandedUnits: 1,
        adUnits: 5,
        // The 2026-08-15 economics row is in effect at the end of August.
        royaltyPerSale: "3.6000",
      },
      {
        month: "2026-09-01",
        kdpStandardUnits: 0,
        kdpExpandedUnits: 0,
        adUnits: 1,
        royaltyPerSale: "3.6000",
      },
    ]);
  });

  it("returns null royaltyPerSale for months no economics row covered", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    db.tables.bookEconomics.splice(0); // no economics at all
    db.seedKdpSaleTransaction({
      book_id: "b1",
      profile_id: "p1",
    });
    const service = makeService(db);

    const history = await service.getKdpHistory("1");

    expect(history.series[0]!.months[0]!.royaltyPerSale).toBeNull();
  });

  it("returns fulfillment stats per marketplace, standard-rate rows only", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    // Standard rows with lags 1 and 2 days (median 1.5).
    db.seedKdpSaleTransaction({
      profile_id: "p1",
      order_date: "2026-08-10",
      royalty_date: "2026-08-11",
    });
    db.seedKdpSaleTransaction({
      profile_id: "p1",
      order_date: "2026-08-12",
      royalty_date: "2026-08-14",
    });
    // Expanded distribution: excluded (a third party prints those).
    db.seedKdpSaleTransaction({
      profile_id: "p1",
      royalty_type: "40%",
      transaction_type: "Expanded Distribution Channels",
      order_date: "2026-08-10",
      royalty_date: "2026-08-30",
    });
    // Unlinked row: no profile to attribute to.
    db.seedKdpSaleTransaction({
      book_id: null,
      profile_id: null,
      order_date: "2026-08-10",
      royalty_date: "2026-08-11",
    });
    const service = makeService(db);

    const history = await service.getKdpHistory("1");

    expect(history.fulfillment).toEqual([
      {
        profileId: "amz-us",
        countryCode: "US",
        months: [
          {
            month: "2026-08-01",
            medianDays: 1.5,
            averageDays: 1.5,
            standardUnits: 2,
          },
        ],
      },
    ]);
  });

  it("returns empty series and fulfillment when nothing was imported", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const history = await service.getKdpHistory("1");

    expect(history).toEqual({ series: [], fulfillment: [] });
  });

  it("never leaks another workspace's history", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    // A second workspace with its own book/profile/history.
    db.seedWorkspace("2");
    db.seedConnection({ id: "c2", workspace_id: "2" });
    db.seedProfile({
      id: "p9",
      connection_id: "c2",
      profile_id: "amz-other",
      country_code: "US",
      currency_code: "USD",
    });
    db.seedBook({ id: "b9", workspace_id: "2", title: "Other book" });
    db.seedBookProfileLink({
      book_id: "b9",
      profile_id: "p9",
      marketplace_asin: "B0OTHER001",
    });
    db.seedKdpSaleTransaction({
      workspace_id: "2",
      book_id: "b9",
      profile_id: "p9",
    });
    db.seedAdvertisedProductMetric({
      profile_id: "p9",
      ad_id: "ad-9",
      units_sold_clicks14d: 4,
      purchases14d: 4,
    });
    db.seedAd({
      id: "a9",
      profile_id: "p9",
      amazon_ad_id: "ad-9",
      asin: "B0OTHER001",
    });
    const service = makeService(db);

    const history = await service.getKdpHistory("1");

    expect(history).toEqual({ series: [], fulfillment: [] });
  });
});

describe("kdp transactions", () => {
  function seedTransactions(db: FakeDb) {
    db.seedKdpSaleTransaction({
      id: "t1",
      book_id: "b1",
      profile_id: "p1",
      asin: "B0TRCUS001",
      order_date: "2026-08-20",
      royalty_date: "2026-08-23",
      royalty: "3.43",
    });
    db.seedKdpSaleTransaction({
      id: "t2",
      book_id: "b1",
      profile_id: "p1",
      asin: "B0TRCUS001",
      order_date: "2026-08-22",
      royalty_date: "2026-08-25",
      royalty: "3.50",
    });
    db.seedKdpSaleTransaction({
      id: "t3",
      book_id: null,
      profile_id: null,
      asin: "B0UNKNOWN1",
      order_date: "2026-07-05",
      royalty_date: "2026-07-08",
      royalty: "1.10",
      royalty_type: "40%",
      transaction_type: "Expanded Distribution Channels",
    });
  }

  it("returns rows newest first with the book title and Amazon profile id", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    seedTransactions(db);
    const service = makeService(db);

    const page = await service.listKdpTransactions("1", {
      limit: 500,
      offset: 0,
    });

    expect(kdpTransactionsPageSchema.parse(page)).toBeTruthy();
    expect(page.total).toBe(3);
    expect(page.transactions.map((tx) => tx.id)).toEqual(["t2", "t1", "t3"]);
    expect(page.transactions[0]).toMatchObject({
      bookId: "b1",
      title: "Tractor",
      profileId: "amz-us",
      orderDate: "2026-08-22",
      royaltyDate: "2026-08-25",
      transactionType: "Standard - Paperback",
      royalty: "3.50",
      currency: "USD",
    });
    // Unlinked rows keep null ids and a null title.
    expect(page.transactions[2]).toMatchObject({
      bookId: null,
      title: null,
      profileId: null,
      asin: "B0UNKNOWN1",
    });
  });

  it("filters by book, Amazon profile id, and month", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    seedTransactions(db);
    const service = makeService(db);

    expect(
      (
        await service.listKdpTransactions("1", {
          bookId: "b1",
          limit: 500,
          offset: 0,
        })
      ).total,
    ).toBe(2);
    expect(
      (
        await service.listKdpTransactions("1", {
          bookId: "999",
          limit: 500,
          offset: 0,
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await service.listKdpTransactions("1", {
          profileId: "amz-us",
          limit: 500,
          offset: 0,
        })
      ).total,
    ).toBe(2);
    expect(
      (
        await service.listKdpTransactions("1", {
          profileId: "amz-uk",
          limit: 500,
          offset: 0,
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await service.listKdpTransactions("1", {
          month: "2026-07-01",
          limit: 500,
          offset: 0,
        })
      ).total,
    ).toBe(1);
  });

  it("returns no rows for an unknown profile id", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    seedTransactions(db);
    const service = makeService(db);

    await expect(
      service.listKdpTransactions("1", {
        profileId: "amz-nope",
        limit: 500,
        offset: 0,
      }),
    ).resolves.toEqual({ transactions: [], total: 0 });
  });

  it("pages with limit and offset while keeping the filtered total", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    seedTransactions(db);
    const service = makeService(db);

    const firstPage = await service.listKdpTransactions("1", {
      limit: 1,
      offset: 0,
    });
    const secondPage = await service.listKdpTransactions("1", {
      limit: 1,
      offset: 1,
    });
    const pastEnd = await service.listKdpTransactions("1", {
      limit: 1,
      offset: 3,
    });

    expect(firstPage.transactions.map((tx) => tx.id)).toEqual(["t2"]);
    expect(firstPage.total).toBe(3);
    expect(secondPage.transactions.map((tx) => tx.id)).toEqual(["t1"]);
    expect(secondPage.total).toBe(3);
    expect(pastEnd).toEqual({ transactions: [], total: 3 });
  });

  it("normalizes dates when the driver returns Date objects", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    db.seedKdpSaleTransaction({
      order_date: new Date(2026, 7, 20) as unknown as string,
      royalty_date: new Date(2026, 7, 23) as unknown as string,
    });
    const service = makeService(db);

    const page = await service.listKdpTransactions("1", {
      limit: 500,
      offset: 0,
    });

    expect(page.transactions[0]!.orderDate).toBe("2026-08-20");
    expect(page.transactions[0]!.royaltyDate).toBe("2026-08-23");
  });
});
