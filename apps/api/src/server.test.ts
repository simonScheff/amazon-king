import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@amazon-king/observability";
import type { ApiConfig } from "./config.js";
import { buildServer } from "./server.js";
import type {
  AuthContext,
  ApiServices,
  ChangeService,
  SessionService,
} from "./services/types.js";

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

const AUTH: AuthContext = {
  sessionId: "session-1",
  userId: "1",
  workspaceId: "1",
  email: "owner@example.com",
  sessionTokenHash: "hash-1",
  sessionCreatedAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
};

const VALID_BODY = {
  profileIds: ["amz-profile-1"],
  campaign: {
    name: "Tractor Launch",
    dailyBudget: "5.00",
    targetingType: "MANUAL",
    startDate: "2026-09-01",
  },
  adGroup: { name: "Core", defaultBid: "0.40" },
  bookId: "book-1",
  keywords: [{ text: "tractor book", matchType: "EXACT", bid: "0.45" }],
};

function stubServices(
  options: { recentAuth?: boolean; changeSetStatus?: string } = {},
) {
  const session = {
    authenticate: vi.fn(async () => AUTH),
    verifyCsrf: vi.fn(() => true),
    isRecentAuth: vi.fn(() => options.recentAuth ?? true),
  } as unknown as SessionService;
  const changes = {
    createCampaignCreationChangeSets: vi.fn(async () => ({
      changeSets: [
        {
          id: "set-1",
          profileId: "amz-profile-1",
          status: "draft",
          createdAt: "2026-08-14T10:00:00.000Z",
          kind: "campaign_creation",
        },
      ],
    })),
    getChangeSetStatus: vi.fn(
      async () => options.changeSetStatus ?? "previewed",
    ),
    applyChangeSet: vi.fn(async () => ({ id: "set-1", status: "applied" })),
  } as unknown as ChangeService;
  const services = {
    session,
    changes,
    amazon: {},
    read: {},
  } as unknown as ApiServices;
  return { services, changes };
}

describe("POST /api/campaign-creation-change-sets", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(options: { recentAuth?: boolean } = {}) {
    const stubs = stubServices(options);
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services: stubs.services,
    });
    return stubs;
  }

  it("creates change sets and defaults the campaign to paused", async () => {
    const { changes } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/campaign-creation-change-sets",
      headers: { "x-csrf-token": "csrf", "user-agent": "vitest" },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      changeSets: [
        {
          id: "set-1",
          profileId: "amz-profile-1",
          status: "draft",
          createdAt: "2026-08-14T10:00:00.000Z",
          kind: "campaign_creation",
        },
      ],
    });
    expect(changes.createCampaignCreationChangeSets).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({
        campaign: expect.objectContaining({ state: "paused" }),
      }),
      expect.objectContaining({ userAgent: "vitest" }),
    );
  });

  it("accepts a targets-only payload", async () => {
    const { changes } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/campaign-creation-change-sets",
      headers: { "x-csrf-token": "csrf", "user-agent": "vitest" },
      payload: {
        ...VALID_BODY,
        keywords: [],
        targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(changes.createCampaignCreationChangeSets).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({
        keywords: [],
        targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
      }),
      expect.anything(),
    );
  });

  it("rejects an invalid body with 400", async () => {
    const { changes } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/campaign-creation-change-sets",
      headers: { "x-csrf-token": "csrf" },
      payload: { ...VALID_BODY, keywords: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(changes.createCampaignCreationChangeSets).not.toHaveBeenCalled();
  });

  it("requires a recent sign-in", async () => {
    const { changes } = await start({ recentAuth: false });

    const response = await app!.inject({
      method: "POST",
      url: "/api/campaign-creation-change-sets",
      headers: { "x-csrf-token": "csrf" },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("REAUTH_REQUIRED");
    expect(changes.createCampaignCreationChangeSets).not.toHaveBeenCalled();
  });
});

describe("POST /api/change-sets/:id/apply", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(
    options: { recentAuth?: boolean; changeSetStatus?: string } = {},
  ) {
    const stubs = stubServices(options);
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services: stubs.services,
    });
    return stubs;
  }

  function apply() {
    return app!.inject({
      method: "POST",
      url: "/api/change-sets/set-1/apply",
      headers: { "x-csrf-token": "csrf" },
    });
  }

  it("applies a previewed set with a recent sign-in", async () => {
    const { changes } = await start({ changeSetStatus: "previewed" });

    const response = await apply();

    expect(response.statusCode).toBe(200);
    expect(changes.applyChangeSet).toHaveBeenCalledWith(
      AUTH,
      "set-1",
      expect.anything(),
    );
  });

  it("requires a recent sign-in for a first-time apply", async () => {
    const { changes } = await start({
      recentAuth: false,
      changeSetStatus: "previewed",
    });

    const response = await apply();

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("REAUTH_REQUIRED");
    expect(changes.applyChangeSet).not.toHaveBeenCalled();
  });

  it("retries a failed set without a recent sign-in", async () => {
    const { changes } = await start({
      recentAuth: false,
      changeSetStatus: "failed",
    });

    const response = await apply();

    expect(response.statusCode).toBe(200);
    expect(changes.applyChangeSet).toHaveBeenCalledWith(
      AUTH,
      "set-1",
      expect.anything(),
    );
  });
});

