import { createLogger } from "@amazon-king/observability";
import type { Logger } from "pino";
import type { Job } from "@amazon-king/database";
import type { WorkerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type {
  BookEconomicsRecord,
  CompletedSyncRun,
  ConnectionRecord,
  DailyFact,
  FxRateRow,
  MetricFactRows,
  ProfileRecord,
  RecentChangeRecord,
  RecommendationIdentity,
  ReportJobRecord,
  StructureData,
  WorkerStore,
} from "./store.js";
import type { JobContext, JobHandler } from "./loop.js";
import type { JobDeps } from "./jobs/types.js";
import type { AmazonAdsGateway } from "@amazon-king/amazon-ads";
import type { ReportStorage, StoredArtifact } from "./storage.js";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Writable } from "node:stream";

/** Silent logger for tests. */
export function testLogger(): Logger {
  return createLogger("test", { level: "silent" });
}

export function testConfig(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    ...loadConfig({ DATABASE_URL: "postgres://unused" }),
    reportPollInitialDelayMs: 1,
    reportPollMaxDelayMs: 2,
    ...overrides,
  };
}

export interface QueuedJob {
  id: string;
  type: string;
  payload: unknown;
  runAt: Date | null;
  status: "pending" | "running" | "done" | "failed" | "dead";
}

interface SyncRunRecord {
  id: string;
  profileId: string;
  kind: string;
  status: "running" | "complete" | "failed";
  finishedAt: string | null;
  error: string | null;
}

type RecommendationInsertInput = Parameters<
  WorkerStore["insertRecommendation"]
>[0];

/** In-memory WorkerStore fake. Applies real upsert convergence for metrics. */
export class FakeStore implements WorkerStore {
  connections: ConnectionRecord[] = [];
  profiles: ProfileRecord[] = [];
  reportJobs = new Map<string, ReportJobRecord>();
  syncRuns: SyncRunRecord[] = [];
  jobs: QueuedJob[] = [];
  recommendations: RecommendationInsertInput[] = [];
  dismissals: RecommendationIdentity[] = [];
  refreshTokens = new Map<string, { ciphertext: Buffer; keyVersion: number }>();
  structure: StructureData = {
    campaigns: [],
    adGroups: [],
    ads: [],
    targets: [],
    negativeKeywords: [],
    negativeTargets: [],
  };
  facts = {
    campaign: [] as DailyFact[],
    target: [] as DailyFact[],
    searchTerm: [] as DailyFact[],
    placement: [] as DailyFact[],
  };
  economics: BookEconomicsRecord[] = [];
  recentChanges: RecentChangeRecord[] = [];
  fxRates: FxRateRow[] = [];
  expiredCount = 0;
  /** Converged fact rows keyed by reportType|grain — proves idempotent upserts. */
  convergedFacts = new Map<string, unknown>();
  importCalls: MetricFactRows[] = [];

  private seq = 0;
  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  async listActiveConnections() {
    return this.connections.filter((c) => c.status === "connected");
  }
  async getConnection(connectionId: string) {
    return this.connections.find((c) => c.id === connectionId) ?? null;
  }
  async setConnectionError(connectionId: string, _errorCode: string | null) {
    void connectionId;
  }
  async markConnectionReconnectRequired(
    connectionId: string,
    _errorCode: string,
  ) {
    const connection = this.connections.find((c) => c.id === connectionId);
    if (connection) connection.status = "reconnect_required";
  }
  async failPendingJobsForConnection(connectionId: string, _reason: string) {
    let count = 0;
    for (const job of this.jobs) {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const profile = this.profiles.find((p) => p.id === payload.profileId);
      if (
        job.status === "pending" &&
        (payload.connectionId === connectionId ||
          profile?.connectionId === connectionId)
      ) {
        job.status = "dead";
        count += 1;
      }
    }
    return count;
  }
  async loadEncryptedRefreshToken(connectionId: string) {
    return this.refreshTokens.get(connectionId)?.ciphertext ?? null;
  }
  async persistRefreshToken(
    connectionId: string,
    ciphertext: Buffer,
    keyVersion: number,
  ) {
    this.refreshTokens.set(connectionId, { ciphertext, keyVersion });
  }

  async getProfile(profilePk: string) {
    return this.profiles.find((p) => p.id === profilePk) ?? null;
  }
  async listEnabledProfiles() {
    return this.profiles.filter((p) => p.enabled);
  }
  async insertDiscoveredProfile(input: {
    connectionId: string;
    profileId: string;
    accountId: string | null;
    region: "NA" | "EU" | "FE";
    countryCode: string;
    currencyCode: string;
    timezone: string | null;
    accountType: string | null;
  }) {
    if (this.profiles.some((p) => p.amazonProfileId === input.profileId))
      return;
    this.profiles.push({
      id: this.nextId(),
      amazonProfileId: input.profileId,
      connectionId: input.connectionId,
      workspaceId: "1",
      region: input.region,
      currencyCode: input.currencyCode,
      enabled: false,
    });
  }
  async getGatewayProfile(profilePk: string) {
    const profile = this.profiles.find((p) => p.id === profilePk);
    if (!profile) throw new Error(`Unknown profile ${profilePk}`);
    return {
      profileId: profile.amazonProfileId,
      connectionId: profile.connectionId,
      region: profile.region as "NA" | "EU" | "FE",
      accountId: null,
    };
  }
  async findProfilePkForReport(amazonReportId: string) {
    for (const job of this.reportJobs.values()) {
      if (job.amazonReportId === amazonReportId) return job.profileId;
    }
    return null;
  }

