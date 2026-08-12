import type { AmazonAdsGateway, TokenManager } from "@amazon-king/amazon-ads";
import {
  buildAuthorizationUrl,
  exchangeCode,
  AmazonAuthError,
} from "@amazon-king/amazon-ads";
import { encryptSecret } from "@amazon-king/crypto";
import {
  audit,
  connections,
  failPendingJobsForProfiles,
  profiles,
  sessions,
  type Db,
} from "@amazon-king/database";
import type { FastifyBaseLogger as Logger } from "fastify";
import { OAUTH_STATE_TTL_MS, type ApiConfig } from "../config.js";
import { randomToken, sha256Hex } from "./session.js";
import type {
  AmazonCallbackResult,
  AmazonService,
  AmazonStartResult,
  AuthContext,
  RequestMeta,
} from "./types.js";
import type { AmazonConnectionStatus } from "@amazon-king/contracts";

/**
 * Login B (plan §5): Amazon Ads OAuth connection. The browser only ever sees
 * the consent URL and a redirect; codes, tokens, and the client secret stay
 * server-side. State is single-use and marked used BEFORE the code exchange
 * so a replayed callback can never exchange twice.
 */

export interface AmazonServiceDeps {
  db: Db;
  config: ApiConfig;
  logger: Logger;
  gateway: Pick<AmazonAdsGateway, "listProfiles">;
  tokenManager: Pick<TokenManager, "invalidate">;
  /** Injectable for tests; defaults to the real LWA client. */
  exchangeCodeImpl?: typeof exchangeCode;
  now?: () => Date;
}

/** Post-callback redirect destinations: only paths inside WEB_ORIGIN. */
function safeReturnTo(returnTo: string | null, webOrigin: string): string {
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    return `${webOrigin}${returnTo}`;
  }
  return `${webOrigin}/connect?connected=1`;
}

function errorRedirect(webOrigin: string, code: string): AmazonCallbackResult {
  return { redirectTo: `${webOrigin}/connect?error=${code}` };
}

export function createAmazonService(deps: AmazonServiceDeps): AmazonService {
  const { db, config, logger, gateway, tokenManager } = deps;
  const exchange = deps.exchangeCodeImpl ?? exchangeCode;
  const now = () => deps.now?.() ?? new Date();

  return {
    async start(
      auth: AuthContext,
      meta: RequestMeta,
    ): Promise<AmazonStartResult> {
      // ≥128-bit one-time state; only the hash is stored, tied to the user.
      const state = randomToken(32);
      await sessions.createOAuthState(db, {
        stateHash: sha256Hex(state),
        userId: auth.userId,
        returnTo: null,
        expiresAt: new Date(now().getTime() + OAUTH_STATE_TTL_MS),
      });
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "integrations.amazon.start",
        entityType: "amazon_connection",
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
      });
      return {
        url: buildAuthorizationUrl({
          clientId: config.lwaClientId,
          redirectUri: config.amazonRedirectUri,
          state,
        }),
      };
    },

    async handleCallback(
      params: { state?: string; code?: string },
      auth: AuthContext | null,
      meta: RequestMeta,
    ): Promise<AmazonCallbackResult> {
      const { state, code } = params;
      if (!state || !code) {
        return errorRedirect(config.webOrigin, "invalid_callback");
      }
      // Mark the state used BEFORE any token exchange (single use, §5).
      const consumed = await sessions.consumeOAuthState(db, sha256Hex(state));
      if (!consumed) {
        // Unknown, expired, or replayed state.
        return errorRedirect(config.webOrigin, "invalid_state");
      }
      if (!auth) {
        return errorRedirect(config.webOrigin, "session_required");
      }
      if (consumed.userId !== auth.userId) {
        // State was issued to a different user — refuse.
        return errorRedirect(config.webOrigin, "foreign_state");
      }

      let tokens;
      try {
        tokens = await exchange({
          code,
          clientId: config.lwaClientId,
          clientSecret: config.lwaClientSecret,
          redirectUri: config.amazonRedirectUri,
        });
      } catch (error) {
        // Never log the code or token material; AmazonAuthError is sanitized.
        logger.warn(
          { code: error instanceof AmazonAuthError ? error.code : "unknown" },
          "Amazon code exchange failed",
        );
        return errorRedirect(config.webOrigin, "exchange_failed");
      }

      const encrypted = encryptSecret(tokens.refreshToken);
      const connection = await connections.createConnection(db, {
        workspaceId: auth.workspaceId,
        encryptedRefreshToken: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      });

      try {
        const discovered = await gateway.listProfiles(connection.id);
        for (const profile of discovered) {
          await profiles.insertProfile(db, {
            connectionId: connection.id,
            profileId: profile.profileId,
            accountId: profile.accountId,
            region: profile.region,
            countryCode: profile.countryCode,
            currencyCode: profile.currencyCode,
            timezone: profile.timezone,
            accountType: profile.accountType,
          });
        }
        await audit.insertAuditEvent(db, {
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          event: "integrations.amazon.connect",
          entityType: "amazon_connection",
          entityId: connection.id,
          ip: meta.ip ?? null,
          sessionId: auth.sessionId,
          details: { profileCount: discovered.length },
        });
      } catch (error) {
        logger.error(
          { err: error, connectionId: connection.id },
          "Profile discovery failed after connect",
        );
        return errorRedirect(config.webOrigin, "profile_discovery_failed");
      }

      return {
        redirectTo: safeReturnTo(consumed.returnTo, config.webOrigin),
      };
    },

    async status(workspaceId: string): Promise<AmazonConnectionStatus> {
      const connection = await connections.findLatestConnectionByWorkspace(
        db,
        workspaceId,
      );
      if (!connection) {
        return { status: "disconnected", grantedAt: null, lastErrorCode: null };
      }
      return {
        status: connection.status,
        grantedAt: connection.grantedAt
          ? new Date(connection.grantedAt).toISOString()
          : null,
        lastErrorCode: connection.lastErrorCode,
      };
    },

    async disconnect(auth: AuthContext, meta: RequestMeta): Promise<void> {
      const connection = await connections.findLiveConnectionByWorkspace(
        db,
        auth.workspaceId,
      );
      if (!connection) {
        return; // idempotent: nothing live to disconnect
      }
      // Wipe the ciphertext first, then stop queued work for its profiles.
      await connections.disconnectConnection(db, connection.id);
      tokenManager.invalidate(connection.id);
      const allProfiles = await profiles.listProfilesByWorkspace(
        db,
        auth.workspaceId,
      );
      const ownPks = allProfiles
        .filter((p) => p.connectionId === connection.id)
        .map((p) => p.id);
      await failPendingJobsForProfiles(
        db,
        ownPks,
        "Amazon connection disconnected",
      );
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "integrations.amazon.disconnect",
        entityType: "amazon_connection",
        entityId: connection.id,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
      });
    },
  };
}
