import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger as Logger } from "fastify";
import type {
  ActionResult,
  AmazonAdsGateway,
  StructureSnapshot,
} from "@amazon-king/amazon-ads";
import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { createChangeService } from "./changes.js";
import type { AuthContext, RequestMeta } from "./types.js";
import { FakeDb } from "../test/fake-db.js";

// -- shared fixtures ---------------------------------------------------------

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

function fakeLogger(): Logger {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    level: "info",
  };
  return logger as unknown as Logger;
}

const META: RequestMeta = { ip: "127.0.0.1", userAgent: "vitest" };

function authFixture(): AuthContext {
  return {
    sessionId: "session-1",
    userId: "1",
    workspaceId: "1",
    email: "owner@example.com",
    sessionTokenHash: "hash-1",
    sessionCreatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

function expectApiError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

function snapshotWith(campaign: {
  campaignId: string;
  name: string;
  state: string;
}): StructureSnapshot {
  return {
    profileId: "amz-profile-1",
    retrievedAt: "2026-08-17T10:00:00.000Z",
    campaigns: [
      {
        campaignId: campaign.campaignId,
        name: campaign.name,
        state: campaign.state,
        dailyBudget: 5,
        startDate: "2026-09-01",
        endDate: null,
        targetingType: "MANUAL",
        dynamicBidding: null,
        raw: {},
      },
    ],
    adGroups: [],
    ads: [],
    keywords: [],
    targets: [],
    negativeKeywords: [],
  };
}

function setup(
  overrides: { killSwitch?: boolean; writeEnabled?: boolean } = {},
) {
  const db = new FakeDb();
  db.seedWorkspace();
  db.seedUser("owner@example.com");
  const connection = db.seedConnection();
  const profile = db.seedProfile({
    connection_id: connection.id,
    profile_id: "amz-profile-1",
    write_enabled: overrides.writeEnabled ?? true,
  });
  const campaign = db.seedCampaign({
    profile_id: profile.id,
    amazon_campaign_id: "camp-1",
    name: "Tractor Launch",
    state: "enabled",
  });
  const gateway = {
    syncCampaignStructure: vi.fn(async () =>
      snapshotWith({
        campaignId: "camp-1",
        name: "Tractor Launch",
        state: "ENABLED",
      }),
    ),
    getCampaignBidControls: vi.fn(async () => {
      throw new Error("Unexpected bid controls call");
    }),
    applyActions: vi.fn(
      async (set: {
        actions: { actionId: string; kind: string }[];
      }): Promise<ActionResult[]> =>
        set.actions.map((action) => ({
          actionId: action.actionId,
          status: "applied",
          code: "SUCCESS",
          amazonEntityId: "camp-1",
        })),
    ),
  };
  const service = createChangeService({
    db: db as never,
    pool: db.asPool() as never,
    config: testConfig({ killSwitch: overrides.killSwitch ?? false }),
    logger: fakeLogger(),
    gateway: gateway as unknown as Pick<
      AmazonAdsGateway,
      "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
    >,
  });
  return { db, service, gateway, campaign };
}

/** Post-write snapshot where the campaign shows the requested state/name. */
function mockLive(
  gateway: ReturnType<typeof setup>["gateway"],
  live: { name: string; state: string },
) {
  gateway.syncCampaignStructure.mockResolvedValue(
    snapshotWith({ campaignId: "camp-1", ...live }),
  );
}

// -- tests ---------------------------------------------------------------------

describe("campaign pause/enable", () => {
  it("pauses a campaign in one click: drafts, applies, verifies, writes through", async () => {
    const { db, service, gateway, campaign } = setup();
    // Live state matches the recorded before-state, then shows paused.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "ENABLED",
        }),
      )
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "PAUSED",
        }),
      );

    const result = await service.updateCampaign(
      authFixture(),
      "camp-1",
      { state: "paused" },
      META,
    );

    expect(result.changeSet).toMatchObject({
      kind: "campaign_update",
      status: "applied",
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      actionType: "update_campaign_state",
      status: "applied",
      beforeDetail: "State: enabled",
      afterDetail: "State: paused",
      rollbackAvailable: true,
    });
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions).toEqual([
      expect.objectContaining({
        kind: "update_campaign_state",
        campaignId: "camp-1",
        state: "paused",
      }),
    ]);
    // Verified state is written through to the local mirror (Amazon format).
    expect(db.tables.campaigns.find((r) => r.id === campaign.id)!.state).toBe(
      "PAUSED",
    );
    expect(
      db.tables.auditEvents.some((r) => r.event === "campaign.update.create"),
    ).toBe(true);
  });

  it("enables a paused campaign", async () => {
    const { service, gateway, campaign } = setup();
    campaign.state = "paused";
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "PAUSED",
        }),
      )
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "ENABLED",
        }),
      );

    const result = await service.updateCampaign(
      authFixture(),
      "camp-1",
      { state: "enabled" },
      META,
    );

    expect(result.changeSet.status).toBe("applied");
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions[0]).toEqual(
      expect.objectContaining({
        kind: "update_campaign_state",
        state: "enabled",
      }),
    );
  });

  it("skips the Amazon write when the campaign already has the desired state", async () => {
    const { service, gateway } = setup();
    mockLive(gateway, { name: "Tractor Launch", state: "ENABLED" });

    const result = await service.updateCampaign(
      authFixture(),
      "camp-1",
      { state: "enabled" },
      META,
    );

    expect(result.changeSet.status).toBe("applied");
    expect(gateway.applyActions).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({
      status: "applied",
      errorMessage: null,
    });
  });

  it("blocks with STALE_BEFORE_STATE when the live state drifted", async () => {
    const { db, service, gateway } = setup();
    // DB says enabled, but the campaign was archived on Amazon — neither the
    // recorded before-state nor the desired state.
    mockLive(gateway, { name: "Tractor Launch", state: "ARCHIVED" });

    await service
      .updateCampaign(authFixture(), "camp-1", { state: "paused" }, META)
      .catch((error) => expectApiError(error, "STALE_BEFORE_STATE"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
    expect(db.tables.changeSets[0]!.status).toBe("blocked");
  });

  it("rejects a read-only profile and the kill switch before any Amazon call", async () => {
    const readOnly = setup({ writeEnabled: false });
    await readOnly.service
      .updateCampaign(authFixture(), "camp-1", { state: "paused" }, META)
      .catch((error) => expectApiError(error, "WRITES_DISABLED"));
    expect(readOnly.gateway.syncCampaignStructure).not.toHaveBeenCalled();

    const killed = setup({ killSwitch: true });
    await killed.service
      .updateCampaign(authFixture(), "camp-1", { state: "paused" }, META)
      .catch((error) => expectApiError(error, "WRITES_DISABLED"));
    expect(killed.db.tables.changeSets).toHaveLength(0);
  });

  it("rolls a pause back to enabled through the compensating path", async () => {
    const { service, gateway } = setup();
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "ENABLED",
        }),
      )
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "PAUSED",
        }),
      );
    const applied = await service.updateCampaign(
      authFixture(),
      "camp-1",
      { state: "paused" },
      META,
    );
    expect(applied.changeSet.status).toBe("applied");

    // Rollback: live is paused (matches the compensating before-state), then
    // the verification read shows enabled again.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "PAUSED",
        }),
      )
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "ENABLED",
        }),
      );
    const rolledBack = await service.rollbackAction(
      authFixture(),
      applied.actions[0]!.id,
      META,
    );

    expect(rolledBack.changeSet).toMatchObject({
      kind: "rollback",
      status: "applied",
    });
    const sent = gateway.applyActions.mock.calls[1]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions[0]).toEqual(
      expect.objectContaining({
        kind: "update_campaign_state",
        state: "enabled",
      }),
    );
  });
});

