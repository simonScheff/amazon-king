import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "./db.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import {
  upsertCampaignMetrics,
  upsertAdvertisedProductMetrics,
  upsertSearchTermMetrics,
  dashboardTotals,
  MixedCurrencyError,
} from "./repositories/metrics.js";
import {
  campaignDailySeries,
  listCampaignRows,
  listNegativeKeywordRows,
  listSearchTermCampaignRows,
  listSearchTermRollupRows,
  overviewRoyaltySeries,
  searchTermDailySeries,
} from "./repositories/dashboard.js";
import { enqueue, claim, reapExpiredLeases, complete } from "./queue.js";
import {
  upsertAd,
  upsertAdGroup,
  upsertCampaign,
  deleteMissingNegativeKeywords,
  upsertNegativeKeyword,
  listEntityChanges,
} from "./repositories/structure.js";
import {
  listLatestBookEconomicsByWorkspace,
  listUnmappedAdvertisedProducts,
  mapAdvertisedProductToBook,
  upsertBookEconomics,
} from "./repositories/books.js";
import {
  insertRecommendation,
  listRecommendationsByWorkspace,
  transitionRecommendationState,
  expireStaleRecommendations,
} from "./repositories/recommendations.js";
import {
  createChangeSet,
  findChangeActionByFingerprint,
  listRecentAppliedActions,
} from "./repositories/changes.js";
import {
  buildChangeSetFingerprint,
  buildChangeActionFingerprint,
} from "./fingerprint.js";

