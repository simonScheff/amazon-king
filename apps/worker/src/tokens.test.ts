import { beforeEach, describe, expect, it } from "vitest";
import { AmazonAuthError } from "@amazon-king/amazon-ads";
import { decryptSecret, encryptSecret } from "@amazon-king/crypto";
import { createWorkerTokenManager } from "./tokens.js";
import { FakeStore, testConfig, testLogger } from "./test-utils.js";

const TEST_KEY = "11".repeat(32); // 64 hex chars

describe("token manager wiring", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  it("decrypts the stored refresh token, refreshes, and re-encrypts on persist", async () => {
    const store = new FakeStore();
    store.connections.push({ id: "3", workspaceId: "1", status: "connected" });
    store.refreshTokens.set("3", {
      ciphertext: encryptSecret("refresh-token-1").ciphertext,
      keyVersion: 1,
    });
    const seenRefreshTokens: string[] = [];
    const manager = createWorkerTokenManager(
      store,
      testConfig({ lwaClientId: "id", lwaClientSecret: "secret" }),
      testLogger(),
      async (refreshToken) => {
        seenRefreshTokens.push(refreshToken);
        return {
          accessToken: "access-1",
          refreshToken: "refresh-token-2",
          expiresIn: 3600,
        };
      },
    );

    const accessToken = await manager.getAccessToken("3");

    expect(accessToken).toBe("access-1");
    // The LWA refresh received the decrypted stored token.
    expect(seenRefreshTokens).toEqual(["refresh-token-1"]);
    // The rotated refresh token was persisted encrypted — and decrypts back.
    const persisted = store.refreshTokens.get("3")!;
    expect(decryptSecret(persisted.ciphertext)).toBe("refresh-token-2");
    // A second call serves the in-memory cache without another refresh.
    await manager.getAccessToken("3");
    expect(seenRefreshTokens).toHaveLength(1);
  });

  it("marks the connection reconnect_required and dead-letters its pending jobs on a dead grant", async () => {
    const store = new FakeStore();
    store.connections.push({ id: "3", workspaceId: "1", status: "connected" });
    store.profiles.push({
      id: "7",
      amazonProfileId: "amz-7",
      connectionId: "3",
      workspaceId: "1",
      region: "NA",
      currencyCode: "USD",
      enabled: true,
    });
    store.refreshTokens.set("3", {
      ciphertext: encryptSecret("dead-token").ciphertext,
      keyVersion: 1,
    });
    await store.enqueue("metrics_sync", {
      profileId: "7",
      startDate: "2026-08-01",
      endDate: "2026-08-05",
    });
    await store.enqueue("schedule_tick", {}); // unrelated job must survive

    const manager = createWorkerTokenManager(
      store,
      testConfig({ lwaClientId: "id", lwaClientSecret: "secret" }),
      testLogger(),
      async () => {
        throw new AmazonAuthError("invalid_grant", "Token has been revoked");
      },
    );

    await expect(manager.getAccessToken("3")).rejects.toBeInstanceOf(
      AmazonAuthError,
    );

    expect(store.connections[0]!.status).toBe("reconnect_required");
    const metricsJob = store.jobs.find((job) => job.type === "metrics_sync")!;
    expect(metricsJob.status).toBe("dead");
    const tickJob = store.jobs.find((job) => job.type === "schedule_tick")!;
    expect(tickJob.status).toBe("pending");
    // The circuit breaker refuses further attempts without calling refresh again.
    await expect(manager.getAccessToken("3")).rejects.toBeInstanceOf(
      AmazonAuthError,
    );
  });
});
