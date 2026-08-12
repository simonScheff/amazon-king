import {
  createAmazonAdsGateway,
  createTokenManager,
  refreshAccessToken,
  type ProfileDirectoryEntry,
} from "@amazon-king/amazon-ads";
import { decryptSecret, encryptSecret } from "@amazon-king/crypto";
import {
  audit,
  connections,
  createPool,
  profiles,
} from "@amazon-king/database";
import { createLogger } from "@amazon-king/observability";
import { loadConfig } from "./config.js";
import { createSmtpMagicLinkSender } from "./email.js";
import { buildServer } from "./server.js";
import { createAmazonService } from "./services/amazon.js";
import { createChangeService } from "./services/changes.js";
import { createReadService } from "./services/read.js";
import { createSessionService } from "./services/session.js";

/**
 * Composition root: wires the production services (Postgres-backed) into the
 * HTTP server. Tests build the server with in-memory fakes instead.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger("api");
  const pool = createPool(config.databaseUrl);
  const sendMagicLink = config.smtpHost
    ? createSmtpMagicLinkSender(config)
    : undefined;

  const tokenManager = createTokenManager({
    loadRefreshToken: async (connectionId) => {
      const connection = await connections.getConnection(pool, connectionId);
      if (!connection || connection.encryptedRefreshToken.length === 0) {
        throw new Error(
          `No usable refresh token for connection ${connectionId}`,
        );
      }
      return decryptSecret(connection.encryptedRefreshToken);
    },
    persistState: async (connectionId, state) => {
      const encrypted = encryptSecret(state.refreshToken);
      await connections.updateConnectionSecret(pool, connectionId, {
        encryptedRefreshToken: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      });
    },
    onReconnectRequired: async (connectionId, error) => {
      await connections.updateConnectionStatus(
        pool,
        connectionId,
        "reconnect_required",
        error.code,
      );
      const connection = await connections.getConnection(pool, connectionId);
      if (connection) {
        await audit.insertAuditEvent(pool, {
          workspaceId: connection.workspaceId,
          event: "integrations.amazon.reconnect_required",
          entityType: "amazon_connection",
          entityId: connectionId,
          details: { code: error.code },
        });
      }
    },
    refreshTokens: (refreshToken) =>
      refreshAccessToken({
        refreshToken,
        clientId: config.lwaClientId,
        clientSecret: config.lwaClientSecret,
      }),
    logger,
  });

  const gateway = createAmazonAdsGateway({
    clientId: config.lwaClientId,
    tokenManager,
    profileDirectory: {
      async get(profileId: string): Promise<ProfileDirectoryEntry> {
        const profile = await profiles.getProfile(pool, profileId);
        if (!profile) {
          throw new Error(`Unknown internal profile id ${profileId}`);
        }
        return {
          profileId: profile.profileId,
          connectionId: profile.connectionId,
          region: profile.region,
          accountId: profile.accountId,
        };
      },
    },
    logger,
  });

  const app = await buildServer({
    config,
    logger,
    services: {
      session: createSessionService({
        db: pool,
        config,
        logger,
        sendMagicLink,
      }),
      amazon: createAmazonService({
        db: pool,
        config,
        logger,
        gateway,
        tokenManager,
      }),
      read: createReadService({ db: pool, config, logger }),
      changes: createChangeService({ db: pool, pool, config, logger, gateway }),
    },
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("API failed to start", error);
  process.exit(1);
});
