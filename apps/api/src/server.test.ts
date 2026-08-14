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

function stubServices(options: { recentAuth?: boolean } = {}) {
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
