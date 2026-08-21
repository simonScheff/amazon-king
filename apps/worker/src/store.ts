import {
  metrics,
  profiles as profilesRepo,
  reports as reportsRepo,
  structure as structureRepo,
  recommendations as recommendationsRepo,
  fx as fxRepo,
  withTransaction,
  enqueue as queueEnqueue,
  buildReportSpecFingerprint,
} from "@amazon-king/database";
import type { Db, Pool } from "@amazon-king/database";
import type { ProfileDirectoryEntry } from "@amazon-king/amazon-ads";
import type {
  SpReportTypeId,
  StructureSnapshot,
} from "@amazon-king/amazon-ads";

/** Report job lifecycle states (mirror of the database reports repository type,
 * duplicated here because the database package only exposes it through the
 * `reports` namespace and handlers need a standalone name). */
export type ReportJobStatus =
  | "queued"
  | "requested"
  | "polling"
  | "downloading"
  | "validating"
  | "importing"
  | "complete"
  | "retryable"
  | "failed"
  | "dead_letter";

type CampaignMetricsRow = metrics.CampaignMetricsRow;
type TargetMetricsRow = metrics.TargetMetricsRow;
type SearchTermMetricsRow = metrics.SearchTermMetricsRow;
type AdvertisedProductMetricsRow = metrics.AdvertisedProductMetricsRow;
type PlacementMetricsRow = metrics.PlacementMetricsRow;
type RecommendationInsert = recommendationsRepo.RecommendationInsert;
export type FxRateRow = fxRepo.FxRateRow;

/**
 * WorkerStore — the narrow persistence surface the job handlers depend on.
 * The production implementation delegates to @amazon-king/database
 * repositories where they exist and uses small direct queries for the
 * worker-specific reads (connections, freshness, optimizer inputs) that have
 * no repository yet. Tests substitute an in-memory fake.
 */

export interface ConnectionRecord {
  id: string;
  workspaceId: string;
  status: string;
}

export interface ProfileRecord {
  /** Internal amazon_profiles PK (string form of the bigint). */
  id: string;
  /** Amazon's own profile id (API scope). */
  amazonProfileId: string;
  connectionId: string;
  workspaceId: string;
  region: string;
  currencyCode: string;
  enabled: boolean;
}

export interface ReportJobRecord {
  id: string;
  syncRunId: string;
  profileId: string;
  reportType: string;
  specFingerprint: string;
  amazonReportId: string | null;
  status: ReportJobStatus;
  attempts: number;
  checksum: string | null;
  storageKey: string | null;
  error: string | null;
}

export interface CompletedSyncRun {
  id: string;
  finishedAt: string;
}

/** Union of the daily fact rows, tagged by the report family that produced them. */
export type MetricFactRows =
  | { reportType: "spCampaigns"; rows: CampaignMetricsRow[] }
  | { reportType: "spTargeting"; rows: TargetMetricsRow[] }
  | { reportType: "spSearchTerm"; rows: SearchTermMetricsRow[] }
  | { reportType: "spAdvertisedProduct"; rows: AdvertisedProductMetricsRow[] }
  | { reportType: "placement"; rows: PlacementMetricsRow[] };

export interface CampaignRow {
  id: string;
  amazonCampaignId: string;
  name: string;
  state: string;
  targetingType: string | null;
  dailyBudget: string | null;
}

export interface AdGroupRow {
  id: string;
  campaignId: string;
  amazonAdGroupId: string;
  state: string;
  defaultBid: string | null;
}

export interface AdRow {
  id: string;
  adGroupId: string;
  amazonAdId: string;
  asin: string;
  state: string;
}

export interface TargetRow {
  id: string;
  campaignId: string;
  adGroupId: string;
  amazonTargetId: string;
  targetKind: string;
  expression: unknown;
  matchType: string | null;
  bid: string | null;
  state: string;
}

/** Synced Amazon negative keyword; `adGroupId` null = campaign level. */
export interface NegativeKeywordRow {
  campaignId: string;
  adGroupId: string | null;
  keywordText: string;
  matchType: string;
  state: string;
}

