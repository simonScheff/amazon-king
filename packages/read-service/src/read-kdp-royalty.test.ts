import { describe, expect, it } from "vitest";
import { FakeDb } from "@amazon-king/database/testing";
import type {
  KdpRoyaltyImportInput,
  KdpRoyaltyRow,
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
const meta = { ip: "127.0.0.1", userAgent: "test" };

function makeService(db: FakeDb) {
  return createReadService({
    db: db as never,
    config: {} as ReadServiceConfig,
    logger: {} as ReadServiceLogger,
  });
}

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
    country_code: "GB",
    currency_code: "GBP",
  });
  db.seedBook({ id: "b1", workspace_id: "1", title: "Tractor" });
  db.seedBookProfileLink({
    book_id: "b1",
    profile_id: "p1",
    marketplace_asin: "B0TRCUS001",
  });
  db.seedBookProfileLink({
    book_id: "b1",
    profile_id: "p2",
    marketplace_asin: "B0TRCUK01",
  });
  db.seedBookEconomics({
    book_id: "b1",
    profile_id: "p1",
    list_price: "10.4500",
    estimated_royalty_per_sale: "3.4000",
    effective_from: "2026-01-01",
  });
}

function row(overrides: Partial<KdpRoyaltyRow> = {}): KdpRoyaltyRow {
  return {
    format: "paperback",
    orderDate: "2026-08-20",
    royaltyDate: "2026-08-22",
    asin: "B0TRCUS001",
    title: "Tractor",
    marketplace: "Amazon.com",
    royaltyType: "60%",
    transactionType: "Standard - Paperback",
    netUnits: 1,
    royalty: "3.43",
    currency: "USD",
    ...overrides,
  };
}

function input(rows: KdpRoyaltyRow[]): KdpRoyaltyImportInput {
  return {
    fileName: "kdp.xlsx",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-25",
    rows,
  };
}

describe("kdp royalty import derivation", () => {
  it("derives from standard-rate rows, keeping expanded units as context", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([
        row(),
        row(),
        row(),
        row({
          royaltyType: "40%",
          transactionType: "Expanded Distribution Channels",
          royalty: "1.10",
        }),
      ]),
      meta,
    );

    expect(result.alreadyExisted).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.suggestions).toHaveLength(1);
    const suggestion = result.suggestions[0]!;
    expect(suggestion.bookId).toBe("b1");
    expect(suggestion.profileId).toBe("amz-us");
    expect(suggestion.suggestedRoyaltyPerSale).toBe("3.43");
    expect(suggestion.standardUnits).toBe(3);
    expect(suggestion.expandedUnits).toBe(1);
    expect(suggestion.currentRoyaltyPerSale).toBe("3.4000");
    expect(suggestion.lowEvidence).toBe(true);
    expect(suggestion.deviationWarning).toBe(false);
  });

  it("matches a UK-country Amazon profile to Amazon.co.uk rows", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    // The real Amazon Ads API reports the United Kingdom profile as "UK",
    // not the ISO "GB" that the KDP marketplace map produces.
    db.tables.amazonProfiles.find((p) => p.id === "p2")!.country_code = "UK";
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([
        row({
          marketplace: "Amazon.co.uk",
          asin: "B0TRCUK01",
          royalty: "2.83",
          currency: "GBP",
        }),
      ]),
      meta,
    );

    expect(result.skipped).toEqual([]);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.profileId).toBe("amz-uk");
    expect(result.suggestions[0]!.suggestedRoyaltyPerSale).toBe("2.83");
  });

  it("weights the suggestion over the actual per-row royalties", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([row({ royalty: "3.43" }), row({ royalty: "3.50" })]),
      meta,
    );

    expect(result.suggestions[0]!.suggestedRoyaltyPerSale).toBe("3.465");
  });

  it("skips row groups with explicit reasons", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([
        row({ asin: "B0UNKNOWN1" }),
        row({ marketplace: "Amazon.eg", asin: "B0TRCUS001" }),
        row({ marketplace: "Amazon.co.jp" }),
        row({ currency: "EUR" }),
        row({
          marketplace: "Amazon.co.uk",
          asin: "B0TRCUK01",
          royaltyType: "40%",
          transactionType: "Expanded Distribution Channels",
          royalty: "1.10",
          currency: "GBP",
        }),
      ]),
      meta,
    );

    expect(result.suggestions).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason).sort()).toEqual([
      "asin_not_linked",
      "currency_mismatch",
      "no_ads_profile",
      "no_standard_rows",
      "unknown_marketplace",
    ]);
  });

  it("replays an identical upload instead of duplicating the batch", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);
    const payload = input([row()]);

    const first = await service.createKdpRoyaltyImport(auth, payload, meta);
    const second = await service.createKdpRoyaltyImport(auth, payload, meta);

    expect(second.id).toBe(first.id);
    expect(second.alreadyExisted).toBe(true);
    expect(db.tables.kdpRoyaltyImports).toHaveLength(1);
  });

  it("flags deviations above 15% of the current value", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    db.tables.bookEconomics[0]!.estimated_royalty_per_sale = "2.0000";
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([row()]),
      meta,
    );

    expect(result.suggestions[0]!.deviationWarning).toBe(true);
  });

  it("treats five or more standard units as sufficient evidence", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([row(), row(), row(), row(), row()]),
      meta,
    );

    expect(result.suggestions[0]!.lowEvidence).toBe(false);
  });
});

