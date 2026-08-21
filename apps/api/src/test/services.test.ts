import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger as Logger } from "fastify";
import { AmazonApiError } from "@amazon-king/amazon-ads";
import type {
  ActionResult,
  AmazonAdsGateway,
  Profile,
  StructureSnapshot,
  TokenManager,
} from "@amazon-king/amazon-ads";
import type { ApiConfig } from "../config.js";
import type { SearchTermDetail } from "@amazon-king/contracts";
import { ApiError } from "../errors.js";
import { createSessionService } from "../services/session.js";
import { createAmazonService } from "../services/amazon.js";
import { createChangeService } from "../services/changes.js";
import { createReadService } from "../services/read.js";
import type { AuthContext, RequestMeta } from "../services/types.js";
import { FakeDb } from "./fake-db.js";

// -- shared fixtures ---------------------------------------------------------

const KEY = "a".repeat(64);

function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    nodeEnv: "development",
    port: 3000,
    databaseUrl: "postgres://localhost/test",
    sessionSecret: "test-session-secret-0123456789",
    webOrigin: "http://localhost:5173",
    lwaClientId: "lwa-client-id",
    lwaClientSecret: "lwa-client-secret",
    amazonRedirectUri: "http://localhost:3000/api/integrations/amazon/callback",
    killSwitch: false,
    trustProxy: false,
    smtpPort: 587,
    smtpSecure: false,
    isDevelopment: true,
    ...overrides,
  };
}

interface LogCall {
  fields: Record<string, unknown>;
  message: string;
}

function fakeLogger() {
  const calls: LogCall[] = [];
  const logger = {
    calls,
    info(fields: Record<string, unknown>, message: string) {
      calls.push({ fields, message });
    },
    warn(fields: Record<string, unknown>, message: string) {
      calls.push({ fields, message });
    },
    error(fields: Record<string, unknown>, message: string) {
      calls.push({ fields, message });
    },
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    level: "info",
  };
  return logger as unknown as Logger & { calls: LogCall[] };
}

const META: RequestMeta = { ip: "127.0.0.1", userAgent: "vitest" };