describe("GET metric endpoints: books query param", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const session = {
      authenticate: vi.fn(async () => AUTH),
      verifyCsrf: vi.fn(() => true),
      isRecentAuth: vi.fn(() => true),
    } as unknown as SessionService;
    const read = {
      dashboardSummary: vi.fn(async () => ({ ok: true })),
      dashboardCountrySpend: vi.fn(async () => ({ ok: true })),
      listCampaigns: vi.fn(async () => []),
      getCampaignDetail: vi.fn(async () => ({ ok: true })),
      listSearchTerms: vi.fn(async () => []),
      getSearchTermDetail: vi.fn(async () => ({ ok: true })),
      listRecommendations: vi.fn(async () => []),
    };
    const services = {
      session,
      changes: {},
      amazon: {},
      read,
    } as unknown as ApiServices;
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services,
    });
    return { read };
  }

  it("parses a comma-separated list, trimming and dropping empties", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/campaigns?days=7&books=7,%209,,",
    });

    expect(response.statusCode).toBe(200);
    expect(read.listCampaigns).toHaveBeenCalledWith("1", 7, ["7", "9"]);
  });

  it("threads the filter through every metric endpoint", async () => {
    const { read } = await start();

    await app!.inject({ method: "GET", url: "/api/dashboard/summary?books=7" });
    expect(read.dashboardSummary).toHaveBeenCalledWith("1", 30, "US", ["7"]);

    await app!.inject({
      method: "GET",
      url: "/api/dashboard/country-spend?books=7,9",
    });
    expect(read.dashboardCountrySpend).toHaveBeenCalledWith("1", 30, [
      "7",
      "9",
    ]);

    await app!.inject({ method: "GET", url: "/api/campaigns/camp-1?books=7" });
    expect(read.getCampaignDetail).toHaveBeenCalledWith("1", "camp-1", 30, [
      "7",
    ]);

    await app!.inject({
      method: "GET",
      url: "/api/search-terms?books=7&country=de",
    });
    expect(read.listSearchTerms).toHaveBeenCalledWith("1", 30, ["7"], "DE");

    await app!.inject({
      method: "GET",
      url: "/api/search-terms/fantasy%20books?books=7,9",
    });
    expect(read.getSearchTermDetail).toHaveBeenCalledWith(
      "1",
      "fantasy books",
      30,
      ["7", "9"],
      null,
    );

    await app!.inject({ method: "GET", url: "/api/recommendations?books=9" });
    expect(read.listRecommendations).toHaveBeenCalledWith("1", {
      type: undefined,
      state: undefined,
      bookIds: ["9"],
    });
  });

  it("leaves the filter unset when the param is absent", async () => {
    const { read } = await start();

    await app!.inject({ method: "GET", url: "/api/campaigns" });
    expect(read.listCampaigns).toHaveBeenCalledWith("1", 30, undefined);

    await app!.inject({ method: "GET", url: "/api/search-terms" });
    expect(read.listSearchTerms).toHaveBeenCalledWith("1", 30, null, null);
  });

  it("ignores the retired single book param on search terms", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/search-terms?book=7",
    });

    expect(response.statusCode).toBe(200);
    expect(read.listSearchTerms).toHaveBeenCalledWith("1", 30, null, null);
  });
});

describe("POST /api/session/login", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const session = {
      authenticate: vi.fn(async () => AUTH),
      verifyCsrf: vi.fn(() => true),
      isRecentAuth: vi.fn(() => true),
      startLogin: vi.fn(async () => ({})),
    } as unknown as SessionService;
    const services = {
      session,
      changes: {},
      amazon: {},
      read: {},
    } as unknown as ApiServices;
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services,
    });
    return { session };
  }

  it("passes the requested post-verify path to the session service", async () => {
    const { session } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { email: "owner@example.com", next: "/changes" },
    });

    expect(response.statusCode).toBe(200);
    expect(session.startLogin).toHaveBeenCalledWith(
      "owner@example.com",
      expect.anything(),
      undefined,
      "/changes",
    );
  });

  it("rejects a post-verify path that could leave the origin", async () => {
    const { session } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { email: "owner@example.com", next: "//evil.example.com" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(session.startLogin).not.toHaveBeenCalled();
  });
});

describe("GET /api/session/verify", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(nextPath: string | null) {
    const session = {
      verifyLogin: vi.fn(async () => ({
        sessionToken: "raw-session-token",
        auth: AUTH,
        webOrigin: "http://localhost:5173",
        nextPath,
      })),
    } as unknown as SessionService;
    const services = {
      session,
      changes: {},
      amazon: {},
      read: {},
    } as unknown as ApiServices;
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services,
    });
    return { session };
  }

  it("redirects back to the requested in-app path after verify", async () => {
    await start("/changes");

    const response = await app!.inject({
      method: "GET",
      url: "/api/session/verify?token=abc",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://localhost:5173/changes");
  });

  it("redirects to the bare web origin when no path was requested", async () => {
    await start(null);

    const response = await app!.inject({
      method: "GET",
      url: "/api/session/verify?token=abc",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://localhost:5173");
  });
});