  async createSyncRun(
    profilePk: string,
    kind: "structure" | "metrics" | "backfill",
  ) {
    const id = this.nextId();
    this.syncRuns.push({
      id,
      profileId: profilePk,
      kind,
      status: "running",
      finishedAt: null,
      error: null,
    });
    return id;
  }
  async finishSyncRun(
    syncRunId: string,
    status: "complete" | "failed",
    error?: string,
  ) {
    const run = this.syncRuns.find((r) => r.id === syncRunId);
    if (run) {
      run.status = status;
      run.finishedAt = new Date().toISOString();
      run.error = error ?? null;
    }
  }
  async latestCompletedSyncRun(
    profilePk: string,
    kind: string,
  ): Promise<CompletedSyncRun | null> {
    const run = [...this.syncRuns]
      .reverse()
      .find(
        (r) =>
          r.profileId === profilePk &&
          r.kind === kind &&
          r.status === "complete",
      );
    return run && run.finishedAt
      ? { id: run.id, finishedAt: run.finishedAt }
      : null;
  }

  async findReportJobByFingerprint(specFingerprint: string) {
    return this.reportJobs.get(specFingerprint) ?? null;
  }
  async createReportJob(input: {
    syncRunId: string;
    profileId: string;
    reportType: string;
    specFingerprint: string;
    dateStart: string;
    dateEnd: string;
  }): Promise<ReportJobRecord> {
    const job: ReportJobRecord = {
      id: this.nextId(),
      syncRunId: input.syncRunId,
      profileId: input.profileId,
      reportType: input.reportType,
      specFingerprint: input.specFingerprint,
      amazonReportId: null,
      status: "queued",
      attempts: 0,
      checksum: null,
      storageKey: null,
      error: null,
    };
    this.reportJobs.set(input.specFingerprint, job);
    return job;
  }
  async updateReportJob(
    reportJobId: string,
    update: {
      status: ReportJobRecord["status"];
      amazonReportId?: string;
      checksum?: string;
      storageKey?: string;
      error?: string | null;
      incrementAttempts?: boolean;
    },
  ) {
    for (const job of this.reportJobs.values()) {
      if (job.id !== reportJobId) continue;
      job.status = update.status;
      if (update.amazonReportId !== undefined)
        job.amazonReportId = update.amazonReportId;
      if (update.checksum !== undefined) job.checksum = update.checksum;
      if (update.storageKey !== undefined) job.storageKey = update.storageKey;
      if (update.error !== undefined && update.error !== null)
        job.error = update.error;
      if (update.incrementAttempts) job.attempts += 1;
    }
  }

  async importMetrics(facts: MetricFactRows) {
    this.importCalls.push(facts);
    for (const row of facts.rows) {
      // Upsert semantics: last write wins on the grain key.
      const grain = grainKeyOf(facts, row);
      this.convergedFacts.set(`${facts.reportType}|${grain}`, row);
    }
    return facts.rows.length;
  }

  async applyStructureSnapshot() {
    // Not needed by handler tests; structure is set directly on the fake.
  }

  async upsertFxRates(rows: readonly FxRateRow[]) {
    // ON CONFLICT DO NOTHING: a stored fixing is never overwritten.
    let inserted = 0;
    for (const row of rows) {
      const exists = this.fxRates.some(
        (stored) =>
          stored.rateDate === row.rateDate &&
          stored.baseCurrency === row.baseCurrency &&
          stored.quoteCurrency === row.quoteCurrency,
      );
      if (exists) continue;
      this.fxRates.push(row);
      inserted += 1;
    }
    return inserted;
  }
  async getLatestFxRateDate() {
    let latest: string | null = null;
    for (const row of this.fxRates) {
      if (latest === null || row.rateDate > latest) latest = row.rateDate;
    }
    return latest;
  }
  async getEarliestFactDate() {
    let earliest: string | null = null;
    for (const facts of Object.values(this.facts)) {
      for (const fact of facts) {
        if (earliest === null || fact.date < earliest) earliest = fact.date;
      }
    }
    return earliest;
  }

  async enqueue(type: string, payload: unknown, runAt?: Date) {
    const id = this.nextId();
    this.jobs.push({
      id,
      type,
      payload,
      runAt: runAt ?? null,
      status: "pending",
    });
    return id;
  }
  async enqueueIfNotQueued(type: string, payload: unknown, runAt?: Date) {
    const exists = this.jobs.some(
      (job) =>
        (job.status === "pending" || job.status === "running") &&
        job.type === type &&
        payloadContains(job.payload, payload),
    );
    if (exists) return null;
    return this.enqueue(type, payload, runAt);
  }
  async hasPendingJob(type: string) {
    return this.jobs.some(
      (job) => job.type === type && job.status === "pending",
    );
  }