function authFixture(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    sessionId: "session-1",
    userId: "1",
    workspaceId: "1",
    email: "owner@example.com",
    sessionTokenHash: "hash-1",
    sessionCreatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

const PROFILE: Profile = {
  profileId: "amz-profile-1",
  region: "NA",
  countryCode: "US",
  currencyCode: "USD",
  timezone: "America/Los_Angeles",
  accountId: "acct-1",
  accountType: "vendor",
  accountName: "Test",
};

function snapshotWithKeywordBid(bid: number | null): StructureSnapshot {
  return {
    campaigns: [],
    adGroups: [],
    ads: [],
    keywords: [{ keywordId: "kw-1", bid, state: "PAUSED" }],
    targets: [],
    negativeKeywords: [],
  } as unknown as StructureSnapshot;
}

function snapshotWithNegative(present: boolean): StructureSnapshot {
  return {
    profileId: "amz-profile-1",
    retrievedAt: "2026-08-13T10:00:00.000Z",
    campaigns: [],
    adGroups: [],
    ads: [],
    keywords: [],
    targets: [],
    negativeKeywords: present
      ? [
          {
            negativeKeywordId: "negative-1",
            campaignId: "camp-2",
            adGroupId: null,
            keywordText: "tractor colouring book",
            matchType: "NEGATIVE_EXACT",
            state: "ENABLED",
            raw: {},
          },
        ]
      : [],
  };
}

// -- session service (Login A, plan §5) --------------------------------------

describe("session service", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  async function fullLogin(db: FakeDb, logger: Logger & { calls: LogCall[] }) {
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger,
    });
    await service.startLogin("owner@example.com", META);
    const linkCall = logger.calls.find(
      (c) => typeof c.fields.magicLink === "string",
    );
    const token = new URL(
      linkCall!.fields.magicLink as string,
    ).searchParams.get("token")!;
    return { service, token };
  }

  it("runs the full passwordless flow: token → session → authenticate", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const { service, token } = await fullLogin(db, logger);

    const verified = await service.verifyLogin(token, META);
    expect(verified).not.toBeNull();
    expect(verified!.auth.email).toBe("owner@example.com");
    // First login auto-provisions the owner workspace.
    expect(db.tables.users).toHaveLength(1);
    expect(db.tables.workspaces).toHaveLength(1);

    const authed = await service.authenticate(verified!.sessionToken);
    expect(authed?.userId).toBe(verified!.auth.userId);
  });

  it("stores only token hashes, never the raw login or session token", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const { service, token } = await fullLogin(db, logger);
    expect(db.tables.loginTokens[0]!.token_hash).not.toBe(token);

    const verified = await service.verifyLogin(token, META);
    expect(db.tables.sessions[0]!.token_hash).not.toBe(verified!.sessionToken);
  });

  it("returns the single-use login URL when local email delivery is absent", async () => {
    const db = new FakeDb();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const result = await service.startLogin("owner@example.com", META);

    expect(result.devLoginUrl).toMatch(
      /^http:\/\/localhost:3000\/api\/session\/verify\?token=/,
    );
  });

  it("builds the magic link from an allowlisted request origin (tunnel)", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger,
    });
    const tunnel = "https://random-words-123.trycloudflare.com";

    const result = await service.startLogin("owner@example.com", META, tunnel);

    expect(result.devLoginUrl).toMatch(
      new RegExp(
        `^${tunnel.replaceAll(".", "\\.")}/api/session/verify\\?token=`,
      ),
    );
    const token = new URL(result.devLoginUrl!).searchParams.get("token")!;
    const verified = await service.verifyLogin(token, META);
    expect(verified!.webOrigin).toBe(tunnel);
  });

  it("ignores a disallowed request origin and falls back to config", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger,
    });

    const result = await service.startLogin(
      "owner@example.com",
      META,
      "https://evil.example.com",
    );

    expect(result.devLoginUrl).toMatch(
      /^http:\/\/localhost:3000\/api\/session\/verify\?token=/,
    );
    const token = new URL(result.devLoginUrl!).searchParams.get("token")!;
    const verified = await service.verifyLogin(token, META);
    expect(verified!.webOrigin).toBe("http://localhost:5173");
  });

  it("carries the requested post-verify path through the flow", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger,
    });

    const result = await service.startLogin(
      "owner@example.com",
      META,
      undefined,
      "/changes",
    );

    const token = new URL(result.devLoginUrl!).searchParams.get("token")!;
    const verified = await service.verifyLogin(token, META);
    expect(verified!.nextPath).toBe("/changes");
  });

  it("drops post-verify paths that could leave the origin", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger,
    });

    for (const bad of [
      "//evil.example.com",
      "\\evil",
      "https://evil.example.com",
    ]) {
      const result = await service.startLogin(
        "owner@example.com",
        META,
        undefined,
        bad,
      );
      const token = new URL(result.devLoginUrl!).searchParams.get("token")!;
      const verified = await service.verifyLogin(token, META);
      expect(verified!.nextPath).toBeNull();
    }
  });

  it("reports no post-verify path when none was requested", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const { service, token } = await fullLogin(db, logger);

    const verified = await service.verifyLogin(token, META);
    expect(verified!.nextPath).toBeNull();
  });

  it("rejects non-configured origins outside development", async () => {
    const db = new FakeDb();
    const service = createSessionService({
      db: db as never,
      config: testConfig({
        nodeEnv: "production",
        isDevelopment: false,
        ownerEmail: "owner@example.com",
        apiPublicUrl: "https://ads.example.com",
      }),
      logger: fakeLogger(),
      sendMagicLink: vi.fn(async () => undefined),
    });

    await service.startLogin(
      "owner@example.com",
      META,
      "https://random-words-123.trycloudflare.com",
    );

    expect(db.tables.loginTokens[0]!.origin).toBeNull();
  });

  it("consumes login tokens exactly once", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const { service, token } = await fullLogin(db, logger);

    expect(await service.verifyLogin(token, META)).not.toBeNull();
    expect(await service.verifyLogin(token, META)).toBeNull();
  });

  it("rejects unknown login tokens", async () => {
    const db = new FakeDb();
    const service = createSessionService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });
    expect(await service.verifyLogin("nope", META)).toBeNull();
  });

  it("silently refuses logins for other emails when OWNER_EMAIL is set", async () => {
    const db = new FakeDb();
    const service = createSessionService({
      db: db as never,
      config: testConfig({ ownerEmail: "owner@example.com" }),
      logger: fakeLogger(),
    });
    await service.startLogin("intruder@example.com", META);
    expect(db.tables.loginTokens).toHaveLength(0);
  });

  it("delivers production magic links without logging the token", async () => {
    const db = new FakeDb();
    const logger = fakeLogger();
    const sendMagicLink = vi.fn(async () => undefined);
    const service = createSessionService({
      db: db as never,
      config: testConfig({
        nodeEnv: "production",
        isDevelopment: false,
        ownerEmail: "owner@example.com",
        apiPublicUrl: "https://ads.example.com",
      }),
      logger,
      sendMagicLink,
    });

    const result = await service.startLogin("owner@example.com", META);

    expect(sendMagicLink).toHaveBeenCalledOnce();
    expect(sendMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
        url: expect.stringMatching(
          /^https:\/\/ads\.example\.com\/api\/session\/verify\?token=/,
        ),
        expiresInMinutes: 15,
      }),
    );
    expect(JSON.stringify(logger.calls)).not.toContain("/api/session/verify");
    expect(result).toEqual({});
  });

  it("accepts its own CSRF token and rejects anything else", async () => {
    const service = createSessionService({
      db: new FakeDb() as never,
      config: testConfig(),
      logger: fakeLogger(),
    });
    const auth = authFixture();
    const token = service.csrfTokenFor(auth);
    expect(service.verifyCsrf(auth, token)).toBe(true);
    expect(service.verifyCsrf(auth, `${token}x`)).toBe(false);
    expect(service.verifyCsrf(auth, "garbage")).toBe(false);
    expect(service.verifyCsrf(auth, undefined)).toBe(false);
    // A token derived for a different session must not validate.
    expect(
      service.verifyCsrf(authFixture({ sessionTokenHash: "other" }), token),
    ).toBe(false);
  });

  it("enforces the recent-auth window for spend-changing actions", () => {
    const service = createSessionService({
      db: new FakeDb() as never,
      config: testConfig(),
      logger: fakeLogger(),
    });
    const fresh = authFixture();
    expect(service.isRecentAuth(fresh)).toBe(true);
    const stale = authFixture({
      sessionCreatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(service.isRecentAuth(stale)).toBe(false);
  });
});

// -- amazon service (Login B, plan §5) ---------------------------------------

