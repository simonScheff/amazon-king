import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@amazon-king/observability";
import type { ApiConfig } from "./config.js";
import { unauthorized } from "./errors.js";
import { buildServer } from "./server.js";
import type {
  AuthContext,
  ApiServices,
  ReadService,
  SessionService,
} from "./services/types.js";

/**
 * Route-level coverage for the all-market view
 * (docs/fx-rates-all-market-plan.md §4): query-param validation and threading
 * on the dashboard endpoints, and the workspace display-currency write.
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

function stubServices(
  options: { csrf?: boolean; recentAuth?: boolean; auth?: boolean } = {},
) {
  const session = {
    authenticate: vi.fn(async () => {
      if (options.auth === false) {
        throw unauthorized();
      }
      return AUTH;
    }),
    verifyCsrf: vi.fn(() => options.csrf ?? true),
    isRecentAuth: vi.fn(() => options.recentAuth ?? true),
  } as unknown as SessionService;
  const read = {
    dashboardSummary: vi.fn(async () => ({ ok: true })),
    dashboardCountrySpend: vi.fn(async () => ({ ok: true })),
    updateWorkspaceSettings: vi.fn(async () => ({ displayCurrency: "EUR" })),
    requestFxSync: vi.fn(async () => ({
      latestRateDate: "2026-08-14",
      lastRunState: "succeeded",
      lastRunAt: "2026-08-14T17:01:00.000Z",
      lastError: null,
      stale: false,
      queued: true,
    })),
  } as unknown as ReadService;
  const services = {
    session,
    changes: {},
    amazon: {},
    read,
  } as unknown as ApiServices;
  return { services, read, session };
}

describe("FX dashboard routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(
    options: { csrf?: boolean; recentAuth?: boolean; auth?: boolean } = {},
  ) {
    const stubs = stubServices(options);
    app = await buildServer({
      config: testConfig(),
      logger: createLogger("test", { level: "silent" }),
      services: stubs.services,
    });
    return stubs;
  }

  it("threads country=all and the display currency into the summary", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/dashboard/summary?country=all&currency=EUR&days=7",
    });

    expect(response.statusCode).toBe(200);
    expect(read.dashboardSummary).toHaveBeenCalledWith(
      "1",
      7,
      "all",
      undefined,
      "EUR",
    );
  });

  it("passes no currency when the param is absent (workspace default applies)", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/dashboard/summary?country=all",
    });

    expect(response.statusCode).toBe(200);
    expect(read.dashboardSummary).toHaveBeenCalledWith(
      "1",
      30,
      "all",
      undefined,
    );
  });

  it("rejects an invalid currency code with 400", async () => {
    const { read } = await start();

    for (const url of [
      "/api/dashboard/summary?country=all&currency=US1",
      "/api/dashboard/summary?country=all&currency=us",
      "/api/dashboard/country-spend?currency=EURS",
    ]) {
      const response = await app!.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(read.dashboardSummary).not.toHaveBeenCalled();
    expect(read.dashboardCountrySpend).not.toHaveBeenCalled();
  });

  it("rejects an unknown market literal with 400", async () => {
    await start();

    const response = await app!.inject({
      method: "GET",
      url: "/api/dashboard/summary?country=everything",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("threads the currency into country-spend only when present", async () => {
    const { read } = await start();

    await app!.inject({
      method: "GET",
      url: "/api/dashboard/country-spend?currency=GBP&days=14",
    });
    expect(read.dashboardCountrySpend).toHaveBeenCalledWith(
      "1",
      14,
      undefined,
      "GBP",
    );

    await app!.inject({ method: "GET", url: "/api/dashboard/country-spend" });
    expect(read.dashboardCountrySpend).toHaveBeenCalledWith("1", 30, undefined);
  });

  it("updates the display currency via PATCH /api/workspace/settings", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "PATCH",
      url: "/api/workspace/settings",
      headers: { "x-csrf-token": "csrf", "user-agent": "vitest" },
      payload: { displayCurrency: "EUR" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ displayCurrency: "EUR" });
    expect(read.updateWorkspaceSettings).toHaveBeenCalledWith(
      AUTH,
      { displayCurrency: "EUR" },
      expect.objectContaining({ userAgent: "vitest" }),
    );
  });

  it("rejects an invalid settings payload with 400", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "PATCH",
      url: "/api/workspace/settings",
      headers: { "x-csrf-token": "csrf" },
      payload: { displayCurrency: "eur" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(read.updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("enforces CSRF on the settings write", async () => {
    const { read } = await start({ csrf: false });

    const response = await app!.inject({
      method: "PATCH",
      url: "/api/workspace/settings",
      headers: { "x-csrf-token": "wrong" },
      payload: { displayCurrency: "EUR" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_MISMATCH");
    expect(read.updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("does not require a recent sign-in for the settings write", async () => {
    const { read } = await start({ recentAuth: false });

    const response = await app!.inject({
      method: "PATCH",
      url: "/api/workspace/settings",
      headers: { "x-csrf-token": "csrf" },
      payload: { displayCurrency: "EUR" },
    });

    expect(response.statusCode).toBe(200);
    expect(read.updateWorkspaceSettings).toHaveBeenCalled();
  });

  it("triggers a manual FX sync via POST /api/fx-rates/sync", async () => {
    const { read } = await start();

    const response = await app!.inject({
      method: "POST",
      url: "/api/fx-rates/sync",
      headers: { "x-csrf-token": "csrf", "user-agent": "vitest" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      latestRateDate: "2026-08-14",
      lastRunState: "succeeded",
      lastRunAt: "2026-08-14T17:01:00.000Z",
      lastError: null,
      stale: false,
      queued: true,
    });
    expect(read.requestFxSync).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({ userAgent: "vitest" }),
    );
  });

  it("enforces CSRF on the FX sync trigger", async () => {
    const { read } = await start({ csrf: false });

    const response = await app!.inject({
      method: "POST",
      url: "/api/fx-rates/sync",
      headers: { "x-csrf-token": "wrong" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_MISMATCH");
    expect(read.requestFxSync).not.toHaveBeenCalled();
  });

  it("requires authentication for the FX sync trigger", async () => {
    const { read } = await start({ auth: false });

    const response = await app!.inject({
      method: "POST",
      url: "/api/fx-rates/sync",
      headers: { "x-csrf-token": "csrf" },
    });

    expect(response.statusCode).toBe(401);
    expect(read.requestFxSync).not.toHaveBeenCalled();
  });

  it("does not require a recent sign-in for the FX sync trigger", async () => {
    const { read } = await start({ recentAuth: false });

    const response = await app!.inject({
      method: "POST",
      url: "/api/fx-rates/sync",
      headers: { "x-csrf-token": "csrf" },
    });

    expect(response.statusCode).toBe(200);
    expect(read.requestFxSync).toHaveBeenCalled();
  });
});