/**
 * Integration tests against a real PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set so `pnpm -r test` passes on
 * machines without Postgres.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

async function seedProfile(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `with w as (insert into workspaces (name) values ('test workspace') returning id),
     c as (
       insert into amazon_connections
         (workspace_id, encrypted_refresh_token, encryption_key_version, status)
       select id, '\\xdeadbeef'::bytea, 1, 'connected' from w
       returning id
     )
     insert into amazon_profiles
       (connection_id, profile_id, region, country_code, currency_code)
     select c.id, 'amzn-profile-' || gen_random_uuid(), 'NA', 'US', 'USD' from c
     returning id`,
  );
  return result.rows[0]!.id;
}

describeIf("integration (TEST_DATABASE_URL)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    // Drop any leftovers from a previous run for a clean slate.
    await pool.query("drop schema public cascade; create schema public;");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migrations cleanly and is re-runnable", async () => {
    const applied = await migrate(pool);
    expect(applied).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
    ]);
    const again = await migrate(pool);
    expect(again).toEqual([]);
    const tables = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_name = 'job_queue'`,
    );
    expect(tables.rows[0]!.count).toBe("1");
  });

  it("metric upserts converge on duplicate import", async () => {
    const profileId = await seedProfile(pool);
    const row = {
      profileId,
      campaignId: "amzn-campaign-1",
      metricDate: "2026-07-01",
      impressions: 100,
      clicks: 10,
      cost: "5.00",
      sales: "20.00",
      orders: 2,
      units: 2,
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
      unitsSoldClicks7d: 2,
      unitsSoldClicks14d: 2,
      currency: "USD",
    };
    await upsertCampaignMetrics(pool, [row]);
    // Re-import the same grain with late-arriving attribution corrections.
    await upsertCampaignMetrics(pool, [
      { ...row, impressions: 100, purchases14d: 3, sales14d: "30.00" },
      { ...row, purchases14d: 3, sales14d: "30.00" },
    ]);

    const result = await pool.query<{
      count: string;
      impressions: number;
      purchases14d: number;
      sales14d: string;
    }>(
      `select count(*)::text as count,
              max(impressions) as impressions,
              max(purchases14d) as purchases14d,
              max(sales14d)::text as sales14d
       from campaign_metrics_daily where profile_id = $1`,
      [profileId],
    );
    expect(result.rows[0]).toEqual({
      count: "1",
      impressions: 100,
      purchases14d: 3,
      sales14d: "30.0000",
    });

    const totals = await dashboardTotals(
      pool,
      profileId,
      "2026-07-01",
      "2026-07-31",
    );
    expect(totals).toMatchObject({
      currency: "USD",
      impressions: 100,
      clicks: 10,
      orders: 2,
      units: 2,
    });
  });

  it("refuses to aggregate across currencies", async () => {
    const profileId = await seedProfile(pool);
    const base = {
      profileId,
      campaignId: "amzn-campaign-mixed",
      impressions: 1,
      clicks: 1,
      cost: "1.00",
      sales: "1.00",
      orders: 0,
      units: 0,
      purchases7d: 0,
      sales7d: "0",
      purchases14d: 0,
      sales14d: "0",
      unitsSoldClicks7d: 0,
      unitsSoldClicks14d: 0,
    };
    await upsertCampaignMetrics(pool, [
      { ...base, metricDate: "2026-07-01", currency: "USD" },
      { ...base, metricDate: "2026-07-02", currency: "EUR" },
    ]);
    await expect(
      dashboardTotals(pool, profileId, "2026-07-01", "2026-07-31"),
    ).rejects.toThrow(MixedCurrencyError);
  });

  it("two concurrent claimers never get the same job", async () => {
    await enqueue(pool, "test.claim", { n: 1 });
    const [first, second] = await Promise.all([
      claim(pool, "worker-1", ["test.claim"], 60),
      claim(pool, "worker-2", ["test.claim"], 60),
    ]);
    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.attempts).toBe(1);
    await complete(pool, claimed[0]!.id, claimed[0]!.lockedBy!);
  });

  it("expired leases are reaped back to pending", async () => {
    const jobId = await enqueue(pool, "test.reap", {});
    const job = await claim(pool, "dead-worker", ["test.reap"], 60);
    expect(job?.id).toBe(jobId);

    // Simulate the worker dying: force its lease into the past.
    await pool.query(
      `update job_queue set lease_expires_at = now() - interval '1 second' where id = $1`,
      [jobId],
    );
    const reaped = await reapExpiredLeases(pool);
    expect(reaped).toContain(jobId);

    const state = await pool.query<{
      status: string;
      locked_by: string | null;
    }>(`select status, locked_by from job_queue where id = $1`, [jobId]);
    expect(state.rows[0]).toEqual({ status: "pending", locked_by: null });

    // Another worker can now claim it.
    const reclaimed = await claim(pool, "live-worker", ["test.reap"], 60);
    expect(reclaimed?.id).toBe(jobId);
    await complete(pool, jobId, "live-worker");
  });

  it("structure upserts are idempotent and record change history", async () => {
    const profileId = await seedProfile(pool);
    const input = {
      profileId,
      amazonCampaignId: "amzn-campaign-hist",
      name: "Launch campaign",
      state: "enabled",
      targetingType: "auto",
      dailyBudget: "10.00",
    };
    const first = await upsertCampaign(pool, input);
    expect(first.created).toBe(true);
    expect(first.changedFields).toEqual([]);

    // Identical re-import: same row, no changes recorded.
    const same = await upsertCampaign(pool, input);
    expect(same.created).toBe(false);
    expect(same.id).toBe(first.id);
    expect(same.changedFields).toEqual([]);

    // Changed budget/state: recorded into entity_change_history.
    const changed = await upsertCampaign(pool, {
      ...input,
      dailyBudget: "12.50",
      state: "paused",
    });
    expect(changed.changedFields.sort()).toEqual(["daily_budget", "state"]);

    const history = await listEntityChanges(pool, "campaign", first.id);
    expect(history).toHaveLength(2);
    const budget = history.find((h) => h.field === "daily_budget")!;
    expect(budget.oldValue).toBe("10.0000");
    expect(budget.newValue).toBe("12.5000");
  });

  it("persists campaign- and ad-group-level negative keywords idempotently", async () => {
    const profileId = await seedProfile(pool);
    const campaign = await upsertCampaign(pool, {
      profileId,
      amazonCampaignId: "amzn-campaign-negatives",
      name: "Negative keyword campaign",
      state: "enabled",
    });
    const adGroup = await upsertAdGroup(pool, {
      profileId,
      campaignId: campaign.id,
      amazonAdGroupId: "amzn-ad-group-negatives",
      name: "Exact ad group",
      state: "enabled",
    });

    const first = await upsertNegativeKeyword(pool, {
      profileId,
      campaignId: campaign.id,
      amazonNegativeKeywordId: "amzn-negative-campaign",
      keywordText: "free books",
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    });
    const repeated = await upsertNegativeKeyword(pool, {
      profileId,
      campaignId: campaign.id,
      amazonNegativeKeywordId: "amzn-negative-campaign",
      keywordText: "free kindle books",
      matchType: "NEGATIVE_PHRASE",
      state: "PAUSED",
    });
    await upsertNegativeKeyword(pool, {
      profileId,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      amazonNegativeKeywordId: "amzn-negative-ad-group",
      keywordText: "used books",
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    });

    expect(repeated.id).toBe(first.id);
    await expect(listNegativeKeywordRows(pool, campaign.id)).resolves.toEqual([
      {
        id: "amzn-negative-campaign",
        keywordText: "free kindle books",
        matchType: "NEGATIVE_PHRASE",
        level: "campaign",
        adGroupId: null,
        adGroupName: null,
        state: "PAUSED",
      },
      {
        id: "amzn-negative-ad-group",
        keywordText: "used books",
        matchType: "NEGATIVE_EXACT",
        level: "ad_group",
        adGroupId: "amzn-ad-group-negatives",
        adGroupName: "Exact ad group",
        state: "ENABLED",
      },
    ]);

    expect(
      await deleteMissingNegativeKeywords(pool, profileId, [
        "amzn-negative-ad-group",
      ]),
    ).toBe(1);
    await expect(listNegativeKeywordRows(pool, campaign.id)).resolves.toEqual([
      expect.objectContaining({ id: "amzn-negative-ad-group" }),
    ]);
  });

  it("maps advertised ASINs into the book catalog idempotently", async () => {
    const profileId = await seedProfile(pool);
    const workspace = await pool.query<{ workspace_id: string }>(
      `select c.workspace_id::text
       from amazon_profiles p join amazon_connections c on c.id = p.connection_id
       where p.id = $1`,
      [profileId],
    );
    const campaign = await upsertCampaign(pool, {
      profileId,
      amazonCampaignId: "amzn-campaign-book-map",
      name: "Book campaign",
      state: "enabled",
    });
    const adGroup = await upsertAdGroup(pool, {
      profileId,
      campaignId: campaign.id,
      amazonAdGroupId: "amzn-ad-group-book-map",
      name: "Book ad group",
      state: "enabled",
    });
    await upsertAd(pool, {
      profileId,
      adGroupId: adGroup.id,
      amazonAdId: "amzn-ad-book-map",
      asin: "B012345678",
      state: "enabled",
    });

    const workspaceId = workspace.rows[0]!.workspace_id;
    const candidates = await listUnmappedAdvertisedProducts(pool, workspaceId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ asin: "B012345678", adCount: 1 });

    const first = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B012345678",
      title: "First title",
      format: "paperback",
    });
    const repeated = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B012345678",
      title: "Updated title",
      format: "paperback",
    });

    expect(repeated?.id).toBe(first?.id);
    expect(repeated?.title).toBe("Updated title");
    await upsertBookEconomics(pool, {
      bookId: first!.id,
      profileId,
      effectiveFrom: "2026-08-13",
      currency: "USD",
      listPrice: "12.99",
      estimatedRoyaltyPerSale: "4.25",
      targetAcos: "0.25",
      goalMode: "balanced",
    });
    const metricValues = {
      impressions: 100,
      clicks: 10,
      cost: "5.00",
      sales: "20.00",
      orders: 2,
      units: 2,
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
      unitsSoldClicks7d: 2,
      unitsSoldClicks14d: 2,
      currency: "USD",
    };
    await upsertCampaignMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-book-map",
        metricDate: "2026-08-13",
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-book-map",
        metricDate: "2026-08-14",
      },
    ]);
    await upsertAdvertisedProductMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-book-map",
        adGroupId: "amzn-ad-group-book-map",
        adId: "amzn-ad-book-map",
        metricDate: "2026-08-13",
      },
    ]);
    await expect(
      campaignDailySeries(
        pool,
        profileId,
        "amzn-campaign-book-map",
        "2026-08-13",
        "2026-08-14",
      ),
    ).resolves.toEqual([
      {
        date: "2026-08-13",
        cost: "5.0000",
        sales: "20.0000",
        orders: 2,
        currency: "USD",
        estimatedRoyalty: "8.5000",
      },
      {
        date: "2026-08-14",
        cost: "5.0000",
        sales: "20.0000",
        orders: 2,
        currency: "USD",
        estimatedRoyalty: "8.5000",
      },
    ]);
    await expect(
      listCampaignRows(pool, workspaceId, "2026-08-13", "2026-08-14"),
    ).resolves.toMatchObject([
      {
        amazonCampaignId: "amzn-campaign-book-map",
        currency: "USD",
        estimatedRoyalty: "17.0000",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-14",
        mixedCurrency: false,
      },
    ]);
    await expect(
      listLatestBookEconomicsByWorkspace(pool, workspaceId),
    ).resolves.toMatchObject([
      {
        bookId: first!.id,
        amazonProfileId: expect.stringMatching(/^amzn-profile-/),
        currency: "USD",
        listPrice: "12.9900",
        estimatedRoyaltyPerSale: "4.2500",
        targetAcos: "0.2500",
      },
    ]);
    await expect(
      listUnmappedAdvertisedProducts(pool, workspaceId),
    ).resolves.toEqual([]);
    const counts = await pool.query<{ books: string; links: string }>(
      `select (select count(*)::text from books where workspace_id = $1) as books,
              (select count(*)::text from book_profile_links where profile_id = $2) as links`,
      [workspaceId, profileId],
    );
    expect(counts.rows[0]).toEqual({ books: "1", links: "1" });

    // Do not infer attribution when another current ad is not mapped to the
    // same book. Product-level data remains mandatory in that case.
    await upsertAd(pool, {
      profileId,
      adGroupId: adGroup.id,
      amazonAdId: "amzn-ad-unmapped",
      asin: "B099999999",
      state: "enabled",
    });
    await expect(
      campaignDailySeries(
        pool,
        profileId,
        "amzn-campaign-book-map",
        "2026-08-14",
        "2026-08-14",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        date: "2026-08-14",
        estimatedRoyalty: null,
      }),
    ]);
  });

  it("aggregates search terms across campaigns with royalty attribution", async () => {
    const profileId = await seedProfile(pool);
    const workspace = await pool.query<{ workspace_id: string }>(
      `select c.workspace_id::text
       from amazon_profiles p join amazon_connections c on c.id = p.connection_id
       where p.id = $1`,
      [profileId],
    );
    const workspaceId = workspace.rows[0]!.workspace_id;

    // Two campaigns advertising the same book, plus one unmapped ad group.
    for (const suffix of ["1", "2"]) {
      const campaign = await upsertCampaign(pool, {
        profileId,
        amazonCampaignId: `amzn-campaign-st-${suffix}`,
        name: `ST campaign ${suffix}`,
        state: "enabled",
      });
      const adGroup = await upsertAdGroup(pool, {
        profileId,
        campaignId: campaign.id,
        amazonAdGroupId: `amzn-ad-group-st-${suffix}`,
        name: `ST ad group ${suffix}`,
        state: "enabled",
      });
      await upsertAd(pool, {
        profileId,
        adGroupId: adGroup.id,
        amazonAdId: `amzn-ad-st-${suffix}`,
        asin: "B0STTERM01",
        state: "enabled",
      });
    }
    const unmappedCampaign = await upsertCampaign(pool, {
      profileId,
      amazonCampaignId: "amzn-campaign-st-unmapped",
      name: "ST unmapped campaign",
      state: "enabled",
    });
    const unmappedAdGroup = await upsertAdGroup(pool, {
      profileId,
      campaignId: unmappedCampaign.id,
      amazonAdGroupId: "amzn-ad-group-st-unmapped",
      name: "ST unmapped ad group",
      state: "enabled",
    });
    await upsertAd(pool, {
      profileId,
      adGroupId: unmappedAdGroup.id,
      amazonAdId: "amzn-ad-st-unmapped",
      asin: "B0UNMAPPED9",
      state: "enabled",
    });

    const book = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B0STTERM01",
      title: "Search term book",
      format: "ebook",
    });
    await upsertBookEconomics(pool, {
      bookId: book!.id,
      profileId,
      effectiveFrom: "2026-08-13",
      currency: "USD",
      listPrice: "9.99",
      estimatedRoyaltyPerSale: "4.25",
      targetAcos: "0.30",
      goalMode: "profit",
    });

    const metricValues = {
      impressions: 100,
      clicks: 10,
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
      units: 2,
      unitsSoldClicks7d: 2,
      unitsSoldClicks14d: 2,
      currency: "USD",
    };
    await upsertSearchTermMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-st-1",
        adGroupId: "amzn-ad-group-st-1",
        targetId: "amzn-target-st-1",
        searchTerm: "fantasy books",
        metricDate: "2026-08-13",
        cost: "5.00",
        sales: "20.00",
        orders: 2,
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-st-2",
        adGroupId: "amzn-ad-group-st-2",
        targetId: "amzn-target-st-2",
        searchTerm: "fantasy books",
        metricDate: "2026-08-13",
        cost: "3.00",
        sales: "8.00",
        orders: 1,
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-st-1",
        adGroupId: "amzn-ad-group-st-1",
        targetId: "amzn-target-st-1",
        searchTerm: "dragons",
        metricDate: "2026-08-13",
        cost: "4.00",
        sales: "0.00",
        orders: 0,
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-st-unmapped",
        adGroupId: "amzn-ad-group-st-unmapped",
        targetId: "amzn-target-st-unmapped",
        searchTerm: "unmapped series",
        metricDate: "2026-08-13",
        cost: "6.00",
        sales: "10.00",
        orders: 1,
      },
    ]);

    const rollup = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
    );
    expect(rollup).toEqual([
      // Ordered by spend desc.
      expect.objectContaining({
        searchTerm: "fantasy books",
        campaignCount: 2,
        countryCodes: ["US"],
        currency: "USD",
        totals: expect.objectContaining({ cost: "8.0000", orders: 3 }),
        // (2 + 1 orders) × 4.25 royalty per sale.
        estimatedRoyalty: "12.7500",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-13",
        mixedCurrency: false,
      }),
      expect.objectContaining({
        searchTerm: "unmapped series",
        campaignCount: 1,
        estimatedRoyalty: null,
        economicsMissing: true,
      }),
      expect.objectContaining({
        searchTerm: "dragons",
        campaignCount: 1,
        // No orders → zero royalty, not missing economics.
        estimatedRoyalty: "0",
        economicsMissing: false,
      }),
    ]);

    const breakdown = await listSearchTermCampaignRows(
      pool,
      workspaceId,
      "fantasy books",
      "2026-08-13",
      "2026-08-14",
    );
    expect(breakdown).toEqual([
      expect.objectContaining({
        amazonCampaignId: "amzn-campaign-st-1",
        countryCode: "US",
        name: "ST campaign 1",
        totals: expect.objectContaining({ cost: "5.0000", orders: 2 }),
        estimatedRoyalty: "8.5000",
        economicsMissing: false,
      }),
      expect.objectContaining({
        amazonCampaignId: "amzn-campaign-st-2",
        name: "ST campaign 2",
        totals: expect.objectContaining({ cost: "3.0000", orders: 1 }),
        estimatedRoyalty: "4.2500",
        economicsMissing: false,
      }),
    ]);

    // Product filter keeps only ad groups advertising the selected book.
    const filtered = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      [BigInt(book!.id)],
    );
    expect(filtered.map((row) => row.searchTerm)).toEqual([
      "fantasy books",
      "dragons",
    ]);

    const filteredBreakdown = await listSearchTermCampaignRows(
      pool,
      workspaceId,
      "unmapped series",
      "2026-08-13",
      "2026-08-14",
      [BigInt(book!.id)],
    );
    expect(filteredBreakdown).toEqual([]);

    // Market filter restricts the rollup to one marketplace's facts.
    const usOnly = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      null,
      "US",
    );
    expect(usOnly.map((row) => row.searchTerm)).toEqual(
      rollup.map((row) => row.searchTerm),
    );
    const deOnly = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      null,
      "DE",
    );
    expect(deOnly).toEqual([]);

    // Daily series aggregates both campaigns of the selected market per day.
    const daily = await searchTermDailySeries(
      pool,
      workspaceId,
      "fantasy books",
      "US",
      "2026-08-13",
      "2026-08-14",
    );
    expect(daily).toEqual([
      {
        date: "2026-08-13",
        cost: "8.0000",
        sales: "28.0000",
        orders: 3,
        currency: "USD",
        // (2 + 1 orders) × 4.25 royalty per sale.
        estimatedRoyalty: "12.7500",
      },
    ]);

    // A market without data yields no points.
    await expect(
      searchTermDailySeries(
        pool,
        workspaceId,
        "fantasy books",
        "GB",
        "2026-08-13",
        "2026-08-14",
      ),
    ).resolves.toEqual([]);

    // A day with orders but incomplete economics reports null royalty.
    const unmappedDaily = await searchTermDailySeries(
      pool,
      workspaceId,
      "unmapped series",
      "US",
      "2026-08-13",
      "2026-08-14",
    );
    expect(unmappedDaily).toEqual([
      expect.objectContaining({ estimatedRoyalty: null }),
    ]);
  });

  it("filters dashboard rows and recommendations by selected books", async () => {
    const profileId = await seedProfile(pool);
    const workspace = await pool.query<{ workspace_id: string }>(
      `select c.workspace_id::text
       from amazon_profiles p join amazon_connections c on c.id = p.connection_id
       where p.id = $1`,
      [profileId],
    );
    const workspaceId = workspace.rows[0]!.workspace_id;

    // Campaign A advertises book A, campaign B advertises book B; a third
    // book has no enabled link to any advertised ASIN.
    const pks: Record<string, { campaignId: string; adGroupId: string }> = {};
    for (const suffix of ["a", "b"]) {
      const campaign = await upsertCampaign(pool, {
        profileId,
        amazonCampaignId: `amzn-campaign-bf-${suffix}`,
        name: `BF campaign ${suffix}`,
        state: "enabled",
      });
      const adGroup = await upsertAdGroup(pool, {
        profileId,
        campaignId: campaign.id,
        amazonAdGroupId: `amzn-ad-group-bf-${suffix}`,
        name: `BF ad group ${suffix}`,
        state: "enabled",
      });
      await upsertAd(pool, {
        profileId,
        adGroupId: adGroup.id,
        amazonAdId: `amzn-ad-bf-${suffix}`,
        asin: `B0BF${suffix.toUpperCase()}0001`,
        state: "enabled",
      });
      pks[suffix] = { campaignId: campaign.id, adGroupId: adGroup.id };
    }
    const bookA = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B0BFA0001",
      title: "Filter book A",
      format: "ebook",
    });
    const bookB = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B0BFB0001",
      title: "Filter book B",
      format: "ebook",
    });
    const unadvertised = await pool.query<{ id: string }>(
      `insert into books (workspace_id, asin, title, format)
       values ($1, 'B0BFNONE01', 'Unadvertised book', 'ebook')
       returning id::text as id`,
      [workspaceId],
    );
    const aOnly = [BigInt(bookA!.id)];
    const both = [BigInt(bookA!.id), BigInt(bookB!.id)];
    const noMatch = [BigInt(unadvertised.rows[0]!.id)];

    const metricValues = {
      impressions: 100,
      clicks: 10,
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
      units: 2,
      unitsSoldClicks7d: 2,
      unitsSoldClicks14d: 2,
      currency: "USD",
    };
    await upsertCampaignMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-bf-a",
        metricDate: "2026-08-13",
        cost: "10.00",
        sales: "40.00",
        orders: 4,
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-bf-b",
        metricDate: "2026-08-13",
        cost: "30.00",
        sales: "90.00",
        orders: 9,
      },
    ]);
    await upsertSearchTermMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-bf-a",
        adGroupId: "amzn-ad-group-bf-a",
        targetId: "amzn-target-bf-a",
        searchTerm: "alpha term",
        metricDate: "2026-08-13",
        cost: "10.00",
        sales: "40.00",
        orders: 4,
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-bf-b",
        adGroupId: "amzn-ad-group-bf-b",
        targetId: "amzn-target-bf-b",
        searchTerm: "beta term",
        metricDate: "2026-08-13",
        cost: "30.00",
        sales: "90.00",
        orders: 9,
      },
    ]);

    // Campaign rows: no filter, single book, union of two, no match, and an
    // empty selection behaving like no filter.
    const unfiltered = await listCampaignRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
    );
    expect(unfiltered).toHaveLength(2);
    expect(
      unfiltered.find((row) => row.amazonCampaignId === "amzn-campaign-bf-a")
        ?.bookIds,
    ).toEqual([bookA!.id]);
    expect(
      unfiltered.find((row) => row.amazonCampaignId === "amzn-campaign-bf-b")
        ?.bookIds,
    ).toEqual([bookB!.id]);

    const onlyA = await listCampaignRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      aOnly,
    );
    expect(onlyA.map((row) => row.amazonCampaignId)).toEqual([
      "amzn-campaign-bf-a",
    ]);
    expect(onlyA[0]!.totals.cost).toBe("10.0000");

    const union = await listCampaignRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      both,
    );
    expect(union.map((row) => row.amazonCampaignId).sort()).toEqual([
      "amzn-campaign-bf-a",
      "amzn-campaign-bf-b",
    ]);

    const emptySelection = await listCampaignRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      [],
    );
    expect(emptySelection).toHaveLength(2);

    await expect(
      listCampaignRows(pool, workspaceId, "2026-08-13", "2026-08-14", noMatch),
    ).resolves.toEqual([]);

    // Cross-campaign search terms follow the same selection.
    const termsA = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      aOnly,
    );
    expect(termsA.map((row) => row.searchTerm)).toEqual(["alpha term"]);
    expect(termsA[0]!.totals.cost).toBe("10.0000");
    expect(termsA[0]!.bookIds).toEqual([bookA!.id]);

    const termsBoth = await listSearchTermRollupRows(
      pool,
      workspaceId,
      "2026-08-13",
      "2026-08-14",
      both,
    );
    expect(termsBoth.map((row) => row.searchTerm).sort()).toEqual([
      "alpha term",
      "beta term",
    ]);

    await expect(
      listSearchTermRollupRows(
        pool,
        workspaceId,
        "2026-08-13",
        "2026-08-14",
        noMatch,
      ),
    ).resolves.toEqual([]);

    await expect(
      listSearchTermCampaignRows(
        pool,
        workspaceId,
        "beta term",
        "2026-08-13",
        "2026-08-14",
        aOnly,
      ),
    ).resolves.toEqual([]);
    const betaBoth = await listSearchTermCampaignRows(
      pool,
      workspaceId,
      "beta term",
      "2026-08-13",
      "2026-08-14",
      both,
    );
    expect(betaBoth.map((row) => row.amazonCampaignId)).toEqual([
      "amzn-campaign-bf-b",
    ]);

    const dailyA = await searchTermDailySeries(
      pool,
      workspaceId,
      "alpha term",
      "US",
      "2026-08-13",
      "2026-08-14",
      aOnly,
    );
    expect(dailyA).toHaveLength(1);
    await expect(
      searchTermDailySeries(
        pool,
        workspaceId,
        "beta term",
        "US",
        "2026-08-13",
        "2026-08-14",
        aOnly,
      ),
    ).resolves.toEqual([]);

    // The overview summary totals follow the same filter.
    await expect(
      dashboardTotals(pool, profileId, "2026-08-13", "2026-08-14", aOnly),
    ).resolves.toMatchObject({ cost: "10.0000", orders: 4 });
    await expect(
      dashboardTotals(pool, profileId, "2026-08-13", "2026-08-14", both),
    ).resolves.toMatchObject({ cost: "40.0000", orders: 13 });
    await expect(
      dashboardTotals(pool, profileId, "2026-08-13", "2026-08-14", noMatch),
    ).resolves.toBeNull();

    // Recommendations: campaign-linked, ad-group-linked, and one without any
    // book attribution (stays listed under every selection).
    const recDefaults = {
      profileId,
      type: "expensive_target" as const,
      priority: 2,
      evidenceWindowStart: "2026-08-01",
      evidenceWindowEnd: "2026-08-13",
      rationale: "book filter coverage",
      confidence: "0.8",
      ruleVersion: "expensive_target@1",
      dataFreshnessAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      evidenceInputs: {},
    };
    const recCampaignA = await insertRecommendation(pool, {
      ...recDefaults,
      campaignId: pks["a"]!.campaignId,
    });
    const recCampaignB = await insertRecommendation(pool, {
      ...recDefaults,
      campaignId: pks["b"]!.campaignId,
    });
    const recAdGroupA = await insertRecommendation(pool, {
      ...recDefaults,
      campaignId: pks["a"]!.campaignId,
      adGroupId: pks["a"]!.adGroupId,
    });
    const recProfileLevel = await insertRecommendation(pool, recDefaults);

    const recsA = await listRecommendationsByWorkspace(pool, workspaceId, {
      bookIds: aOnly,
    });
    expect(recsA.map((rec) => rec.id).sort()).toEqual(
      [recCampaignA.id, recAdGroupA.id, recProfileLevel.id].map(String).sort(),
    );

    const recsBoth = await listRecommendationsByWorkspace(pool, workspaceId, {
      bookIds: both,
    });
    expect(recsBoth.map((rec) => rec.id).sort()).toEqual(
      [recCampaignA.id, recCampaignB.id, recAdGroupA.id, recProfileLevel.id]
        .map(String)
        .sort(),
    );

    const recsNone = await listRecommendationsByWorkspace(pool, workspaceId, {
      bookIds: noMatch,
    });
    expect(recsNone.map((rec) => rec.id)).toEqual([String(recProfileLevel.id)]);
  });

  it("recommendations store immutable evidence and expire stale rows", async () => {
    const profileId = await seedProfile(pool);
    const rec = await insertRecommendation(pool, {
      profileId,
      type: "expensive_target",
      priority: 2,
      evidenceWindowStart: "2026-07-01",
      evidenceWindowEnd: "2026-07-14",
      currentValue: "0.75",
      proposedValue: "0.64",
      rationale: "ACoS materially above target",
      confidence: "0.8",
      ruleVersion: "expensive_target@1",
      dataFreshnessAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // already stale
      evidenceInputs: { clicks: 42, cost: "31.50", acos: 0.63 },
    });
    expect(rec.state).toBe("pending");

    const evidence = await pool.query<{ inputs: unknown }>(
      `select inputs from recommendation_evidence where recommendation_id = $1`,
      [rec.id],
    );
    expect(evidence.rows[0]!.inputs).toEqual({
      clicks: 42,
      cost: "31.50",
      acos: 0.63,
    });

    // Guarded transition + stale expiry.
    const approved = await transitionRecommendationState(
      pool,
      rec.id,
      "pending",
      "approved",
    );
    expect(approved?.state).toBe("approved");
    const doubleApprove = await transitionRecommendationState(
      pool,
      rec.id,
      "pending",
      "approved",
    );
    expect(doubleApprove).toBeNull();

    const stale = await insertRecommendation(pool, {
      profileId,
      type: "low_impressions",
      priority: 4,
      evidenceWindowStart: "2026-07-01",
      evidenceWindowEnd: "2026-07-14",
      rationale: "Little traffic",
      confidence: "0.4",
      ruleVersion: "low_impressions@1",
      dataFreshnessAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      evidenceInputs: {},
    });
    expect(await expireStaleRecommendations(pool)).toBeGreaterThanOrEqual(1);
    const states = await pool.query<{ state: string }>(
      `select state from recommendations where id = any($1::bigint[])`,
      [[rec.id, stale.id]],
    );
    expect(states.rows.map((r) => r.state).sort()).toEqual([
      "approved",
      "expired",
    ]);
  });

  it("change set creation is idempotent by fingerprint", async () => {
    const profileId = await seedProfile(pool);
    const user = await pool.query<{ id: string }>(
      `insert into users (email) values ('owner@example.com') returning id`,
    );
    const creatorUserId = user.rows[0]!.id;
    const action = {
      actionType: "update_bid" as const,
      beforeValue: "0.75",
      afterValue: "0.64",
      fingerprint: buildChangeActionFingerprint({
        changeSetId: "pending",
        actionType: "update_bid",
        beforeValue: "0.75",
        afterValue: "0.64",
      }),
    };
    const input = {
      profileId,
      creatorUserId,
      fingerprint: buildChangeSetFingerprint({
        profileId,
        creatorUserId,
        actions: [action],
      }),
      actions: [action],
    };
    const first = await createChangeSet(pool, input);
    expect(first.created).toBe(true);
    expect(first.actions).toHaveLength(1);

    // Replay with the same fingerprint returns the original set.
    const replay = await createChangeSet(pool, input);
    expect(replay.created).toBe(false);
    expect(replay.changeSet.id).toBe(first.changeSet.id);
    expect(replay.actions[0]!.id).toBe(first.actions[0]!.id);

    const byFingerprint = await findChangeActionByFingerprint(
      pool,
      action.fingerprint,
    );
    expect(byFingerprint?.id).toBe(first.actions[0]!.id);
  });

  it("listRecentAppliedActions falls back to the Amazon entity id when no internal target exists", async () => {
    const profileId = await seedProfile(pool);
    const user = await pool.query<{ id: string }>(
      `insert into users (email) values ('cooldown@example.com') returning id`,
    );
    const set = await pool.query<{ id: string }>(
      `insert into change_sets (profile_id, creator_user_id, status, fingerprint, applied_at)
       values ($1, $2, 'applied', 'fp-recent-coalesce', now()) returning id`,
      [profileId, user.rows[0]!.id],
    );
    // Live bid applies record only the Amazon entity id; the cooldown input
    // must surface it as targetId or matching degenerates to null = null.
    await pool.query(
      `insert into change_actions (change_set_id, action_type, fingerprint, status, amazon_entity_id)
       values ($1, 'update_bid', 'afp-recent-coalesce', 'applied', '454063756440621')`,
      [set.rows[0]!.id],
    );

    const recent = await listRecentAppliedActions(
      pool,
      profileId,
      new Date(Date.now() - 86_400_000),
    );
    expect(recent).toHaveLength(1);
    expect(recent[0]!.targetId).toBe("454063756440621");
  });

  it("values overview royalty per book and marketplace, not one rate per country", async () => {
    const profileId = await seedProfile(pool);
    const workspace = await pool.query<{
      workspace_id: string;
      connection_id: string;
    }>(
      `select c.workspace_id::text, c.id::text as connection_id
       from amazon_profiles p join amazon_connections c on c.id = p.connection_id
       where p.id = $1`,
      [profileId],
    );
    const workspaceId = workspace.rows[0]!.workspace_id;
    const ukProfile = await pool.query<{ id: string }>(
      `insert into amazon_profiles
         (connection_id, profile_id, region, country_code, currency_code)
       values ($1, 'amzn-profile-uk-' || gen_random_uuid(), 'EU', 'GB', 'GBP')
       returning id::text as id`,
      [workspace.rows[0]!.connection_id],
    );
    const ukProfileId = ukProfile.rows[0]!.id;

    const usCampaign = await upsertCampaign(pool, {
      profileId,
      amazonCampaignId: "amzn-campaign-ov-us",
      name: "US campaign",
      state: "enabled",
    });
    const usAdGroup = await upsertAdGroup(pool, {
      profileId,
      campaignId: usCampaign.id,
      amazonAdGroupId: "amzn-ad-group-ov-us",
      name: "US ad group",
      state: "enabled",
    });
    await upsertAd(pool, {
      profileId,
      adGroupId: usAdGroup.id,
      amazonAdId: "amzn-ad-ov-tractor",
      asin: "B0TRACTOR1",
      state: "enabled",
    });
    await upsertAd(pool, {
      profileId,
      adGroupId: usAdGroup.id,
      amazonAdId: "amzn-ad-ov-other",
      asin: "B0OTHER0001",
      state: "enabled",
    });

    const ukCampaign = await upsertCampaign(pool, {
      profileId: ukProfileId,
      amazonCampaignId: "amzn-campaign-ov-uk",
      name: "UK campaign",
      state: "enabled",
    });
    const ukAdGroup = await upsertAdGroup(pool, {
      profileId: ukProfileId,
      campaignId: ukCampaign.id,
      amazonAdGroupId: "amzn-ad-group-ov-uk",
      name: "UK ad group",
      state: "enabled",
    });
    await upsertAd(pool, {
      profileId: ukProfileId,
      adGroupId: ukAdGroup.id,
      amazonAdId: "amzn-ad-ov-tractor-uk",
      asin: "B0TRACTOR1",
      state: "enabled",
    });

    const tractor = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId, ukProfileId],
      asin: "B0TRACTOR1",
      title: "Tractor Coloring Book",
      format: "paperback",
    });
    const other = await mapAdvertisedProductToBook(pool, {
      workspaceId,
      profileIds: [profileId],
      asin: "B0OTHER0001",
      title: "Other Coloring Book",
      format: "paperback",
    });

    await upsertBookEconomics(pool, {
      bookId: tractor!.id,
      profileId,
      effectiveFrom: "2026-08-13",
      currency: "USD",
      listPrice: "10.45",
      estimatedRoyaltyPerSale: "3.43",
      goalMode: "balanced",
    });
    await upsertBookEconomics(pool, {
      bookId: tractor!.id,
      profileId: ukProfileId,
      effectiveFrom: "2026-08-13",
      currency: "GBP",
      listPrice: "8.99",
      estimatedRoyaltyPerSale: "1.50",
      goalMode: "balanced",
    });
    await upsertBookEconomics(pool, {
      bookId: other!.id,
      profileId,
      effectiveFrom: "2026-08-18",
      currency: "USD",
      listPrice: "9.99",
      estimatedRoyaltyPerSale: "2.09",
      goalMode: "balanced",
    });

    const metricValues = {
      impressions: 100,
      clicks: 10,
      cost: "5.00",
      sales: "20.00",
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
      units: 2,
      unitsSoldClicks7d: 2,
      unitsSoldClicks14d: 2,
    };
    await upsertAdvertisedProductMetrics(pool, [
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-ov-us",
        adGroupId: "amzn-ad-group-ov-us",
        adId: "amzn-ad-ov-tractor",
        metricDate: "2026-08-13",
        orders: 6,
        currency: "USD",
      },
      {
        ...metricValues,
        profileId,
        campaignId: "amzn-campaign-ov-us",
        adGroupId: "amzn-ad-group-ov-us",
        adId: "amzn-ad-ov-other",
        metricDate: "2026-08-18",
        orders: 4,
        currency: "USD",
      },
      {
        ...metricValues,
        profileId: ukProfileId,
        campaignId: "amzn-campaign-ov-uk",
        adGroupId: "amzn-ad-group-ov-uk",
        adId: "amzn-ad-ov-tractor-uk",
        metricDate: "2026-08-13",
        orders: 2,
        currency: "GBP",
      },
    ]);

    const tractorOnly = [BigInt(tractor!.id)];
    const usTractor = await overviewRoyaltySeries(
      pool,
      [profileId],
      "2026-08-13",
      "2026-08-13",
      tractorOnly,
    );
    expect(usTractor).toEqual([
      {
        date: "2026-08-13",
        profilePk: profileId,
        currency: "USD",
        estimatedRoyalty: "20.5800",
        economicsMissing: false,
      },
    ]);

    const usAll = await overviewRoyaltySeries(
      pool,
      [profileId],
      "2026-08-13",
      "2026-08-18",
    );
    expect(usAll).toEqual([
      {
        date: "2026-08-13",
        profilePk: profileId,
        currency: "USD",
        estimatedRoyalty: "20.5800",
        economicsMissing: false,
      },
      {
        date: "2026-08-18",
        profilePk: profileId,
        currency: "USD",
        estimatedRoyalty: "8.3600",
        economicsMissing: false,
      },
    ]);

    const ukTractor = await overviewRoyaltySeries(
      pool,
      [ukProfileId],
      "2026-08-13",
      "2026-08-13",
      tractorOnly,
    );
    expect(ukTractor).toEqual([
      {
        date: "2026-08-13",
        profilePk: ukProfileId,
        currency: "GBP",
        estimatedRoyalty: "3.0000",
        economicsMissing: false,
      },
    ]);
  });
});