describe("amazon oauth service", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  function setup(
    overrides: {
      exchange?: (args: unknown) => Promise<unknown>;
      profiles?: Profile[];
    } = {},
  ) {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const exchange = vi.fn(
      overrides.exchange ??
        (async () => ({
          accessToken: "at-1",
          refreshToken: "rt-secret-1",
          expiresIn: 3600,
        })),
    );
    const gateway = {
      listProfiles: vi.fn(async () => overrides.profiles ?? [PROFILE]),
    };
    const tokenManager = { invalidate: vi.fn() };
    const service = createAmazonService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: gateway as unknown as Pick<AmazonAdsGateway, "listProfiles">,
      tokenManager: tokenManager as unknown as Pick<TokenManager, "invalidate">,
      exchangeCodeImpl: exchange as never,
    });
    return { db, service, exchange, gateway, tokenManager };
  }

  async function startState(
    service: ReturnType<typeof setup>["service"],
  ): Promise<string> {
    const { url } = await service.start(authFixture(), META);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe("lwa-client-id");
    expect(parsed.searchParams.get("scope")).toBe(
      "advertising::campaign_management",
    );
    expect(url).not.toContain("lwa-client-secret");
    return parsed.searchParams.get("state")!;
  }

  it("start builds the consent URL and stores only the state hash", async () => {
    const { db, service } = setup();
    const state = await startState(service);
    expect(db.tables.oauthStates).toHaveLength(1);
    expect(db.tables.oauthStates[0]!.state_hash).not.toBe(state);
    expect(db.tables.oauthStates[0]!.used_at).toBeNull();
  });

  it("rejects an unknown state without exchanging the code", async () => {
    const { service, exchange } = setup();
    const result = await service.handleCallback(
      { state: "unknown", code: "c" },
      authFixture(),
      META,
    );
    expect(result.redirectTo).toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("happy path: exchanges, encrypts the refresh token, discovers profiles", async () => {
    const { db, service, gateway } = setup();
    const state = await startState(service);
    const result = await service.handleCallback(
      { state, code: "auth-code" },
      authFixture(),
      META,
    );
    expect(result.redirectTo).toBe("http://localhost:5173/connect?connected=1");

    const connection = db.tables.amazonConnections[0]!;
    const ciphertext = connection.encrypted_refresh_token as Buffer;
    expect(ciphertext.includes(Buffer.from("rt-secret-1"))).toBe(false);
    expect(connection.encryption_key_version).toBe(1);
    expect(gateway.listProfiles).toHaveBeenCalledOnce();
    expect(db.tables.amazonProfiles).toHaveLength(1);
  });

  it("marks state used BEFORE exchange so a replay can never exchange twice", async () => {
    const { service, exchange } = setup({
      exchange: async () => {
        throw new Error("simulated exchange failure");
      },
    });
    const state = await startState(service);
    const first = await service.handleCallback(
      { state, code: "c" },
      authFixture(),
      META,
    );
    expect(first.redirectTo).toContain("error=exchange_failed");
    // Replay after a failed exchange: state is already consumed.
    const replay = await service.handleCallback(
      { state, code: "c" },
      authFixture(),
      META,
    );
    expect(replay.redirectTo).toContain("error=invalid_state");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects a state issued to a different user", async () => {
    const { service, exchange } = setup();
    const state = await startState(service);
    const result = await service.handleCallback(
      { state, code: "c" },
      authFixture({ userId: "2" }),
      META,
    );
    expect(result.redirectTo).toContain("error=foreign_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("disconnect wipes the token and fails pending jobs for its profiles", async () => {
    const { db, service, tokenManager } = setup();
    const connection = db.seedConnection();
    db.seedProfile({ connection_id: connection.id });
    db.tables.jobQueue.push({
      id: "job-1",
      type: "metrics_sync",
      payload: { profileId: db.tables.amazonProfiles[0]!.id },
      status: "pending",
      last_error: null,
    });

    await service.disconnect(authFixture(), META);

    const updated = db.tables.amazonConnections[0]!;
    expect(updated.status).toBe("disconnected");
    // Token is crypto-shredded to an empty bytea — no usable material remains.
    expect((updated.encrypted_refresh_token as Buffer).length).toBe(0);
    expect(tokenManager.invalidate).toHaveBeenCalledWith(connection.id);
    expect(db.tables.jobQueue[0]!.status).toBe("failed");
  });
});

// -- read service / manual synchronization (plan §8) -------------------------

describe("read service", () => {
  it("enqueues manual metrics sync for the trailing 60 complete UTC days", async () => {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const connection = db.seedConnection();
    db.seedProfile({
      id: "profile-pk-1",
      connection_id: connection.id,
      profile_id: "amazon-profile-1",
      enabled: true,
    });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    await service.requestSync(authFixture(), "amazon-profile-1", META);

    const metricsJob = db.tables.jobQueue.find(
      (job) => job.type === "metrics_sync",
    );
    expect(metricsJob?.payload).toMatchObject({
      profileId: "profile-pk-1",
      startDate: "2026-06-13",
      endDate: "2026-08-11",
    });
  });

  function setupSyncRuns() {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const connection = db.seedConnection();
    const profile = db.seedProfile({
      id: "profile-pk-1",
      connection_id: connection.id,
      profile_id: "amazon-profile-1",
    });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    return { db, profile, service };
  }

  it("lists sync runs newest-first with per-report progress", async () => {
    const { db, profile, service } = setupSyncRuns();
    db.tables.syncRuns.push(
      {
        id: "11",
        profile_id: profile.id,
        kind: "metrics",
        status: "complete",
        started_at: new Date("2026-08-10T05:00:00.000Z"),
        finished_at: new Date("2026-08-10T05:04:00.000Z"),
        error: null,
      },
      {
        id: "12",
        profile_id: profile.id,
        kind: "metrics",
        status: "running",
        started_at: new Date("2026-08-11T05:00:00.000Z"),
        finished_at: null,
        error: null,
      },
    );
    db.tables.reportJobs.push(
      {
        id: "102",
        sync_run_id: "12",
        profile_id: profile.id,
        report_type: "search_terms",
        status: "importing",
        date_start: "2026-08-10",
        date_end: "2026-08-10",
        error: null,
      },
      {
        id: "101",
        sync_run_id: "12",
        profile_id: profile.id,
        report_type: "campaigns",
        status: "complete",
        date_start: "2026-08-10",
        date_end: "2026-08-10",
        error: null,
      },
      {
        id: "103",
        sync_run_id: "11",
        profile_id: profile.id,
        report_type: "campaigns",
        status: "complete",
        date_start: "2026-08-09",
        date_end: "2026-08-09",
        error: null,
      },
    );

    const runs = await service.listSyncRuns("1");

    expect(runs.map((run) => run.id)).toEqual(["12", "11"]);
    expect(runs[0]!.profileId).toBe("amazon-profile-1");
    // Report jobs are ordered by id, not by insertion order.
    expect(runs[0]!.reports.map((r) => r.reportType)).toEqual([
      "campaigns",
      "search_terms",
    ]);
    expect(runs[0]!.reports[1]).toMatchObject({
      status: "importing",
      dateStart: "2026-08-10",
      dateEnd: "2026-08-10",
    });
    expect(runs[1]!.reports).toHaveLength(1);
  });

  it("scopes listed sync runs to the caller's workspace", async () => {
    const { db, profile, service } = setupSyncRuns();
    db.tables.syncRuns.push({
      id: "11",
      profile_id: profile.id,
      kind: "metrics",
      status: "complete",
      started_at: new Date("2026-08-10T05:00:00.000Z"),
      finished_at: new Date("2026-08-10T05:04:00.000Z"),
      error: null,
    });
    const foreignConnection = db.seedConnection({ workspace_id: "2" });
    const foreignProfile = db.seedProfile({
      id: "profile-pk-2",
      connection_id: foreignConnection.id,
      profile_id: "amazon-profile-2",
    });
    db.tables.syncRuns.push({
      id: "99",
      profile_id: foreignProfile.id,
      kind: "metrics",
      status: "running",
      started_at: new Date("2026-08-11T06:00:00.000Z"),
      finished_at: null,
      error: null,
    });

    const runs = await service.listSyncRuns("1");

    expect(runs.map((run) => run.id)).toEqual(["11"]);
  });

  it("returns an empty list when the workspace has no sync runs", async () => {
    const { service } = setupSyncRuns();

    await expect(service.listSyncRuns("1")).resolves.toEqual([]);
  });
});

// -- change service (guarded writes, plan §10) --------------------------------

describe("change service", () => {
  const gatewayBase = () => ({
    syncCampaignStructure: vi.fn(async () => snapshotWithKeywordBid(0.5)),
    getCampaignBidControls: vi.fn(async () => {
      throw new Error("Unexpected Max CPC controls call");
    }),
    applyActions: vi.fn(
      async (set: {
        actions: { actionId: string }[];
      }): Promise<ActionResult[]> =>
        set.actions.map((a) => ({
          actionId: a.actionId,
          status: "applied",
          code: "SUCCESS",
        })),
    ),
  });

  function setup(
    overrides: { killSwitch?: boolean; writeEnabled?: boolean } = {},
  ) {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const connection = db.seedConnection();
    const profile = db.seedProfile({
      connection_id: connection.id,
      write_enabled: overrides.writeEnabled ?? true,
    });
    db.seedCampaign();
    db.seedTarget({ profile_id: profile.id });
    const changeSet = db.seedChangeSet({
      status: "previewed",
      profile_id: profile.id,
    });
    db.seedChangeAction({ change_set_id: changeSet.id });
    const gateway = gatewayBase();
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig({ killSwitch: overrides.killSwitch ?? false }),
      logger: fakeLogger(),
      gateway: gateway as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });
    const changeSetId = changeSet.id as string;
    return { db, service, gateway, changeSetId };
  }

  function expectApiError(error: unknown, code: string): void {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
  }

  it("kill switch blocks apply before any Amazon call", async () => {
    const { service, gateway, changeSetId } = setup({ killSwitch: true });
    await service
      .applyChangeSet(authFixture(), changeSetId, META)
      .catch((e) => expectApiError(e, "WRITES_DISABLED"));
    expect(gateway.syncCampaignStructure).not.toHaveBeenCalled();
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });

  it("read-only profile blocks apply before any Amazon call", async () => {
    const { service, gateway, changeSetId } = setup({ writeEnabled: false });
    await service
      .applyChangeSet(authFixture(), changeSetId, META)
      .catch((e) => expectApiError(e, "WRITES_DISABLED"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });

  it("a stale before-state blocks the write and marks the set blocked", async () => {
    const { db, service, gateway, changeSetId } = setup();
    // Amazon now shows a different bid than the approved before snapshot.
    gateway.syncCampaignStructure.mockResolvedValue(
      snapshotWithKeywordBid(0.75),
    );
    await service
      .applyChangeSet(authFixture(), changeSetId, META)
      .catch((e) => expectApiError(e, "STALE_BEFORE_STATE"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
    expect(db.tables.changeSets[0]!.status).toBe("blocked");
  });

  it("applies, verifies, and a duplicate apply returns the stored result", async () => {
    const { db, service, gateway, changeSetId } = setup();
    // First re-read shows the before bid; post-write re-read shows the after bid.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(snapshotWithKeywordBid(0.5))
      .mockResolvedValueOnce(snapshotWithKeywordBid(0.55));

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(applied.changeSet.status).toBe("applied");
    expect(applied.actions[0]!.status).toBe("applied");
    expect(gateway.applyActions).toHaveBeenCalledTimes(1);
    expect(gateway.applyActions).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [expect.objectContaining({ state: "PAUSED" })],
      }),
    );

    // Double-click / retry: no second Amazon write.
    const again = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(again.changeSet.status).toBe("applied");
    expect(gateway.applyActions).toHaveBeenCalledTimes(1);
    expect(
      db.tables.auditEvents.some((r) => r.event === "change_set.apply"),
    ).toBe(true);
  });

  it("maps per-item failures instead of trusting batch success", async () => {
    const { db, service, gateway, changeSetId } = setup();
    gateway.applyActions.mockResolvedValue([
      {
        actionId: db.tables.changeActions[0]!.id as string,
        status: "failed",
        code: "INVALID_STATE",
        message: "nope",
      },
    ]);
    const result = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(result.changeSet.status).toBe("failed");
    expect(result.actions[0]!.status).toBe("failed");
  });

  it("retries a failed set through the full guarded apply path", async () => {
    const { db, service, gateway, changeSetId } = setup();
    db.tables.changeSets[0]!.status = "failed";
    db.tables.changeActions[0]!.status = "pending";
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(snapshotWithKeywordBid(0.5))
      .mockResolvedValueOnce(snapshotWithKeywordBid(0.55));

    const result = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(result.changeSet.status).toBe("applied");
    expect(result.actions[0]!.status).toBe("applied");
    expect(gateway.applyActions).toHaveBeenCalledTimes(1);
  });

  it("records an Amazon request failure on each unfinished action", async () => {
    const { db, service, gateway, changeSetId } = setup();
    gateway.applyActions.mockRejectedValue(
      new AmazonApiError("Amazon rejected the campaign update", {
        status: 400,
        requestId: "request-123",
        details: {
          errors: [
            {
              code: "INVALID_ARGUMENT",
              details: "Empty bid adjustment arrays are not accepted",
            },
          ],
        },
      }),
    );

    await service
      .applyChangeSet(authFixture(), changeSetId, META)
      .catch((error) => expectApiError(error, "AMAZON_APPLY_FAILED"));

    expect(db.tables.changeSets[0]!.status).toBe("failed");
    expect(db.tables.changeActions[0]).toMatchObject({
      status: "failed",
      amazon_request_id: "request-123",
      amazon_request: expect.objectContaining({ kind: "update_bid" }),
      amazon_response: {
        code: "AMAZON_HTTP_400",
        message: "Empty bid adjustment arrays are not accepted",
        details: {
          errors: [
            {
              code: "INVALID_ARGUMENT",
              details: "Empty bid adjustment arrays are not accepted",
            },
          ],
        },
      },
    });
  });

  it("marks verification_failed when the post-write re-read disagrees", async () => {
    const { service, gateway, changeSetId } = setup();
    // Both re-reads show the old bid: the write "succeeded" but did not take.
    gateway.syncCampaignStructure.mockResolvedValue(
      snapshotWithKeywordBid(0.5),
    );
    const result = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(result.actions[0]!.status).toBe("verification_failed");
    expect(result.changeSet.status).toBe("failed");
  });
});

