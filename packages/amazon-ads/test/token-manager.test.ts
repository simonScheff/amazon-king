import { describe, expect, it, vi } from "vitest";
import {
  createTokenManager,
  type PersistedTokenState,
} from "../src/token-manager.js";
import { AmazonAuthError } from "../src/errors.js";
import { captureLogs } from "./helpers.js";

function makeManager(overrides: {
  refreshTokens?: (refreshToken: string) => Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>;
  now?: () => number;
  onReconnectRequired?: (connectionId: string, error: AmazonAuthError) => void;
  persisted?: PersistedTokenState[];
}) {
  const persisted: PersistedTokenState[] = overrides.persisted ?? [];
  const reconnects: string[] = [];
  const manager = createTokenManager({
    loadRefreshToken: async () => "Atzr|stored-refresh",
    persistState: async (_id, state) => {
      persisted.push(state);
    },
    onReconnectRequired: (id, error) => {
      reconnects.push(`${id}:${error.code}`);
      overrides.onReconnectRequired?.(id, error);
    },
    refreshTokens:
      overrides.refreshTokens ??
      (async () => ({
        accessToken: "Atza|fresh",
        refreshToken: "Atzr|rotated",
        expiresIn: 3600,
      })),
    now: overrides.now,
    logger: captureLogs().logger,
  });
  return { manager, persisted, reconnects };
}

describe("token manager", () => {
  it("refreshes once and serves the cached token within its lifetime", async () => {
    const refreshTokens = vi.fn(async () => ({
      accessToken: "Atza|fresh",
      refreshToken: "Atzr|rotated",
      expiresIn: 3600,
    }));
    const { manager, persisted } = makeManager({ refreshTokens });
    expect(await manager.getAccessToken("conn-1")).toBe("Atza|fresh");
    expect(await manager.getAccessToken("conn-1")).toBe("Atza|fresh");
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].refreshToken).toBe("Atzr|rotated");
  });

  it("serializes concurrent refreshes per connection (single refresh call)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshTokens = vi.fn(async () => {
      await gate;
      return {
        accessToken: "Atza|fresh",
        refreshToken: "Atzr|rotated",
        expiresIn: 3600,
      };
    });
    const { manager } = makeManager({ refreshTokens });
    const pending = Promise.all(
      Array.from({ length: 5 }, () => manager.getAccessToken("conn-1")),
    );
    // Let all five callers reach the mutex before the refresh completes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const tokens = await pending;
    expect(tokens).toEqual(Array(5).fill("Atza|fresh"));
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("refreshes early when inside the 5-minute skew window", async () => {
    let now = 0;
    const refreshTokens = vi.fn(async () => ({
      accessToken: `Atza|t${refreshTokens.mock.calls.length}`,
      refreshToken: "Atzr|rotated",
      expiresIn: 3600,
    }));
    const { manager } = makeManager({ refreshTokens, now: () => now });
    expect(await manager.getAccessToken("conn-1")).toBe("Atza|t1");
    // 56 minutes in: token valid for 4 more minutes — inside the skew window.
    now = 56 * 60 * 1000;
    expect(await manager.getAccessToken("conn-1")).toBe("Atza|t2");
    expect(refreshTokens).toHaveBeenCalledTimes(2);
  });

  it("serves the cache when outside the skew window", async () => {
    let now = 0;
    const refreshTokens = vi.fn(async () => ({
      accessToken: "Atza|fresh",
      refreshToken: "Atzr|rotated",
      expiresIn: 3600,
    }));
    const { manager } = makeManager({ refreshTokens, now: () => now });
    await manager.getAccessToken("conn-1");
    now = 10 * 60 * 1000; // 50 minutes of validity left
    await manager.getAccessToken("conn-1");
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("marks reconnect_required on invalid_grant and stops retrying (circuit breaker)", async () => {
    const refreshTokens = vi.fn(async () => {
      throw new AmazonAuthError("invalid_grant", "grant revoked");
    });
    const { manager, reconnects } = makeManager({ refreshTokens });

    await expect(manager.getAccessToken("conn-1")).rejects.toMatchObject({
      name: "AmazonAuthError",
      code: "invalid_grant",
    });
    expect(manager.isReconnectRequired("conn-1")).toBe(true);
    expect(reconnects).toEqual(["conn-1:invalid_grant"]);

    // Circuit breaker: subsequent calls fail fast without hitting LWA again.
    await expect(manager.getAccessToken("conn-1")).rejects.toMatchObject({
      code: "reconnect_required",
      unrecoverable: true,
    });
    await expect(manager.getAccessToken("conn-1")).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(reconnects).toHaveLength(1);
  });

  it("does not trip the circuit breaker on recoverable errors", async () => {
    let calls = 0;
    const refreshTokens = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new AmazonAuthError("temporarily_unavailable", undefined, {
          unrecoverable: false,
        });
      }
      return {
        accessToken: "Atza|fresh",
        refreshToken: "Atzr|rotated",
        expiresIn: 3600,
      };
    });
    const { manager, reconnects } = makeManager({ refreshTokens });
    await expect(manager.getAccessToken("conn-1")).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    expect(manager.isReconnectRequired("conn-1")).toBe(false);
    expect(await manager.getAccessToken("conn-1")).toBe("Atza|fresh");
    expect(reconnects).toHaveLength(0);
  });

  it("keeps connections isolated", async () => {
    const refreshTokens = vi.fn(async (refreshToken: string) => ({
      accessToken: `Atza|${refreshToken}`,
      refreshToken: "Atzr|rotated",
      expiresIn: 3600,
    }));
    const manager = createTokenManager({
      loadRefreshToken: async (id) => `stored-${id}`,
      persistState: async () => {},
      onReconnectRequired: () => {},
      refreshTokens,
      logger: captureLogs().logger,
    });
    expect(await manager.getAccessToken("a")).toBe("Atza|stored-a");
    expect(await manager.getAccessToken("b")).toBe("Atza|stored-b");
    expect(refreshTokens).toHaveBeenCalledTimes(2);
  });
});
