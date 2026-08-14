import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  bookEconomicsInputSchema,
  bookCoverInputSchema,
  bookMappingInputSchema,
  campaignCreationCreateSchema,
  campaignCreationResultSchema,
  cannibalizationResolutionCreateSchema,
  changeSetCreateSchema,
  loginRequestSchema,
  profileUpdateSchema,
  recommendationStateSchema,
  recommendationTypeSchema,
  setCampaignMaxCpcSchema,
} from "@amazon-king/contracts";
import { withRequestId } from "@amazon-king/observability";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { FastifyBaseLogger as Logger } from "fastify";
import { z, type ZodType } from "zod";
import type { ApiConfig } from "./config.js";
import {
  ApiError,
  forbidden,
  notFound,
  unauthorized,
  validationError,
} from "./errors.js";
import type {
  AuthContext,
  ApiServices,
  RequestMeta,
} from "./services/types.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE = "ak_session";

export interface BuildServerDeps {
  config: ApiConfig;
  logger: Logger;
  services: ApiServices;
}

const STRICT_RATE = { max: 10, timeWindow: "1 minute" } as const;
const WRITE_RATE = { max: 20, timeWindow: "1 minute" } as const;

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(result.error.issues);
  }
  return result.data;
}

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
  };
}

export async function buildServer(
  deps: BuildServerDeps,
): Promise<FastifyInstance> {
  const { config, logger, services } = deps;
  const app = Fastify({
    loggerInstance: logger,
    // Propagate or generate a request id; echoed in logs and the response header.
    genReqId: (req) =>
      withRequestId(req.headers["x-request-id"] as string | undefined),
    trustProxy: config.trustProxy,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(fastifyCors, {
    origin: config.webOrigin,
    credentials: true,
  });
  await app.register(fastifyRateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });

  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // CSRF: every browser mutation under /api requires a valid session and an
  // x-csrf-token header matching the session-derived token (plan §5/§13).
  // Exempt: login (no session yet). The OAuth callback and session verify
  // are GETs and never reach this check.
  app.addHook("preHandler", async (request) => {
    if (
      request.method !== "POST" &&
      request.method !== "PATCH" &&
      request.method !== "DELETE"
    ) {
      return;
    }
    if (!request.url.startsWith("/api/")) return;
    if (request.routeOptions.url === "/api/session/login") return;
    const auth = await authenticate(request);
    if (
      !services.session.verifyCsrf(
        auth,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      throw forbidden(
        "CSRF_MISMATCH",
        "Missing or invalid x-csrf-token header",
      );
    }
    request.auth = auth;
  });

  async function authenticate(request: FastifyRequest): Promise<AuthContext> {
    if (request.auth) return request.auth;
    const auth = await services.session.authenticate(
      request.cookies[SESSION_COOKIE],
    );
    if (!auth) throw unauthorized();
    request.auth = auth;
    return auth;
  }

  /** Spend-changing actions require authentication within the recent window. */
  function requireRecentAuth(auth: AuthContext): void {
    if (!services.session.isRecentAuth(auth)) {
      throw unauthorized(
        "REAUTH_REQUIRED",
        "This action requires a recent sign-in; log in again to continue",
      );
    }
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    const err = error as { statusCode?: number; message?: string };
    const statusCode =
      typeof err.statusCode === "number" ? err.statusCode : 500;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests; slow down",
        },
      });
    }
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL" : "REQUEST_ERROR",
        message:
          statusCode >= 500
            ? "Internal server error"
            : (err.message ?? "Request failed"),
      },
    });
  });

  // -------------------------------------------------------------------------
  // Health (no auth)
  // -------------------------------------------------------------------------

  app.get("/api/health", async () => ({ status: "ok" }));

  // -------------------------------------------------------------------------
  // Session (Login A)
  // -------------------------------------------------------------------------

  app.post(
    "/api/session/login",
    { config: { rateLimit: STRICT_RATE } },
    async (request) => {
      const body = parse(loginRequestSchema, request.body);
      const result = await services.session.startLogin(
        body.email,
        meta(request),
        request.headers.origin,
      );
      // Always 200: never reveal whether an email is allowed.
      return { ok: true, ...result };
    },
  );

  app.get(
    "/api/session/verify",
    { config: { rateLimit: STRICT_RATE } },
    async (request, reply) => {
      const query = parse(
        z.object({ token: z.string().min(1) }),
        request.query,
      );
      const verified = await services.session.verifyLogin(
        query.token,
        meta(request),
      );
      if (!verified) {
        return reply.redirect(`${config.webOrigin}/login?error=invalid_token`);
      }
      reply.setCookie(SESSION_COOKIE, verified.sessionToken, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: !config.isDevelopment,
        expires: verified.auth.expiresAt,
      });
      return reply.redirect(verified.webOrigin);
    },
  );

  app.post("/api/session/logout", async (request, reply) => {
    const auth = await authenticate(request);
    await services.session.logout(auth, meta(request));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/api/session", async (request) => {
    const auth = await authenticate(request);
    return {
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      email: auth.email,
      expiresAt: auth.expiresAt.toISOString(),
      csrfToken: services.session.csrfTokenFor(auth),
    };
  });

  // -------------------------------------------------------------------------
  // Amazon connection (Login B)
  // -------------------------------------------------------------------------

  app.post(
    "/api/integrations/amazon/start",
    { config: { rateLimit: STRICT_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      return services.amazon.start(auth, meta(request));
    },
  );

  app.get(
    "/api/integrations/amazon/callback",
    { config: { rateLimit: STRICT_RATE } },
    async (request, reply) => {
      const query = parse(
        z.object({ state: z.string().optional(), code: z.string().optional() }),
        request.query,
      );
      // Session may be absent; the service maps that to a redirect error.
      const auth = await services.session.authenticate(
        request.cookies[SESSION_COOKIE],
      );
      const result = await services.amazon.handleCallback(
        query,
        auth,
        meta(request),
      );
      return reply.redirect(result.redirectTo);
    },
  );

  app.get("/api/integrations/amazon/status", async (request) => {
    const auth = await authenticate(request);
    return services.amazon.status(auth.workspaceId);
  });

  app.post("/api/integrations/amazon/disconnect", async (request, reply) => {
    const auth = await authenticate(request);
    await services.amazon.disconnect(auth, meta(request));
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Profiles and syncs
  // -------------------------------------------------------------------------

  app.get("/api/profiles", async (request) => {
    const auth = await authenticate(request);
    return services.read.listProfiles(auth.workspaceId);
  });

  app.patch("/api/profiles/:profileId", async (request) => {
    const auth = await authenticate(request);
    const { profileId } = request.params as { profileId: string };
    const patch = parse(profileUpdateSchema, request.body);
    return services.read.updateProfile(auth, profileId, patch, meta(request));
  });

  app.post(
    "/api/profiles/:profileId/syncs",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      const { profileId } = request.params as { profileId: string };
      return services.read.requestSync(auth, profileId, meta(request));
    },
  );

  app.get("/api/syncs/:syncId", async (request) => {
    const auth = await authenticate(request);
    const { syncId } = request.params as { syncId: string };
    const run = await services.read.getSyncRun(auth.workspaceId, syncId);
    if (!run) throw notFound("Unknown sync run");
    return run;
  });

  // -------------------------------------------------------------------------
  // Dashboard, campaigns, books
  // -------------------------------------------------------------------------

  const daysQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  });

  const dashboardQuerySchema = daysQuerySchema.extend({
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .default("US"),
  });

  app.get("/api/dashboard/summary", async (request) => {
    const auth = await authenticate(request);
    const { days, country } = parse(dashboardQuerySchema, request.query);
    return services.read.dashboardSummary(auth.workspaceId, days, country);
  });

  app.get("/api/campaigns", async (request) => {
    const auth = await authenticate(request);
    const { days } = parse(daysQuerySchema, request.query);
    return services.read.listCampaigns(auth.workspaceId, days);
  });

  app.get("/api/campaigns/:id", async (request) => {
    const auth = await authenticate(request);
    const { id } = request.params as { id: string };
    const { days } = parse(daysQuerySchema, request.query);
    const detail = await services.read.getCampaignDetail(
      auth.workspaceId,
      id,
      days,
    );
    if (!detail) throw notFound("Unknown campaign");
    return detail;
  });

  const searchTermsQuerySchema = daysQuerySchema.extend({
    book: z.string().min(1).optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
  });

  app.get("/api/search-terms", async (request) => {
    const auth = await authenticate(request);
    const { days, book } = parse(searchTermsQuerySchema, request.query);
    return services.read.listSearchTerms(auth.workspaceId, days, book ?? null);
  });

  app.get("/api/search-terms/:term", async (request) => {
    const auth = await authenticate(request);
    const { term } = request.params as { term: string };
    const { days, book, country } = parse(
      searchTermsQuerySchema,
      request.query,
    );
    const detail = await services.read.getSearchTermDetail(
      auth.workspaceId,
      term,
      days,
      book ?? null,
      country ?? null,
    );
    if (!detail) throw notFound("Unknown search term");
    return detail;
  });

  app.get("/api/books", async (request) => {
    const auth = await authenticate(request);
    return services.read.listBooks(auth.workspaceId);
  });

  app.get("/api/books/unmapped-products", async (request) => {
    const auth = await authenticate(request);
    return services.read.listUnmappedAdvertisedProducts(auth.workspaceId);
  });

  app.post(
    "/api/books/mappings",
    { config: { rateLimit: WRITE_RATE } },
    async (request, reply) => {
      const auth = await authenticate(request);
      const input = parse(bookMappingInputSchema, request.body);
      const book = await services.read.mapAdvertisedProduct(
        auth,
        input,
        meta(request),
      );
      return reply.status(201).send(book);
    },
  );

  app.post("/api/books/:bookId/economics", async (request, reply) => {
    const auth = await authenticate(request);
    const { bookId } = request.params as { bookId: string };
    const input = parse(bookEconomicsInputSchema, request.body);
    await services.read.saveBookEconomics(auth, bookId, input, meta(request));
    return reply.status(204).send();
  });

  app.put(
    "/api/books/:bookId/cover",
    { config: { rateLimit: WRITE_RATE } },
    async (request, reply) => {
      const auth = await authenticate(request);
      const { bookId } = request.params as { bookId: string };
      const input = parse(bookCoverInputSchema, request.body);
      await services.read.saveBookCover(auth, bookId, input, meta(request));
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Recommendations and change sets
  // -------------------------------------------------------------------------

  app.get("/api/recommendations", async (request) => {
    const auth = await authenticate(request);
    const filter = parse(
      z.object({
        type: recommendationTypeSchema.optional(),
        state: recommendationStateSchema.optional(),
      }),
      request.query,
    );
    return services.read.listRecommendations(auth.workspaceId, filter);
  });

  app.get("/api/recommendations/:id", async (request) => {
    const auth = await authenticate(request);
    const { id } = request.params as { id: string };
    const rec = await services.read.getRecommendation(auth.workspaceId, id);
    if (!rec) throw notFound("Unknown recommendation");
    return rec;
  });

  app.get(
    "/api/recommendations/:id/cannibalization-context",
    async (request) => {
      const auth = await authenticate(request);
      const { id } = request.params as { id: string };
      const context = await services.read.getCannibalizationResolutionContext(
        auth.workspaceId,
        id,
      );
      if (!context) throw notFound("Unknown recommendation");
      return context;
    },
  );

  app.post("/api/recommendations/:id/reject", async (request) => {
    const auth = await authenticate(request);
    const { id } = request.params as { id: string };
    const rec = await services.read.rejectRecommendation(
      auth,
      id,
      meta(request),
    );
    if (!rec) throw notFound("Unknown recommendation");
    return rec;
  });

  app.post("/api/recommendations/change-sets", async (request) => {
    const auth = await authenticate(request);
    const body = parse(changeSetCreateSchema, request.body);
    const result = await services.changes.createChangeSet(
      auth,
      body.recommendationIds,
      meta(request),
    );
    return result.changeSet;
  });

  app.post(
    "/api/recommendations/:id/cannibalization-change-set",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      const { id } = request.params as { id: string };
      const body = parse(cannibalizationResolutionCreateSchema, request.body);
      const result = await services.changes.createCannibalizationChangeSet(
        auth,
        id,
        body.destinationCampaignId,
        meta(request),
      );
      return result.changeSet;
    },
  );

  app.get("/api/campaigns/:campaignId/max-cpc", async (request) => {
    const auth = await authenticate(request);
    const { campaignId } = request.params as { campaignId: string };
    return services.changes.getCampaignMaxCpc(auth.workspaceId, campaignId);
  });

  app.post(
    "/api/campaigns/:campaignId/max-cpc",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      requireRecentAuth(auth);
      const { campaignId } = request.params as { campaignId: string };
      const body = parse(setCampaignMaxCpcSchema, request.body);
      return services.changes.setCampaignMaxCpc(
        auth,
        campaignId,
        body.maxCpc,
        meta(request),
      );
    },
  );

  app.post(
    "/api/campaign-creation-change-sets",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      requireRecentAuth(auth);
      const body = parse(campaignCreationCreateSchema, request.body);
      const result = await services.changes.createCampaignCreationChangeSets(
        auth,
        body,
        meta(request),
      );
      return parse(campaignCreationResultSchema, result);
    },
  );

  app.get("/api/change-sets", async (request) => {
    const auth = await authenticate(request);
    return services.read.listChangeSets(auth.workspaceId);
  });

  app.get(
    "/api/change-sets/:id/preview",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      const { id } = request.params as { id: string };
      return services.changes.previewChangeSet(auth, id, meta(request));
    },
  );

  app.post(
    "/api/change-sets/:id/apply",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      requireRecentAuth(auth);
      const { id } = request.params as { id: string };
      return services.changes.applyChangeSet(auth, id, meta(request));
    },
  );

  app.post(
    "/api/change-actions/:actionId/rollback",
    { config: { rateLimit: WRITE_RATE } },
    async (request) => {
      const auth = await authenticate(request);
      requireRecentAuth(auth);
      const { actionId } = request.params as { actionId: string };
      return services.changes.rollbackAction(auth, actionId, meta(request));
    },
  );

  // -------------------------------------------------------------------------
  // Audit and system
  // -------------------------------------------------------------------------

  app.get("/api/audit-events", async (request) => {
    const auth = await authenticate(request);
    return services.read.listAuditEvents(auth.workspaceId);
  });

  app.get("/api/system/data-freshness", async (request) => {
    const auth = await authenticate(request);
    return services.read.dataFreshness(auth.workspaceId);
  });

  return app;
}