/** Synced Amazon negative ASIN target; `adGroupId` null = campaign level. */
export interface NegativeTargetRow {
  campaignId: string;
  adGroupId: string | null;
  asin: string;
  state: string;
}

export interface StructureData {
  campaigns: CampaignRow[];
  adGroups: AdGroupRow[];
  ads: AdRow[];
  targets: TargetRow[];
  negativeKeywords: NegativeKeywordRow[];
  negativeTargets: NegativeTargetRow[];
}

/** One daily metric row in micros, keyed by Amazon entity id (as stored in the fact tables). */
export interface DailyFact {
  entityKey: string;
  /** Second grain dimension (search term text / placement), when applicable. */
  subKey: string | null;
  campaignAmazonId: string;
  date: string;
  currency: string;
  impressions: number;
  clicks: number;
  orders: number;
  /** Copies sold; 0 on facts imported before the units columns existed. */
  units: number;
  costMicros: number;
  salesMicros: number;
}

export interface RecentChangeRecord {
  actionType: "update_bid" | "add_negative_exact";
  targetId: string | null;
  campaignId: string | null;
  searchTerm: string | null;
  changedAt: string;
}

export interface BookEconomicsRecord {
  marketplaceAsin: string;
  currency: string;
  estimatedRoyaltyPerSale: string;
  targetAcos: string | null;
  goalMode: "profit" | "balanced" | "launch" | "visibility";
  maxBid: string | null;
  maxDailyBudget: string | null;
}

export interface RecommendationIdentity {
  profileId: string;
  type: string;
  campaignId: string | null;
  adGroupId: string | null;
  targetId: string | null;
  searchTerm: string | null;
}

export interface WorkerStore {
  // --- connections ---
  listActiveConnections(): Promise<ConnectionRecord[]>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  setConnectionError(
    connectionId: string,
    errorCode: string | null,
  ): Promise<void>;
  markConnectionReconnectRequired(
    connectionId: string,
    errorCode: string,
  ): Promise<void>;
  /** Dead-letter pending jobs tied to a dead grant (plan §5 step 4). */
  failPendingJobsForConnection(
    connectionId: string,
    reason: string,
  ): Promise<number>;
  loadEncryptedRefreshToken(connectionId: string): Promise<Buffer | null>;
  persistRefreshToken(
    connectionId: string,
    ciphertext: Buffer,
    keyVersion: number,
  ): Promise<void>;

  // --- profiles / gateway directory ---
  getProfile(profilePk: string): Promise<ProfileRecord | null>;
  listEnabledProfiles(): Promise<ProfileRecord[]>;
  insertDiscoveredProfile(input: {
    connectionId: string;
    profileId: string;
    accountId: string | null;
    region: "NA" | "EU" | "FE";
    countryCode: string;
    currencyCode: string;
    timezone: string | null;
    accountType: string | null;
  }): Promise<void>;
  /** Gateway profileDirectory: internal PK -> request-context metadata. Throws when unknown. */
  getGatewayProfile(profilePk: string): Promise<ProfileDirectoryEntry>;
  /** Gateway reportOwner: Amazon report id -> owning internal profile PK (restart resume). */
  findProfilePkForReport(amazonReportId: string): Promise<string | null>;

  // --- sync runs ---
  createSyncRun(
    profilePk: string,
    kind: "structure" | "metrics" | "backfill",
  ): Promise<string>;
  finishSyncRun(
    syncRunId: string,
    status: "complete" | "failed",
    error?: string,
  ): Promise<void>;
  latestCompletedSyncRun(
    profilePk: string,
    kind: string,
  ): Promise<CompletedSyncRun | null>;

  // --- report jobs (plan §8 state machine) ---
  findReportJobByFingerprint(
    specFingerprint: string,
  ): Promise<ReportJobRecord | null>;
  createReportJob(input: {
    syncRunId: string;
    profileId: string;
    reportType: string;
    specFingerprint: string;
    dateStart: string;
    dateEnd: string;
  }): Promise<ReportJobRecord>;
  updateReportJob(
    reportJobId: string,
    update: {
      status: ReportJobStatus;
      amazonReportId?: string;
      checksum?: string;
      storageKey?: string;
      error?: string | null;
      incrementAttempts?: boolean;
    },
  ): Promise<void>;

