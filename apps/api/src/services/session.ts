import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { audit, identity, sessions, type Db } from "@amazon-king/database";
import type { FastifyBaseLogger as Logger } from "fastify";
import {
  LOGIN_TOKEN_TTL_MS,
  RECENT_AUTH_MS,
  SESSION_TTL_MS,
  type ApiConfig,
} from "../config.js";
import type { MagicLinkSender } from "../email.js";
import type {
  AuthContext,
  LoginStartResult,
  RequestMeta,
  SessionService,
  VerifiedLogin,
} from "./types.js";

/**
 * Login A (plan §5): passwordless email sign-in. Only SHA-256 hashes of
 * tokens are stored; raw tokens live in the magic link and the HttpOnly
 * cookie. Sessions expire after ~7 days, extended on use (rolling).
 */

export function sha256Hex(value: string): string {
  return createHmac("sha256", "amazon-king-token-hash")
    .update(value, "utf8")
    .digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface SessionServiceDeps {
  db: Db;
  config: ApiConfig;
  logger: Logger;
  sendMagicLink?: MagicLinkSender;
  now?: () => Date;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { db, config, logger } = deps;
  const now = () => deps.now?.() ?? new Date();

  function csrfTokenFor(auth: AuthContext): string {
    return createHmac("sha256", config.sessionSecret)
      .update(`csrf:${auth.sessionTokenHash}`)
      .digest("hex");
  }

  async function recordLoginAudit(
    workspaceId: string | null,
    userId: string | null,
    event: string,
    email: string,
    meta: RequestMeta,
    sessionId?: string | null,
  ): Promise<void> {
    // Login before provisioning has no workspace yet; skip audit there.
    if (workspaceId === null) return;
    await audit.insertAuditEvent(db, {
      workspaceId,
      actorUserId: userId,
      event,
      entityType: "session",
      entityId: sessionId ?? null,
      ip: meta.ip ?? null,
      sessionId: sessionId ?? null,
      details: { email },
    });
  }

  return {
    async startLogin(
      email: string,
      meta: RequestMeta,
    ): Promise<LoginStartResult> {
      if (
        config.ownerEmail &&
        email.toLowerCase() !== config.ownerEmail.toLowerCase()
      ) {
        // Single-owner lock: do not issue tokens to other addresses, and do
        // not reveal whether the address is allowed (silent no-op).
        logger.warn({ event: "login_denied" }, "Login denied by OWNER_EMAIL");
        return {};
      }
      const token = randomToken();
      await sessions.createLoginToken(db, {
        email,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(now().getTime() + LOGIN_TOKEN_TTL_MS),
      });
      const apiBase =
        config.apiPublicUrl ?? new URL(config.amazonRedirectUri).origin;
      const link = `${apiBase}/api/session/verify?token=${token}`;
      if (deps.sendMagicLink) {
        await deps.sendMagicLink({
          to: email,
          url: link,
          expiresInMinutes: LOGIN_TOKEN_TTL_MS / 60_000,
        });
        logger.info({ event: "magic_link_sent" }, "Magic login link sent");
        return {};
      }
      if (!config.isDevelopment) {
        throw new Error("Magic-link delivery is not configured");
      }
      // Development-only delivery. The raw link intentionally bypasses log
      // redaction so a local operator can complete sign-in.
      logger.info(
        { email, magicLink: link },
        "Magic login link (dev delivery)",
      );
      void meta;
      return { devLoginUrl: link };
    },

    async verifyLogin(
      token: string,
      meta: RequestMeta,
    ): Promise<VerifiedLogin | null> {
      const email = await sessions.consumeLoginToken(db, sha256Hex(token));
      if (!email) {
        return null;
      }
      const { user, workspaceId } = await identity.findOrProvisionOwner(
        db,
        email,
      );
      const sessionToken = randomToken();
      const session = await sessions.createSession(db, {
        userId: user.id,
        tokenHash: sha256Hex(sessionToken),
        expiresAt: new Date(now().getTime() + SESSION_TTL_MS),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      const auth: AuthContext = {
        sessionId: session.id,
        userId: user.id,
        workspaceId,
        email: user.email,
        sessionTokenHash: session.tokenHash,
        sessionCreatedAt: new Date(session.createdAt),
        expiresAt: new Date(session.expiresAt),
      };
      await recordLoginAudit(
        workspaceId,
        user.id,
        "auth.sign_in",
        email,
        meta,
        session.id,
      );
      return { sessionToken, auth };
    },

    async authenticate(
      sessionToken: string | undefined,
    ): Promise<AuthContext | null> {
      if (!sessionToken) return null;
      const tokenHash = sha256Hex(sessionToken);
      const session = await sessions.findValidSession(db, tokenHash);
      if (!session) return null;
      // Rolling expiry: extend on use (~7 days, plan §5).
      const expiresAt = await sessions.extendSession(
        db,
        tokenHash,
        new Date(now().getTime() + SESSION_TTL_MS),
      );
      const membership = await identity.findMembership(db, session.userId);
      if (!membership) return null;
      const user = await db.query<{ email: string }>(
        `select email from users where id = $1`,
        [session.userId],
      );
      const email = user.rows[0]?.email;
      if (!email) return null;
      return {
        sessionId: session.id,
        userId: session.userId,
        workspaceId: membership.workspaceId,
        email,
        sessionTokenHash: session.tokenHash,
        sessionCreatedAt: new Date(session.createdAt),
        expiresAt: expiresAt
          ? new Date(expiresAt)
          : new Date(session.expiresAt),
      };
    },

    async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
      await sessions.revokeSession(db, auth.sessionTokenHash);
      await recordLoginAudit(
        auth.workspaceId,
        auth.userId,
        "auth.sign_out",
        auth.email,
        meta,
        auth.sessionId,
      );
    },

    csrfTokenFor,

    verifyCsrf(auth: AuthContext, headerToken: string | undefined): boolean {
      if (!headerToken) return false;
      const expected = Buffer.from(csrfTokenFor(auth), "utf8");
      const actual = Buffer.from(headerToken, "utf8");
      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    },

    isRecentAuth(auth: AuthContext, at?: Date): boolean {
      const reference = at ?? now();
      return (
        reference.getTime() - auth.sessionCreatedAt.getTime() <= RECENT_AUTH_MS
      );
    },
  };
}