  async loadStructure() {
    return this.structure;
  }
  async loadDailyFacts() {
    return this.facts;
  }
  async listRecentChanges() {
    return this.recentChanges;
  }
  async listBookEconomics() {
    return this.economics;
  }

  async expireStaleRecommendations() {
    return this.expiredCount;
  }
  async pendingRecommendationExists(identity: RecommendationIdentity) {
    return this.recommendations.some((rec) =>
      sameRecommendationIdentity(rec, identity),
    );
  }
  async recommendationDismissed(identity: RecommendationIdentity) {
    return this.dismissals.some((dismissed) =>
      sameRecommendationIdentity(dismissed, identity),
    );
  }
  async expirePendingRecommendations(identity: RecommendationIdentity) {
    const before = this.recommendations.length;
    this.recommendations = this.recommendations.filter(
      (rec) => !sameRecommendationIdentity(rec, identity),
    );
    return before - this.recommendations.length;
  }
  async insertRecommendation(input: RecommendationInsertInput) {
    this.recommendations.push(input);
  }
}

function sameRecommendationIdentity(
  candidate: {
    profileId: string;
    type: string;
    campaignId?: string | null;
    adGroupId?: string | null;
    targetId?: string | null;
    searchTerm?: string | null;
  },
  identity: RecommendationIdentity,
): boolean {
  return (
    candidate.profileId === identity.profileId &&
    candidate.type === identity.type &&
    (candidate.campaignId ?? null) === identity.campaignId &&
    (candidate.adGroupId ?? null) === identity.adGroupId &&
    (candidate.targetId ?? null) === identity.targetId &&
    (candidate.searchTerm ?? null) === identity.searchTerm
  );
}

function grainKeyOf(facts: MetricFactRows, row: unknown): string {
  const r = row as Record<string, unknown>;
  switch (facts.reportType) {
    case "spCampaigns":
      return `${r.campaignId}|${r.metricDate}`;
    case "spTargeting":
      return `${r.targetId}|${r.metricDate}`;
    case "spSearchTerm":
      return `${r.targetId}|${r.searchTerm}|${r.metricDate}`;
    case "spAdvertisedProduct":
      return `${r.adId}|${r.metricDate}`;
    case "placement":
      return `${r.campaignId}|${r.placement}|${r.metricDate}`;
  }
}

/** JSON containment (subset) match, mirroring Postgres `payload @> other`. */
export function payloadContains(haystack: unknown, needle: unknown): boolean {
  if (needle === null || typeof needle !== "object") {
    return JSON.stringify(haystack) === JSON.stringify(needle);
  }
  if (haystack === null || typeof haystack !== "object") return false;
  if (Array.isArray(needle)) {
    return JSON.stringify(haystack) === JSON.stringify(needle);
  }
  return Object.entries(needle as Record<string, unknown>).every(
    ([key, value]) =>
      payloadContains((haystack as Record<string, unknown>)[key], value),
  );
}

/** In-memory ReportStorage fake with real gzip + checksum behavior. */
export class FakeStorage implements ReportStorage {
  files = new Map<string, Buffer>();

  async store(
    key: string,
    write: (sink: Writable) => Promise<void>,
  ): Promise<StoredArtifact> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    await write(sink);
    const bytes = Buffer.concat(chunks);
    this.files.set(key, bytes);
    return {
      key,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  async readGzipJson(key: string) {
    const bytes = this.files.get(key);
    if (!bytes) throw new Error(`No stored artifact ${key}`);
    return JSON.parse(gunzipSync(bytes).toString("utf8"));
  }
  async verifyChecksum(key: string, expectedChecksum: string) {
    const bytes = this.files.get(key);
    if (!bytes) return false;
    return (
      createHash("sha256").update(bytes).digest("hex") === expectedChecksum
    );
  }
}

export function fakeGateway(
  overrides: Partial<AmazonAdsGateway> = {},
): AmazonAdsGateway {
  return {
    listProfiles: async () => [],
    syncCampaignStructure: async () => {
      throw new Error("not implemented");
    },
    getCampaignBidControls: async () => {
      throw new Error("not implemented");
    },
    requestReport: async () => {
      throw new Error("not implemented");
    },
    getReport: async () => {
      throw new Error("not implemented");
    },
    previewCapabilities: async () => {
      throw new Error("not implemented");
    },
    applyActions: async () => [],
    ...overrides,
  };
}

/** Run a handler with a minimal job context. */
export function runHandler(
  handler: JobHandler,
  payload: unknown,
): Promise<void> {
  const job: Job = {
    id: "1",
    type: "test",
    payload,
    runAt: new Date().toISOString(),
    status: "running",
    attempts: 1,
    maxAttempts: 5,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lockedBy: "test",
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  const ctx: JobContext = { job, logger: testLogger() };
  return handler(payload, ctx);
}

export function makeDeps(
  overrides: Partial<JobDeps> & { store: FakeStore },
): JobDeps {
  return {
    gateway: fakeGateway(),
    storage: new FakeStorage(),
    config: testConfig(),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    sleep: async () => undefined,
    ...overrides,
  };
}