  // --- metrics import (single transaction, idempotent upsert) ---
  importMetrics(facts: MetricFactRows): Promise<number>;

  // --- fx rates (docs/fx-rates-all-market-plan.md §2) ---
  /** Batch-insert fixings (ON CONFLICT DO NOTHING). Returns rows actually inserted. */
  upsertFxRates(rows: readonly FxRateRow[]): Promise<number>;
  /** Latest stored fixing date; null when no rates have been synced yet. */
  getLatestFxRateDate(): Promise<string | null>;
  /** Oldest metric date across the workspace's fact tables (fx backfill depth). */
  getEarliestFactDate(): Promise<string | null>;

  // --- structure ---
  applyStructureSnapshot(
    profile: ProfileRecord,
    snapshot: StructureSnapshot,
  ): Promise<void>;

  // --- queue helpers ---
  enqueue(type: string, payload: unknown, runAt?: Date): Promise<string>;
  /** Enqueue only when no pending/running job of the same type + payload exists. Returns null when skipped. */
  enqueueIfNotQueued(
    type: string,
    payload: unknown,
    runAt?: Date,
  ): Promise<string | null>;
  hasPendingJob(type: string): Promise<boolean>;

  // --- optimizer inputs ---
  loadStructure(profilePk: string): Promise<StructureData>;
  loadDailyFacts(
    profilePk: string,
    sinceDate: string,
  ): Promise<{
    campaign: DailyFact[];
    target: DailyFact[];
    searchTerm: DailyFact[];
    placement: DailyFact[];
  }>;
  listRecentChanges(
    profilePk: string,
    sinceIso: string,
  ): Promise<RecentChangeRecord[]>;
  listBookEconomics(profilePk: string): Promise<BookEconomicsRecord[]>;