describe("cannibalization resolution", () => {
  function setupCannibalization() {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const connection = db.seedConnection();
    const profile = db.seedProfile({
      connection_id: connection.id,
      write_enabled: true,
      currency_code: "GBP",
      profile_id: "1665213640406890",
    });
    db.seedCampaign({
      id: "10",
      profile_id: profile.id,
      amazon_campaign_id: "camp-1",
      name: "Exact campaign",
      targeting_type: "manual",
    });
    db.seedCampaign({
      id: "11",
      profile_id: profile.id,
      amazon_campaign_id: "camp-2",
      name: "Discovery campaign",
      targeting_type: "auto",
    });
    const recommendation = db.seedRecommendation({
      profile_id: profile.id,
      type: "cannibalization_conflict",
      campaign_id: null,
      ad_group_id: null,
      target_id: null,
      search_term: "tractor colouring book",
      current_value: null,
      proposed_value: null,
      confidence: "0.500",
      evidence_window_start: "2026-06-14",
      evidence_window_end: new Date(2026, 7, 12),
      data_freshness_at: new Date("2026-08-13T02:01:00.000Z"),
      expires_at: new Date(Date.now() + 86_400_000),
    });
    db.seedRecommendationEvidence(recommendation.id as string, {
      searchTerm: "tractor colouring book",
      campaigns: [
        { campaignId: "10", orders: 3, costMicros: 13_000_000 },
        { campaignId: "11", orders: 1, costMicros: 8_980_000 },
      ],
      totalCostMicros: 21_980_000,
    });
    return { db, profile, recommendation };
  }

  it("returns fact-only per-campaign evidence for destination selection", async () => {
    const { db, recommendation } = setupCannibalization();
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const context = await service.getCannibalizationResolutionContext(
      "1",
      recommendation.id as string,
    );

    expect(context).toMatchObject({
      profileId: "1665213640406890",
      searchTerm: "tractor colouring book",
      currency: "GBP",
      totalSpend: "21.9800",
      campaigns: [
        {
          campaignId: "camp-1",
          name: "Exact campaign",
          spend: "13.0000",
          orders: 3,
        },
        {
          campaignId: "camp-2",
          name: "Discovery campaign",
          spend: "8.9800",
          orders: 1,
        },
      ],
    });
  });

  it("creates one campaign-level negative exact on the non-destination campaign", async () => {
    const { db, recommendation } = setupCannibalization();
    const gateway = {
      syncCampaignStructure: vi.fn(async () => snapshotWithNegative(false)),
      getCampaignBidControls: vi.fn(async () => {
        throw new Error("Unexpected Max CPC controls call");
      }),
      applyActions: vi.fn(async () => []),
    };
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: gateway as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });

    const result = await service.createCannibalizationChangeSet(
      authFixture(),
      recommendation.id as string,
      "camp-1",
      META,
    );

    expect(result.changeSet.status).toBe("draft");
    expect(db.tables.changeActions).toHaveLength(1);
    expect(db.tables.changeActions[0]).toMatchObject({
      action_type: "add_negative_exact",
      campaign_id: "11",
      ad_group_id: null,
      search_term: "tractor colouring book",
      entity_name: "Discovery campaign",
    });
    expect(db.tables.changeSets[0]!.metadata).toMatchObject({
      strategy: "route_with_negative_exact",
      destinationCampaignId: "camp-1",
    });
    expect(db.tables.recommendations[0]!.state).toBe("approved");
    expect(gateway.applyActions).not.toHaveBeenCalled();

    const preview = await service.previewChangeSet(
      authFixture(),
      result.changeSet.id,
      META,
    );
    expect(preview.changeSet.status).toBe("previewed");
    expect(preview.actions[0]).toMatchObject({
      actionType: "add_negative_exact",
    });
  });

  it("rolls a verified negative exact back by deleting its Amazon entity", async () => {
    const { db, profile } = setupCannibalization();
    const set = db.seedChangeSet({
      profile_id: profile.id,
      status: "previewed",
    });
    const action = db.seedChangeAction({
      change_set_id: set.id,
      recommendation_id: null,
      action_type: "add_negative_exact",
      campaign_id: "11",
      ad_group_id: null,
      target_id: null,
      search_term: "tractor colouring book",
      before_value: null,
      after_value: null,
      entity_name: "Discovery campaign",
      before_state: { present: false, matchType: "NEGATIVE_EXACT" },
      after_state: { present: true, matchType: "NEGATIVE_EXACT" },
    });
    const gateway = {
      syncCampaignStructure: vi
        .fn()
        .mockResolvedValueOnce(snapshotWithNegative(false))
        .mockResolvedValueOnce(snapshotWithNegative(true))
        .mockResolvedValueOnce(snapshotWithNegative(true))
        .mockResolvedValueOnce(snapshotWithNegative(false)),
      getCampaignBidControls: vi.fn(async () => {
        throw new Error("Unexpected Max CPC controls call");
      }),
      applyActions: vi.fn(
        async (changeSet: {
          actions: Array<{ actionId: string; kind: string }>;
        }) =>
          changeSet.actions.map((item) => ({
            actionId: item.actionId,
            status: "applied" as const,
            code: "SUCCESS",
            ...(item.kind === "add_negative_exact"
              ? { amazonEntityId: "negative-1" }
              : {}),
          })),
      ),
    };
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: gateway as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });

    const applied = await service.applyChangeSet(
      authFixture(),
      set.id as string,
      META,
    );
    expect(applied.actions[0]).toMatchObject({
      status: "applied",
    });
    expect(db.tables.changeActions[0]!.amazon_entity_id).toBe("negative-1");

    const rollback = await service.rollbackAction(
      authFixture(),
      action.id as string,
      META,
    );
    expect(rollback.changeSet.status).toBe("applied");
    expect(rollback.actions[0]).toMatchObject({
      actionType: "remove_negative_exact",
      status: "applied",
    });
    expect(db.tables.changeActions[0]!.status).toBe("rolled_back");
    expect(gateway.applyActions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            kind: "remove_negative_exact",
            negativeKeywordId: "negative-1",
          }),
        ],
      }),
    );
  });
});

