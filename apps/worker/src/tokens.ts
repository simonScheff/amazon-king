import {
  AmazonAuthError,
  createTokenManager,
  refreshAccessToken,
  type TokenManager,
  type TokenSet,
} from "@amazon-king/amazon-ads";
import { decryptSecret, encryptSecret } from "@amazon-king/crypto";
import type { Logger } from "pino";
import type { WorkerStore } from "./store.js";
import type { WorkerConfig } from "./config.js";

/**
 * TokenManager wiring (plan §5 step 4, §13): the stored refresh token is
 * decrypted only right before a refresh, and every rotated refresh token is
 * re-encrypted before persisting. Access tokens live only in the
 * TokenManager's in-memory cache. A dead grant marks the connection
 * reconnect_required and dead-letters its pending jobs (circuit breaker).
 */
export function createWorkerTokenManager(
  store: WorkerStore,
  config: WorkerConfig,
  logger: Logger,
  /** Injectable LWA refresh for tests; defaults to the real token endpoint. */
  refreshTokensFn?: (refreshToken: string) => Promise<TokenSet>,
): TokenManager {
  return createTokenManager({
    loadRefreshToken: async (connectionId) => {
      const ciphertext = await store.loadEncryptedRefreshToken(connectionId);
      if (!ciphertext) {
        throw new AmazonAuthError(
          "connection_not_found",
          "No connected Amazon connection with a stored refresh token",
          { unrecoverable: false },
        );
      }
      return decryptSecret(ciphertext);
    },
    persistState: async (connectionId, state) => {
      const encrypted = encryptSecret(state.refreshToken);
      await store.persistRefreshToken(
        connectionId,
        encrypted.ciphertext,
        encrypted.keyVersion,
      );
    },
    onReconnectRequired: async (connectionId, error) => {
      await store.markConnectionReconnectRequired(connectionId, error.code);
      const failed = await store.failPendingJobsForConnection(
        connectionId,
        `amazon connection reconnect_required (${error.code})`,
      );
      logger.warn(
        { connectionId, code: error.code, failedJobs: failed },
        "Amazon connection requires reconnect; pending jobs dead-lettered",
      );
    },
    refreshTokens:
      refreshTokensFn ??
      (async (refreshToken) => {
        if (!config.lwaClientId || !config.lwaClientSecret) {
          throw new AmazonAuthError(
            "missing_lwa_credentials",
            "LWA_CLIENT_ID/LWA_CLIENT_SECRET are not configured; cannot refresh tokens",
            { unrecoverable: false },
          );
        }
        return refreshAccessToken({
          refreshToken,
          clientId: config.lwaClientId,
          clientSecret: config.lwaClientSecret,
        });
      }),
    logger,
  });
}