describe("kdp royalty import apply", () => {
  async function createBatch(db: FakeDb) {
    const service = makeService(db);
    const batch = await service.createKdpRoyaltyImport(
      auth,
      input([row(), row(), row(), row(), row()]),
      meta,
    );
    return { service, batch };
  }

  it("writes economics with only royalty changed and marks the batch", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const { service, batch } = await createBatch(db);

    const result = await service.applyKdpRoyaltyImport(
      auth,
      batch.id,
      {
        selections: [{ bookId: "b1", profileId: "amz-us" }],
        effectiveFrom: "2026-08-27",
      },
      meta,
    );

    expect(result).toEqual({ applied: 1, skipped: [] });
    const written = db.tables.bookEconomics.find(
      (entry) =>
        entry.book_id === "b1" && entry.effective_from === "2026-08-27",
    );
    expect(written).toMatchObject({
      profile_id: "p1",
      estimated_royalty_per_sale: "3.43",
      list_price: "10.4500",
      goal_mode: "balanced",
      currency: "USD",
    });
    expect(db.tables.kdpRoyaltyImports[0]!.applied_at).not.toBeNull();
  });

  it("rejects applying the same batch twice", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const { service, batch } = await createBatch(db);
    const selections = [{ bookId: "b1", profileId: "amz-us" }];
    await service.applyKdpRoyaltyImport(auth, batch.id, { selections }, meta);

    await expect(
      service.applyKdpRoyaltyImport(auth, batch.id, { selections }, meta),
    ).rejects.toMatchObject({ code: "KDP_IMPORT_ALREADY_APPLIED" });
  });

  it("skips selections without existing economics and unknown selections", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    db.seedBook({ id: "b2", workspace_id: "1", title: "No Econ" });
    db.seedBookProfileLink({
      book_id: "b2",
      profile_id: "p1",
      marketplace_asin: "B0NOECON01",
    });
    const service = makeService(db);
    const batch = await service.createKdpRoyaltyImport(
      auth,
      input([row(), row({ asin: "B0NOECON01", title: "No Econ" })]),
      meta,
    );

    const result = await service.applyKdpRoyaltyImport(
      auth,
      batch.id,
      {
        selections: [
          { bookId: "b1", profileId: "amz-us" },
          { bookId: "b2", profileId: "amz-us" },
          { bookId: "bogus", profileId: "amz-us" },
        ],
      },
      meta,
    );

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([
      { bookId: "b2", profileId: "amz-us", reason: "no_existing_economics" },
      { bookId: "bogus", profileId: "amz-us", reason: "unknown_selection" },
    ]);
  });

  it("hides batches of other workspaces", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const { service, batch } = await createBatch(db);

    await expect(
      service.applyKdpRoyaltyImport(
        { ...auth, workspaceId: "2" },
        batch.id,
        { selections: [{ bookId: "b1", profileId: "amz-us" }] },
        meta,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("kdp royalty import listing", () => {
  it("lists batches newest first with suggestion counts", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);
    await service.createKdpRoyaltyImport(auth, input([row()]), meta);
    await service.createKdpRoyaltyImport(
      auth,
      input([row({ royaltyDate: "2026-08-23" })]),
      meta,
    );

    const list = await service.listKdpRoyaltyImports("1");

    expect(list).toHaveLength(2);
    expect(Number(list[0]!.id)).toBeGreaterThan(Number(list[1]!.id));
    expect(list[0]!.suggestionCount).toBe(1);
    expect(list[0]!.appliedAt).toBeNull();
  });

  it("normalizes period dates when the driver returns Date objects", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);
    // pg returns `date` columns as Date objects in some versions; the API
    // contract requires "YYYY-MM-DD" strings.
    db.seedKdpRoyaltyImport({
      period_start: new Date(2026, 7, 1) as unknown as string,
      period_end: new Date(2026, 7, 25) as unknown as string,
    });

    const list = await service.listKdpRoyaltyImports("1");

    expect(list[0]!.periodStart).toBe("2026-08-01");
    expect(list[0]!.periodEnd).toBe("2026-08-25");
  });
});