  // --- recommendations ---
  expireStaleRecommendations(): Promise<number>;
  pendingRecommendationExists(
    identity: RecommendationIdentity,
  ): Promise<boolean>;
  /** True when the owner rejected this finding and the suppression still holds. */
  recommendationDismissed(identity: RecommendationIdentity): Promise<boolean>;
  /** Expire pending/approved findings that the current run no longer considers valid. */
  expirePendingRecommendations(
    identity: RecommendationIdentity,
  ): Promise<number>;
  insertRecommendation(input: RecommendationInsert): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

function toReportJobRecord(row: reportsRepo.ReportJob): ReportJobRecord {
  return {
    id: row.id,
    syncRunId: row.syncRunId,
    profileId: row.profileId,
    reportType: row.reportType,
    specFingerprint: row.specFingerprint,
    amazonReportId: row.amazonReportId,
    status: row.status,
    attempts: row.attempts,
    checksum: row.checksum,
    storageKey: row.storageKey,
    error: row.error,
  };
}

function asinSameAsFromExpression(
  expression: { type: string; value?: string }[] | undefined,
): string | null {
  if (!expression) return null;
  for (const entry of expression) {
    if (entry.type === "ASIN_SAME_AS" && entry.value?.trim()) {
      return entry.value.trim().toUpperCase();
    }
  }
  return null;
}

export function createDbStore(pool: Pool): WorkerStore {
  const db: Db = pool;
  return {
    async listActiveConnections() {
      const result = await db.query<{
        id: string;
        workspace_id: string;
        status: string;
      }>(
        `select id::text, workspace_id::text, status from amazon_connections
         where status = 'connected' order by id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        status: row.status,
      }));
    },

    async getConnection(connectionId) {
      const result = await db.query<{
        id: string;
        workspace_id: string;
        status: string;
      }>(
        `select id::text, workspace_id::text, status from amazon_connections where id = $1`,
        [connectionId],
      );
      const row = result.rows[0];
      return row
        ? { id: row.id, workspaceId: row.workspace_id, status: row.status }
        : null;
    },

    async setConnectionError(connectionId, errorCode) {
      await db.query(
        `update amazon_connections set last_error_code = $2 where id = $1`,
        [connectionId, errorCode],
      );
    },

    async markConnectionReconnectRequired(connectionId, errorCode) {
      await db.query(
        `update amazon_connections set status = 'reconnect_required', last_error_code = $2
         where id = $1 and status = 'connected'`,
        [connectionId, errorCode],
      );
    },

    async failPendingJobsForConnection(connectionId, reason) {
      const result = await db.query<{ id: string }>(
        `update job_queue set status = 'dead', last_error = $2
         where status = 'pending' and (
           payload->>'connectionId' = $1
           or payload->>'profileId' in (
             select id::text from amazon_profiles where connection_id = $1
           )
         )
         returning id`,
        [connectionId, reason],
      );
      return result.rowCount ?? 0;
    },

    async loadEncryptedRefreshToken(connectionId) {
      const result = await db.query<{ encrypted_refresh_token: Buffer }>(
        `select encrypted_refresh_token from amazon_connections
         where id = $1 and status = 'connected'`,
        [connectionId],
      );
      return result.rows[0]?.encrypted_refresh_token ?? null;
    },

    async persistRefreshToken(connectionId, ciphertext, keyVersion) {
      await db.query(
        `update amazon_connections set encrypted_refresh_token = $2, encryption_key_version = $3
         where id = $1`,
        [connectionId, ciphertext, keyVersion],
      );
    },

    async getProfile(profilePk) {
      const result = await db.query<{
        id: string;
        profile_id: string;
        connection_id: string;
        workspace_id: string;
        region: string;
        currency_code: string;
        enabled: boolean;
      }>(
        `select p.id::text, p.profile_id, p.connection_id::text, c.workspace_id::text,
                p.region, p.currency_code, p.enabled
         from amazon_profiles p
         join amazon_connections c on c.id = p.connection_id
         where p.id = $1`,
        [profilePk],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            amazonProfileId: row.profile_id,
            connectionId: row.connection_id,
            workspaceId: row.workspace_id,
            region: row.region,
            currencyCode: row.currency_code,
            enabled: row.enabled,
          }
        : null;
    },

    async listEnabledProfiles() {
      const result = await db.query<{
        id: string;
        profile_id: string;
        connection_id: string;
        workspace_id: string;
        region: string;
        currency_code: string;
        enabled: boolean;
      }>(
        `select p.id::text, p.profile_id, p.connection_id::text, c.workspace_id::text,
                p.region, p.currency_code, p.enabled
         from amazon_profiles p
         join amazon_connections c on c.id = p.connection_id
         where p.enabled = true and c.status = 'connected'
         order by p.id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        amazonProfileId: row.profile_id,
        connectionId: row.connection_id,
        workspaceId: row.workspace_id,
        region: row.region,
        currencyCode: row.currency_code,
        enabled: row.enabled,
      }));
    },

    async insertDiscoveredProfile(input) {
      // New profiles default to disabled (schema default, plan §5 step 5).
      await profilesRepo.insertProfile(db, input);
    },

