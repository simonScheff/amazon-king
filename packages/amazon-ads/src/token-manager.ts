import { AmazonAuthError } from "./errors.js";
import { defaultLogger, type LoggerLike } from "./logger.js";
import type { TokenSet } from "./oauth.js";

/**
 * Server-side access-token cache with serialized refresh per connection
 * (plan §5 step 4). Persistence and decryption live in the DB layer — this
 * package only sees the callbacks below and never touches @amazon-king/database.
 */

export interface PersistedTokenState {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAtMs: number;
}

export interface TokenManagerOptions {
  /** Load and decrypt the stored refresh token for a connection. */
  loadRefreshToken: (connectionId: string) => Promise<string>;
  /** Persist the new token state (DB layer encrypts the refresh token). */
  persistState: (
    connectionId: string,
    state: PersistedTokenState,
  ) => Promise<void>;
  /** Invoked once when the refresh grant is dead; the connection must be marked reconnect_required. */
  onReconnectRequired: (
    connectionId: string,
    error: AmazonAuthError,
  ) => void | Promise<void>;
  /** Perform the actual LWA refresh (injected so tests never touch the network). */
  refreshTokens: (refreshToken: string) => Promise<TokenSet>;
  /** Refresh this long before expiry (default 5 minutes, plan §5 step 3). */
  refreshSkewMs?: number;
  now?: () => number;
  logger?: LoggerLike;
}

export interface TokenManager {
  getAccessToken(connectionId: string): Promise<string>;
  /** Drop the cached access token (e.g. after disconnect). */
  invalidate(connectionId: string): void;
  isReconnectRequired(connectionId: string): boolean;
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const logger = options.logger ?? defaultLogger();
  const now = options.now ?? (() => Date.now());
  const skewMs = options.refreshSkewMs ?? DEFAULT_SKEW_MS;

  const cache = new Map<string, { accessToken: string; expiresAtMs: number }>();
  /** Circuit breaker: connections whose grant is dead stop retrying (plan §8). */
  const broken = new Set<string>();
  /** In-process mutex chain per connectionId so refreshes are serialized. */
  const locks = new Map<string, Promise<void>>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    locks.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chain) {
        locks.delete(key);
      }
    }
  }

  function cachedToken(connectionId: string): string | null {
    const entry = cache.get(connectionId);
    if (entry && entry.expiresAtMs - skewMs > now()) {
      return entry.accessToken;
    }
    return null;
  }

  async function refresh(connectionId: string): Promise<string> {
    const refreshToken = await options.loadRefreshToken(connectionId);
    let tokens: TokenSet;
    try {
      tokens = await options.refreshTokens(refreshToken);
    } catch (error) {
      if (error instanceof AmazonAuthError && error.unrecoverable) {
        // Circuit breaker: mark once, notify once, never retry this grant.
        if (!broken.has(connectionId)) {
          broken.add(connectionId);
          cache.delete(connectionId);
          logger.error(
            { connectionId, code: error.code },
            "Amazon refresh grant is dead; connection requires reconnect",
          );
          await options.onReconnectRequired(connectionId, error);
        }
      }
      throw error;
    }

    const expiresAtMs = now() + tokens.expiresIn * 1000;
    cache.set(connectionId, {
      accessToken: tokens.accessToken,
      expiresAtMs,
    });
    await options.persistState(connectionId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAtMs,
    });
    logger.info({ connectionId }, "Amazon access token refreshed");
    return tokens.accessToken;
  }

  return {
    async getAccessToken(connectionId: string): Promise<string> {
      if (broken.has(connectionId)) {
        throw new AmazonAuthError(
          "reconnect_required",
          "Amazon connection needs re-authorization; refusing to retry a dead grant",
          { unrecoverable: true },
        );
      }
      const cached = cachedToken(connectionId);
      if (cached) {
        return cached;
      }
      return withLock(connectionId, async () => {
        // Re-check inside the lock: a concurrent caller may have refreshed.
        const fresh = cachedToken(connectionId);
        if (fresh) {
          return fresh;
        }
        if (broken.has(connectionId)) {
          throw new AmazonAuthError("reconnect_required", undefined, {
            unrecoverable: true,
          });
        }
        return refresh(connectionId);
      });
    },
    invalidate(connectionId: string): void {
      cache.delete(connectionId);
    },
    isReconnectRequired(connectionId: string): boolean {
      return broken.has(connectionId);
    },
  };
}
