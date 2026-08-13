import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "./db.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import {
  upsertCampaignMetrics,
  upsertAdvertisedProductMetrics,
  dashboardTotals,
  MixedCurrencyError,
} from "./repositories/metrics.js";
import {
  campaignDailySeries,
  listCampaignRows,
} from "./repositories/dashboard.js";
import { enqueue, claim, reapExpiredLeases, complete } from "./queue.js";
import {
  upsertAd,
  upsertAdGroup,
  upsertCampaign,
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
  transitionRecommendationState,
  expireStaleRecommendations,
} from "./repositories/recommendations.js";
import {
  createChangeSet,
  findChangeActionByFingerprint,
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
    expect(applied).toEqual(["0001", "0002"]);
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
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
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
      purchases7d: 0,
      sales7d: "0",
      purchases14d: 0,
      sales14d: "0",
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
      purchases7d: 2,
      sales7d: "20.00",
      purchases14d: 2,
      sales14d: "20.00",
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
});