    async getGatewayProfile(profilePk) {
      const result = await db.query<{
        profile_id: string;
        connection_id: string;
        region: "NA" | "EU" | "FE";
        account_id: string | null;
      }>(
        `select profile_id, connection_id::text, region, account_id
         from amazon_profiles where id = $1`,
        [profilePk],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          `Unknown profile ${profilePk}: no gateway metadata on record`,
        );
      }
      return {
        profileId: row.profile_id,
        connectionId: row.connection_id,
        region: row.region,
        accountId: row.account_id,
      };
    },

    async findProfilePkForReport(amazonReportId) {
      const result = await db.query<{ profile_id: string }>(
        `select profile_id::text from report_jobs
         where amazon_report_id = $1 order by id desc limit 1`,
        [amazonReportId],
      );
      return result.rows[0]?.profile_id ?? null;
    },

    createSyncRun(profilePk, kind) {
      return reportsRepo.createSyncRun(db, profilePk, kind);
    },

    async finishSyncRun(syncRunId, status, error) {
      await reportsRepo.finishSyncRun(db, syncRunId, status, error ?? null);
    },

    async latestCompletedSyncRun(profilePk, kind) {
      const result = await db.query<{ id: string; finished_at: string }>(
        `select id::text, finished_at::text from sync_runs
         where profile_id = $1 and kind = $2 and status = 'complete'
         order by finished_at desc limit 1`,
        [profilePk, kind],
      );
      const row = result.rows[0];
      return row ? { id: row.id, finishedAt: row.finished_at } : null;
    },

    async findReportJobByFingerprint(specFingerprint) {
      const row = await reportsRepo.findReportJobByFingerprint(
        db,
        specFingerprint,
      );
      return row ? toReportJobRecord(row) : null;
    },

    async createReportJob(input) {
      const row = await reportsRepo.createReportJob(db, input);
      return toReportJobRecord(row);
    },

    async updateReportJob(reportJobId, update) {
      await reportsRepo.updateReportJob(db, reportJobId, update);
    },

    async importMetrics(facts) {
      return withTransaction(pool, async (client) => {
        switch (facts.reportType) {
          case "spCampaigns":
            return metrics.upsertCampaignMetrics(client, facts.rows);
          case "spTargeting":
            return metrics.upsertTargetMetrics(client, facts.rows);
          case "spSearchTerm":
            return metrics.upsertSearchTermMetrics(client, facts.rows);
          case "spAdvertisedProduct":
            return metrics.upsertAdvertisedProductMetrics(client, facts.rows);
          case "placement":
            return metrics.upsertPlacementMetrics(client, facts.rows);
        }
      });
    },

    async upsertFxRates(rows) {
      return fxRepo.upsertFxRates(db, rows);
    },

    getLatestFxRateDate() {
      return fxRepo.getLatestRateDate(db);
    },

    async getEarliestFactDate() {
      // Single-workspace product: fx rates are workspace-global, so resolve
      // the one workspace here instead of threading its id through the payload.
      const workspace = await db.query<{ id: string }>(
        `select id::text from workspaces order by id limit 1`,
      );
      const workspaceId = workspace.rows[0]?.id;
      if (!workspaceId) return null;
      return fxRepo.getEarliestFactDate(db, workspaceId);
    },

    async applyStructureSnapshot(profile, snapshot) {
      await withTransaction(pool, async (client) => {
        const campaignIds = new Map<string, string>();
        const adGroupIds = new Map<string, string>();
        for (const campaign of snapshot.campaigns) {
          const result = await structureRepo.upsertCampaign(client, {
            profileId: profile.id,
            amazonCampaignId: campaign.campaignId,
            name: campaign.name,
            state: campaign.state,
            targetingType: campaign.targetingType,
            dailyBudget:
              campaign.dailyBudget === null
                ? null
                : String(campaign.dailyBudget),
            startDate: campaign.startDate,
            endDate: campaign.endDate,
            rawJson: campaign.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
          campaignIds.set(campaign.campaignId, result.id);
        }
        for (const adGroup of snapshot.adGroups) {
          const campaignId = campaignIds.get(adGroup.campaignId);
          if (!campaignId) continue;
          const result = await structureRepo.upsertAdGroup(client, {
            profileId: profile.id,
            campaignId,
            amazonAdGroupId: adGroup.adGroupId,
            name: adGroup.name,
            state: adGroup.state,
            defaultBid:
              adGroup.defaultBid === null ? null : String(adGroup.defaultBid),
            rawJson: adGroup.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
          adGroupIds.set(adGroup.adGroupId, result.id);
        }
        for (const ad of snapshot.ads) {
          const adGroupId = adGroupIds.get(ad.adGroupId);
          if (!adGroupId || !ad.asin) continue;
          await structureRepo.upsertAd(client, {
            profileId: profile.id,
            adGroupId,
            amazonAdId: ad.adId,
            asin: ad.asin,
            state: ad.state,
            rawJson: ad.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
        }
        // Keywords and product targets share the targets table (plan §7).
        for (const keyword of snapshot.keywords) {
          const campaignId = campaignIds.get(keyword.campaignId);
          const adGroupId = adGroupIds.get(keyword.adGroupId);
          if (!campaignId || !adGroupId) continue;
          await structureRepo.upsertTarget(client, {
            profileId: profile.id,
            campaignId,
            adGroupId,
            amazonTargetId: keyword.keywordId,
            targetKind: "keyword",
            expression: { type: "keyword", value: keyword.keywordText },
            matchType: keyword.matchType,
            bid: keyword.bid === null ? null : String(keyword.bid),
            state: keyword.state,
            rawJson: keyword.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
        }
        for (const target of snapshot.targets) {
          const campaignId = campaignIds.get(target.campaignId);
          const adGroupId = adGroupIds.get(target.adGroupId);
          if (!campaignId || !adGroupId) continue;
          await structureRepo.upsertTarget(client, {
            profileId: profile.id,
            campaignId,
            adGroupId,
            amazonTargetId: target.targetId,
            targetKind: "product",
            expression: target.raw,
            matchType: null,
            bid: target.bid === null ? null : String(target.bid),
            state: target.state,
            rawJson: target.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
        }
        const persistedNegativeIds: string[] = [];
        for (const negative of snapshot.negativeKeywords) {
          const campaignId = campaignIds.get(negative.campaignId);
          const adGroupId = negative.adGroupId
            ? adGroupIds.get(negative.adGroupId)
            : null;
          if (!campaignId || (negative.adGroupId && !adGroupId)) continue;
          await structureRepo.upsertNegativeKeyword(client, {
            profileId: profile.id,
            campaignId,
            adGroupId,
            amazonNegativeKeywordId: negative.negativeKeywordId,
            keywordText: negative.keywordText,
            matchType: negative.matchType,
            state: negative.state,
            rawJson: negative.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
          persistedNegativeIds.push(negative.negativeKeywordId);
        }
        await structureRepo.deleteMissingNegativeKeywords(
          client,
          profile.id,
          persistedNegativeIds,
        );
        const persistedNegativeTargetIds: string[] = [];
        for (const negative of snapshot.negativeTargets ?? []) {
          const asin = asinSameAsFromExpression(negative.expression);
          if (!asin) continue;
          const campaignId = campaignIds.get(negative.campaignId);
          const adGroupId = negative.adGroupId
            ? adGroupIds.get(negative.adGroupId)
            : null;
          if (!campaignId || (negative.adGroupId && !adGroupId)) continue;
          await structureRepo.upsertNegativeTarget(client, {
            profileId: profile.id,
            campaignId,
            adGroupId,
            amazonNegativeTargetId: negative.negativeTargetId,
            expressionAsin: asin,
            state: negative.state,
            rawJson: negative.raw,
            sourceUpdatedAt: snapshot.retrievedAt,
          });
          persistedNegativeTargetIds.push(negative.negativeTargetId);
        }
        await structureRepo.deleteMissingNegativeTargets(
          client,
          profile.id,
          persistedNegativeTargetIds,
        );
      });
    },

    enqueue(type, payload, runAt) {
      return queueEnqueue(db, type, payload, runAt);
    },

    async enqueueIfNotQueued(type, payload, runAt) {
      const existing = await db.query<{ id: string }>(
        `select id::text from job_queue
         where type = $1 and status in ('pending', 'running') and payload @> $2::jsonb
         limit 1`,
        [type, JSON.stringify(payload)],
      );
      if (existing.rows[0]) {
        return null;
      }
      return queueEnqueue(db, type, payload, runAt);
    },

    async hasPendingJob(type) {
      const result = await db.query<{ id: string }>(
        `select id::text from job_queue where type = $1 and status = 'pending' limit 1`,
        [type],
      );
      return result.rows.length > 0;
    },

    async loadStructure(profilePk) {
      const [
        campaigns,
        adGroups,
        ads,
        targets,
        negativeKeywords,
        negativeTargets,
      ] = await Promise.all([
        db.query<{
          id: string;
          amazon_campaign_id: string;
          name: string;
          state: string;
          targeting_type: string | null;
          daily_budget: string | null;
        }>(
          `select id::text, amazon_campaign_id, name, state, targeting_type, daily_budget::text
           from campaigns where profile_id = $1`,
          [profilePk],
        ),
        db.query<{
          id: string;
          campaign_id: string;
          amazon_ad_group_id: string;
          state: string;
          default_bid: string | null;
        }>(
          `select id::text, campaign_id::text, amazon_ad_group_id, state, default_bid::text
           from ad_groups where profile_id = $1`,
          [profilePk],
        ),
        db.query<{
          id: string;
          ad_group_id: string;
          amazon_ad_id: string;
          asin: string;
          state: string;
        }>(
          `select id::text, ad_group_id::text, amazon_ad_id, asin, state
           from ads where profile_id = $1`,
          [profilePk],
        ),
        db.query<{
          id: string;
          campaign_id: string;
          ad_group_id: string;
          amazon_target_id: string;
          target_kind: string;
          expression: unknown;
          match_type: string | null;
          bid: string | null;
          state: string;
        }>(
          `select id::text, campaign_id::text, ad_group_id::text, amazon_target_id, target_kind,
                  expression, match_type, bid::text, state
           from targets where profile_id = $1`,
          [profilePk],
        ),
        db.query<{
          campaign_id: string;
          ad_group_id: string | null;
          keyword_text: string;
          match_type: string;
          state: string;
        }>(
          `select campaign_id::text, ad_group_id::text, keyword_text, match_type, state
           from negative_keywords where profile_id = $1`,
          [profilePk],
        ),
        db.query<{
          campaign_id: string;
          ad_group_id: string | null;
          expression_asin: string;
          state: string;
        }>(
          `select campaign_id::text, ad_group_id::text, expression_asin, state
           from negative_targets where profile_id = $1`,
          [profilePk],
        ),
      ]);
      return {
        campaigns: campaigns.rows.map((row) => ({
          id: row.id,
          amazonCampaignId: row.amazon_campaign_id,
          name: row.name,
          state: row.state,
          targetingType: row.targeting_type,
          dailyBudget: row.daily_budget,
        })),
        adGroups: adGroups.rows.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          amazonAdGroupId: row.amazon_ad_group_id,
          state: row.state,
          defaultBid: row.default_bid,
        })),
        ads: ads.rows.map((row) => ({
          id: row.id,
          adGroupId: row.ad_group_id,
          amazonAdId: row.amazon_ad_id,
          asin: row.asin,
          state: row.state,
        })),
        targets: targets.rows.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          adGroupId: row.ad_group_id,
          amazonTargetId: row.amazon_target_id,
          targetKind: row.target_kind,
          expression: row.expression,
          matchType: row.match_type,
          bid: row.bid,
          state: row.state,
        })),
        negativeKeywords: negativeKeywords.rows.map((row) => ({
          campaignId: row.campaign_id,
          adGroupId: row.ad_group_id,
          keywordText: row.keyword_text,
          matchType: row.match_type,
          state: row.state,
        })),
        negativeTargets: negativeTargets.rows.map((row) => ({
          campaignId: row.campaign_id,
          adGroupId: row.ad_group_id,
          asin: row.expression_asin,
          state: row.state,
        })),
      };
    },

    async loadDailyFacts(profilePk, sinceDate) {
      const select = (table: string, grainCols: string) =>
        db.query<{
          entity_key: string;
          sub_key: string | null;
          campaign_id: string;
          metric_date: string;
          currency: string;
          impressions: number;
          clicks: number;
          orders: number;
          units: number;
          cost: string;
          sales: string;
        }>(
          `select ${grainCols}, metric_date::text, currency, impressions, clicks, orders,
                units, cost::text, sales::text
         from ${table} where profile_id = $1 and metric_date >= $2`,
          [profilePk, sinceDate],
        );
      const toFact = (row: {
        entity_key: string;
        sub_key: string | null;
        campaign_id: string;
        metric_date: string;
        currency: string;
        impressions: number;
        clicks: number;
        orders: number;
        units: number;
        cost: string;
        sales: string;
      }): DailyFact => ({
        entityKey: row.entity_key,
        subKey: row.sub_key,
        campaignAmazonId: row.campaign_id,
        date: row.metric_date,
        currency: row.currency,
        impressions: row.impressions,
        clicks: row.clicks,
        orders: row.orders,
        units: row.units,
        costMicros: Math.round(Number(row.cost) * 1_000_000),
        salesMicros: Math.round(Number(row.sales) * 1_000_000),
      });
      const [campaign, target, searchTerm, placement] = await Promise.all([
        select(
          "campaign_metrics_daily",
          "campaign_id as entity_key, null as sub_key, campaign_id",
        ),
        select(
          "target_metrics_daily",
          "target_id as entity_key, null as sub_key, campaign_id",
        ),
        select(
          "search_term_metrics_daily",
          "target_id as entity_key, search_term as sub_key, campaign_id",
        ),
        select(
          "placement_metrics_daily",
          "campaign_id as entity_key, placement as sub_key, campaign_id",
        ),
      ]);
      return {
        campaign: campaign.rows.map(toFact),
        target: target.rows.map(toFact),
        searchTerm: searchTerm.rows.map(toFact),
        placement: placement.rows.map(toFact),
      };
    },

    async listRecentChanges(profilePk, sinceIso) {
      const result = await db.query<{
        action_type: "update_bid" | "add_negative_exact";
        target_id: string | null;
        campaign_id: string | null;
        search_term: string | null;
        changed_at: string;
      }>(
        `select ca.action_type, ca.target_id::text, ca.campaign_id::text, ca.search_term,
                ca.created_at as changed_at
         from change_actions ca
         join change_sets cs on cs.id = ca.change_set_id
         where cs.profile_id = $1
           and ca.status in ('applied', 'partially_applied')
           and ca.created_at >= $2`,
        [profilePk, sinceIso],
      );
      return result.rows.map((row) => ({
        actionType: row.action_type,
        targetId: row.target_id,
        campaignId: row.campaign_id,
        searchTerm: row.search_term,
        changedAt: row.changed_at,
      }));
    },

    async listBookEconomics(profilePk) {
      const result = await db.query<{
        marketplace_asin: string;
        currency: string;
        estimated_royalty_per_sale: string;
        target_acos: string | null;
        goal_mode: "profit" | "balanced" | "launch" | "visibility";
        max_bid: string | null;
        max_daily_budget: string | null;
      }>(
        `select distinct on (bpl.book_id)
                bpl.marketplace_asin, be.currency, be.estimated_royalty_per_sale::text,
                be.target_acos::text, be.goal_mode, be.max_bid::text, be.max_daily_budget::text
         from book_profile_links bpl
         join book_economics be
           on be.book_id = bpl.book_id and be.profile_id = bpl.profile_id
         where bpl.profile_id = $1 and bpl.enabled = true
           and be.effective_from <= current_date
         order by bpl.book_id, be.effective_from desc`,
        [profilePk],
      );
      return result.rows.map((row) => ({
        marketplaceAsin: row.marketplace_asin,
        currency: row.currency,
        estimatedRoyaltyPerSale: row.estimated_royalty_per_sale,
        targetAcos: row.target_acos,
        goalMode: row.goal_mode,
        maxBid: row.max_bid,
        maxDailyBudget: row.max_daily_budget,
      }));
    },

    expireStaleRecommendations() {
      return recommendationsRepo.expireStaleRecommendations(db);
    },

    async pendingRecommendationExists(identity) {
      const result = await db.query<{ id: string }>(
        `select id::text from recommendations
         where state = 'pending' and profile_id = $1 and type = $2
           and campaign_id is not distinct from $3
           and ad_group_id is not distinct from $4
           and target_id is not distinct from $5
           and search_term is not distinct from $6
         limit 1`,
        [
          identity.profileId,
          identity.type,
          identity.campaignId,
          identity.adGroupId,
          identity.targetId,
          identity.searchTerm,
        ],
      );
      return result.rows.length > 0;
    },

    recommendationDismissed(identity) {
      return recommendationsRepo.activeDismissalExists(db, identity);
    },

    async expirePendingRecommendations(identity) {
      const result = await db.query<{ id: string }>(
        `update recommendations set state = 'expired'
         where state in ('pending', 'approved') and profile_id = $1 and type = $2
           and campaign_id is not distinct from $3
           and ad_group_id is not distinct from $4
           and target_id is not distinct from $5
           and search_term is not distinct from $6
         returning id::text`,
        [
          identity.profileId,
          identity.type,
          identity.campaignId,
          identity.adGroupId,
          identity.targetId,
          identity.searchTerm,
        ],
      );
      return result.rows.length;
    },

    async insertRecommendation(input) {
      await recommendationsRepo.insertRecommendation(db, input);
    },
  };
}

/** Re-exported for handlers so they do not import the database package for fingerprints. */
export { buildReportSpecFingerprint };
export type { SpReportTypeId };
