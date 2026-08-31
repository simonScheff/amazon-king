import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@amazon-king/observability";
import type { ApiConfig } from "./config.js";
import { unauthorized } from "@amazon-king/read-service";
import { buildServer } from "./server.js";
import type {
  AuthContext,
  ApiServices,
  ReadService,
  SessionService,
} from "./services/types.js";

/**
 * Route-level coverage for the spend explorer endpoints: query-param
 * validation and threading (grain, days, country, currency) on
 * /api/spend/breakdown and /api/spend/tree.
 */

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

function stubServices() {
  const session = {
    authenticate: vi.fn(async () => AUTH),
    verifyCsrf: vi.fn(() => true),
    isRecentAuth: vi.fn(() => true),
  } as unknown as SessionService;
  const read = {
    spendBreakdown: vi.fn(async () => ({ ok: true })),
    spendTree: vi.fn(async () => ({ ok: true })),
  } as unknown as ReadService;
  const services = {
    session,
    changes: {},
    amazon: {},
    read,
  } as unknown as ApiServices;
  return { services, read };
}

describe("spend explorer routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const stubs = stubServices();
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services: stubs.services,
    });
    return stubs;
  }

  it("threads grain, days, country, and currency into the breakdown", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/spend/breakdown?grain=searchTerm&days=14&country=all&currency=EUR",
    });

    expect(response.statusCode).toBe(200);
    expect(read.spendBreakdown).toHaveBeenCalledWith(
      "1",
      "searchTerm",
      14,
      "all",
      "EUR",
    );
  });

  it("applies the breakdown defaults and omits an absent currency", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/spend/breakdown",
    });

    expect(response.statusCode).toBe(200);
    expect(read.spendBreakdown).toHaveBeenCalledWith("1", "campaign", 30, "US");
  });

  it("threads days and country into the tree", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/spend/tree?days=60&country=DE",
    });

    expect(response.statusCode).toBe(200);
    expect(read.spendTree).toHaveBeenCalledWith("1", 60, "DE");
  });

  it("rejects an invalid grain or country with 400", async () => {
    const { read } = await start();

    for (const url of [
      "/api/spend/breakdown?grain=adGroup",
      "/api/spend/breakdown?country=USA",
      "/api/spend/breakdown?currency=US1",
      "/api/spend/tree?days=0",
    ]) {
      const response = await app!.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(read.spendBreakdown).not.toHaveBeenCalled();
    expect(read.spendTree).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const stubs = stubServices();
    (
      stubs.services.session.authenticate as ReturnType<typeof vi.fn>
    ).mockRejectedValue(unauthorized());
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services: stubs.services,
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/spend/breakdown",
    });

    expect(response.statusCode).toBe(401);
  });
});