describe("campaign rename", () => {
  it("renames a campaign, carrying the live state through", async () => {
    const { db, service, gateway, campaign } = setup();
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch",
          state: "ENABLED",
        }),
      )
      .mockResolvedValueOnce(
        snapshotWith({
          campaignId: "camp-1",
          name: "Tractor Launch — paused, accidental auto",
          state: "ENABLED",
        }),
      );

    const result = await service.updateCampaign(
      authFixture(),
      "camp-1",
      { name: "Tractor Launch — paused, accidental auto" },
      META,
    );

    expect(result.changeSet.status).toBe("applied");
    expect(result.actions[0]).toMatchObject({
      actionType: "update_campaign_name",
      status: "applied",
      beforeDetail: "Tractor Launch",
      afterDetail: "Tractor Launch — paused, accidental auto",
      rollbackAvailable: true,
    });
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions[0]).toEqual(
      expect.objectContaining({
        kind: "update_campaign_name",
        campaignId: "camp-1",
        name: "Tractor Launch — paused, accidental auto",
        state: "ENABLED",
      }),
    );
    expect(db.tables.campaigns.find((r) => r.id === campaign.id)!.name).toBe(
      "Tractor Launch — paused, accidental auto",
    );
  });

  it("blocks with STALE_BEFORE_STATE when the live name drifted", async () => {
    const { service, gateway } = setup();
    mockLive(gateway, { name: "Someone renamed it", state: "ENABLED" });

    await service
      .updateCampaign(authFixture(), "camp-1", { name: "New name" }, META)
      .catch((error) => expectApiError(error, "STALE_BEFORE_STATE"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });
});