describe("kdp sales history population", () => {
  it("populates monthly aggregates and verbatim transactions on a new import", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    await service.createKdpRoyaltyImport(
      auth,
      input([
        // August: two standard sales + one expanded-distribution sale.
        row(),
        row({ royalty: "3.50" }),
        row({
          royaltyType: "40%",
          transactionType: "Expanded Distribution Channels",
          royalty: "1.10",
        }),
        // September: one standard sale → its own monthly row.
        row({ orderDate: "2026-09-02", royaltyDate: "2026-09-05" }),
      ]),
      meta,
    );

    expect(db.tables.kdpMonthlyBookSales).toEqual([
      expect.objectContaining({
        book_id: "b1",
        profile_id: "p1",
        month: "2026-08-01",
        standard_units: 2,
        expanded_units: 1,
        royalty: "6.93",
        currency: "USD",
      }),
      expect.objectContaining({
        month: "2026-09-01",
        standard_units: 1,
        expanded_units: 0,
        royalty: "3.43",
      }),
    ]);
    expect(db.tables.kdpSaleTransactions).toHaveLength(4);
    expect(
      db.tables.kdpSaleTransactions.every(
        (tx) => tx.book_id === "b1" && tx.profile_id === "p1",
      ),
    ).toBe(true);
    expect(db.tables.kdpSaleTransactions[2]).toMatchObject({
      royalty_type: "40%",
      transaction_type: "Expanded Distribution Channels",
    });
  });

  it("records a monthly row with zero royalty for a month of only expanded rows", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    const result = await service.createKdpRoyaltyImport(
      auth,
      input([
        row({
          royaltyType: "40%",
          transactionType: "Expanded Distribution Channels",
          royalty: "1.10",
        }),
      ]),
      meta,
    );

    expect(result.skipped[0]!.reason).toBe("no_standard_rows");
    expect(db.tables.kdpMonthlyBookSales).toEqual([
      expect.objectContaining({
        month: "2026-08-01",
        standard_units: 0,
        expanded_units: 1,
        royalty: "0",
      }),
    ]);
  });

  it("keeps linked ids on transactions of a currency-mismatch group, without monthly rows", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    await service.createKdpRoyaltyImport(
      auth,
      input([
        row({ currency: "EUR" }), // currency_mismatch, but the ASIN is linked
        row({ asin: "B0UNKNOWN1" }), // unlinked ASIN
      ]),
      meta,
    );

    expect(db.tables.kdpMonthlyBookSales).toHaveLength(0);
    expect(db.tables.kdpSaleTransactions).toHaveLength(2);
    expect(db.tables.kdpSaleTransactions[0]).toMatchObject({
      book_id: "b1",
      profile_id: "p1",
    });
    expect(db.tables.kdpSaleTransactions[1]).toMatchObject({
      book_id: null,
      profile_id: null,
      asin: "B0UNKNOWN1",
    });
  });

  it("does not re-populate history on a replayed upload", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);
    const payload = input([row()]);

    await service.createKdpRoyaltyImport(auth, payload, meta);
    const second = await service.createKdpRoyaltyImport(auth, payload, meta);

    expect(second.alreadyExisted).toBe(true);
    expect(db.tables.kdpMonthlyBookSales).toHaveLength(1);
    expect(db.tables.kdpSaleTransactions).toHaveLength(1);
  });

  it("replaces a month's history when a different file covers it again", async () => {
    const db = new FakeDb();
    seedCatalog(db);
    const service = makeService(db);

    // Partial-month file.
    await service.createKdpRoyaltyImport(
      auth,
      input([row({ orderDate: "2026-08-10", royaltyDate: "2026-08-12" })]),
      meta,
    );
    // Later full-month file: three sales, one of them in September.
    await service.createKdpRoyaltyImport(
      auth,
      input([
        row(),
        row({ royalty: "3.50" }),
        row({ orderDate: "2026-09-01", royaltyDate: "2026-09-04" }),
      ]),
      meta,
    );

    // The August monthly row is overwritten by the newer import; the
    // September row comes only from the second file.
    expect(db.tables.kdpMonthlyBookSales).toHaveLength(2);
    const august = db.tables.kdpMonthlyBookSales.find(
      (entry) => entry.month === "2026-08-01",
    )!;
    expect(august).toMatchObject({ standard_units: 2, royalty: "6.93" });
    // August's transactions were deleted before re-insert: the partial
    // file's 2026-08-10 row is gone, not duplicated.
    const augustTransactions = db.tables.kdpSaleTransactions.filter((tx) =>
      String(tx.order_date).startsWith("2026-08"),
    );
    expect(augustTransactions).toHaveLength(2);
    expect(
      augustTransactions.some((tx) => tx.order_date === "2026-08-10"),
    ).toBe(false);
  });
});