describe("conversion finding resolution", () => {
  function setupConversion(options: { mapBook?: boolean } = {}) {
    const db = new FakeDb();
    db.seedWorkspace();
    db.seedUser("owner@example.com");
    const connection = db.seedConnection();
    const profile = db.seedProfile({
      connection_id: connection.id,
      write_enabled: true,
      account_id: "ENTITY123",
      country_code: "GB",
      currency_code: "GBP",
      profile_id: "1665213640406890",
    });
    db.seedCampaign({
      id: "10",
      profile_id: profile.id,
      amazon_campaign_id: "camp-1",
      name: "Colouring book – exact",
      targeting_type: "manual",
    });
    db.seedAdGroup({ id: "20", profile_id: profile.id, campaign_id: "10" });
    db.seedAd({ profile_id: profile.id, ad_group_id: "20", asin: "B0TRACTOR" });
    if (options.mapBook !== false) {
      const book = db.seedBook({ title: "Tractors to Colour" });
      db.seedBookProfileLink({
        book_id: book.id,
        profile_id: profile.id,
        marketplace_asin: "B0TRACTOR",
      });
    }
    const recommendation = db.seedRecommendation({
      profile_id: profile.id,
      type: "high_ctr_poor_conversion",
      campaign_id: "10",
      ad_group_id: null,
      target_id: null,
      search_term: null,
      current_value: null,
      proposed_value: null,
      confidence: "0.600",
      evidence_window_start: "2026-07-01",
      evidence_window_end: "2026-07-30",
      expires_at: new Date(Date.now() + 86_400_000),
    });
    db.seedRecommendationEvidence(recommendation.id as string, {
      impressions: 4000,
      clicks: 120,
      orders: 1,
      costMicros: 48_000_000,
      ctr: 0.03,
      cvr: 0.008,
    });
    // One term burns clicks with no order; the other converts, so it must not
    // be offered as something to block.
    db.seedSearchTermMetric({
      profile_id: profile.id,
      search_term: "tractor colouring book",
      clicks: 40,
      cost: "18.0000",
      orders: 0,
    });
    db.seedSearchTermMetric({
      profile_id: profile.id,
      search_term: "farm activity book",
      clicks: 20,
      cost: "9.0000",
      orders: 1,
      units: 2,
      sales: "12.0000",
    });
    return { db, profile, recommendation };
  }

  it("names the campaign, its book, and the terms that never convert", async () => {
    const { db, recommendation } = setupConversion();
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const context = await service.getConversionResolutionContext(
      "1",
      recommendation.id as string,
    );

    expect(context).toMatchObject({
      profileId: "1665213640406890",
      countryCode: "GB",
      currency: "GBP",
      campaign: {
        campaignId: "camp-1",
        name: "Colouring book – exact",
        targetingType: "manual",
        amazonConsoleUrl:
          "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY123",
        writeEnabled: true,
      },
      metrics: {
        impressions: 4000,
        clicks: 120,
        orders: 1,
        spend: "48.0000",
        averageCpc: "0.4000",
        // 70% of a £0.40 click, rounded to whole cents.
        suggestedMaxCpc: "0.2800",
      },
      books: [{ title: "Tractors to Colour", asin: "B0TRACTOR" }],
      wastefulTerms: [
        { searchTerm: "tractor colouring book", clicks: 40, orders: 0 },
      ],
    });
  });

  it("omits shopper terms a synced negative already blocks", async () => {
    const { db, profile, recommendation } = setupConversion();
    db.seedNegativeKeyword({
      campaign_id: "10",
      keyword_text: "tractor colouring book",
      match_type: "NEGATIVE_EXACT",
      state: "ENABLED",
    });
    db.seedSearchTermMetric({
      profile_id: profile.id,
      search_term: "tractor sticker book",
      clicks: 12,
      cost: "4.0000",
      orders: 0,
    });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const context = await service.getConversionResolutionContext(
      "1",
      recommendation.id as string,
    );

    expect(context?.wastefulTerms.map((term) => term.searchTerm)).toEqual([
      "tractor sticker book",
    ]);
  });

  it("omits a longer query a phrase negative already covers", async () => {
    const { db, recommendation } = setupConversion();
    db.seedNegativeKeyword({
      campaign_id: "10",
      keyword_text: "tractor colouring",
      match_type: "NEGATIVE_PHRASE",
      state: "enabled",
    });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const context = await service.getConversionResolutionContext(
      "1",
      recommendation.id as string,
    );

    expect(context?.wastefulTerms).toEqual([]);
  });

  it("still resolves the campaign when no book is mapped to its ads", async () => {
    const { db, recommendation } = setupConversion({ mapBook: false });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    const context = await service.getConversionResolutionContext(
      "1",
      recommendation.id as string,
    );

    expect(context?.books).toEqual([]);
    expect(context?.campaign.campaignId).toBe("camp-1");
  });

  it("refuses the conversion context for another finding type", async () => {
    const { db } = setupConversion();
    const other = db.seedRecommendation({
      profile_id: db.tables.amazonProfiles[0]!.id,
      type: "expensive_target",
      campaign_id: "10",
    });
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    await expect(
      service.getConversionResolutionContext("1", other.id as string),
    ).rejects.toMatchObject({ code: "INVALID_RECOMMENDATION_TYPE" });
  });

  it("snoozes a rejected finding for the requested number of days", async () => {
    const { db, recommendation } = setupConversion();
    const service = createReadService({
      db: db as never,
      config: testConfig(),
      logger: fakeLogger(),
    });

    await service.rejectRecommendation(
      authFixture(),
      recommendation.id as string,
      META,
      { snoozeDays: 30 },
    );

    const dismissal = db.tables.recommendationDismissals[0]!;
    const days = Math.round(
      (new Date(dismissal.dismissed_until as string).getTime() - Date.now()) /
        86_400_000,
    );
    expect(days).toBe(30);
  });

  it("drafts one campaign-level negative per chosen term", async () => {
    const { db } = setupConversion();
    const gateway = {
      syncCampaignStructure: vi.fn(async () => {
        throw new Error("Unexpected structure read");
      }),
      getCampaignBidControls: vi.fn(async () => {
        throw new Error("Unexpected Max CPC controls call");
      }),
      applyActions: vi.fn(async () => []),
    };
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: gateway as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });

    const result = await service.createCampaignNegativesChangeSet(
      authFixture(),
      "camp-1",
      // The duplicate casing collapses; Amazon matches negatives case-insensitively.
      ["tractor colouring book", "Tractor Colouring Book", "B0RIVAL123"],
      META,
    );

    expect(result.changeSet.status).toBe("draft");
    expect(result.actions).toHaveLength(2);
    expect(db.tables.changeActions).toMatchObject([
      {
        action_type: "add_negative_exact",
        campaign_id: "10",
        ad_group_id: null,
        search_term: "tractor colouring book",
        entity_name: "Colouring book – exact",
      },
      { action_type: "add_negative_target", search_term: "B0RIVAL123" },
    ]);
    expect(db.tables.changeSets[0]!.metadata).toMatchObject({
      strategy: "campaign_negatives",
      amazonCampaignId: "camp-1",
    });
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });

  it("replays an identical negatives submission instead of duplicating it", async () => {
    const { db } = setupConversion();
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: {
        applyActions: vi.fn(async () => []),
      } as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });

    const first = await service.createCampaignNegativesChangeSet(
      authFixture(),
      "camp-1",
      ["tractor colouring book"],
      META,
    );
    const second = await service.createCampaignNegativesChangeSet(
      authFixture(),
      "camp-1",
      ["tractor colouring book"],
      META,
    );

    expect(second.changeSet.id).toBe(first.changeSet.id);
    expect(db.tables.changeSets).toHaveLength(1);
    expect(db.tables.changeActions).toHaveLength(1);
  });

  // Only the fields the bulk-exclude service reads; the rest of the detail
  // payload is irrelevant to drafting.
  function searchTermDetail(
    searchTerm: string,
    campaigns: Array<{ campaignId: string; state: string }>,
  ): SearchTermDetail {
    return { searchTerm, campaigns } as SearchTermDetail;
  }

  function setupBulkExclude() {
    const { db, profile } = setupConversion();
    db.seedCampaign({
      id: "11",
      profile_id: profile.id,
      amazon_campaign_id: "camp-2",
      name: "Colouring book – auto",
      targeting_type: "auto",
    });
    const service = createChangeService({
      db: db as never,
      pool: db.asPool() as never,
      config: testConfig(),
      logger: fakeLogger(),
      gateway: {
        applyActions: vi.fn(async () => []),
      } as unknown as Pick<
        AmazonAdsGateway,
        "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
      >,
    });
    return { db, service };
  }

  it("drafts one negatives set per enabled campaign the term runs on", async () => {
    const { db, service } = setupBulkExclude();

    const result = await service.createSearchTermNegativesChangeSets(
      authFixture(),
      searchTermDetail("tractor colouring book", [
        // Amazon states arrive uppercase; the filter must normalize case.
        { campaignId: "camp-1", state: "ENABLED" },
        { campaignId: "camp-2", state: "enabled" },
        { campaignId: "camp-3", state: "PAUSED" },
      ]),
      ["camp-1", "camp-2"],
      META,
    );

    expect(result.skippedCampaignIds).toEqual([]);
    expect(result.changeSetIds).toHaveLength(2);
    expect(db.tables.changeSets).toHaveLength(2);
    for (const set of db.tables.changeSets) {
      expect(set.kind).toBe("recommendation");
      expect(set.status).toBe("draft");
      expect(set.metadata).toMatchObject({ strategy: "campaign_negatives" });
    }
    expect(db.tables.changeActions).toMatchObject([
      {
        action_type: "add_negative_exact",
        campaign_id: "10",
        search_term: "tractor colouring book",
      },
      {
        action_type: "add_negative_exact",
        campaign_id: "11",
        search_term: "tractor colouring book",
      },
    ]);
  });

  it("skips disabled and unknown campaign ids instead of failing", async () => {
    const { db, service } = setupBulkExclude();

    const result = await service.createSearchTermNegativesChangeSets(
      authFixture(),
      searchTermDetail("tractor colouring book", [
        { campaignId: "camp-1", state: "enabled" },
        { campaignId: "camp-3", state: "paused" },
      ]),
      ["camp-1", "camp-3", "camp-gone"],
      META,
    );

    expect(result.changeSetIds).toHaveLength(1);
    expect(result.skippedCampaignIds).toEqual(["camp-3", "camp-gone"]);
    expect(db.tables.changeSets).toHaveLength(1);
    expect(db.tables.changeActions).toHaveLength(1);
  });

  it("drafts a negative ASIN target per campaign when the term is an ASIN", async () => {
    const { db, service } = setupBulkExclude();

    const result = await service.createSearchTermNegativesChangeSets(
      authFixture(),
      searchTermDetail("B0RIVAL123", [
        { campaignId: "camp-1", state: "enabled" },
        { campaignId: "camp-2", state: "enabled" },
      ]),
      ["camp-1", "camp-2"],
      META,
    );

    expect(result.changeSetIds).toHaveLength(2);
    expect(db.tables.changeActions).toMatchObject([
      { action_type: "add_negative_target", search_term: "B0RIVAL123" },
      { action_type: "add_negative_target", search_term: "B0RIVAL123" },
    ]);
  });

  it("replays the same sets when the bulk exclude is submitted twice", async () => {
    const { db, service } = setupBulkExclude();
    const detail = searchTermDetail("tractor colouring book", [
      { campaignId: "camp-1", state: "enabled" },
      { campaignId: "camp-2", state: "enabled" },
    ]);

    const first = await service.createSearchTermNegativesChangeSets(
      authFixture(),
      detail,
      ["camp-1", "camp-2"],
      META,
    );
    const second = await service.createSearchTermNegativesChangeSets(
      authFixture(),
      detail,
      ["camp-1", "camp-2"],
      META,
    );

    expect(second.changeSetIds).toEqual(first.changeSetIds);
    expect(db.tables.changeSets).toHaveLength(2);
    expect(db.tables.changeActions).toHaveLength(2);
  });
});
