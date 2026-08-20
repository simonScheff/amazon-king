import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger as Logger } from "fastify";
import type {
  ActionResult,
  AmazonAdsGateway,
  StructureSnapshot,
} from "@amazon-king/amazon-ads";
import type { CampaignCreationCreate } from "@amazon-king/contracts";
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

function authFixture(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    sessionId: "session-1",
    userId: "1",
    workspaceId: "1",
    email: "owner@example.com",
    sessionTokenHash: "hash-1",
    sessionCreatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

function expectApiError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

function emptySnapshot(): StructureSnapshot {
  return {
    profileId: "amz-profile-1",
    retrievedAt: "2026-08-14T10:00:00.000Z",
    campaigns: [],
    adGroups: [],
    ads: [],
    keywords: [],
    targets: [],
    negativeKeywords: [],
  };
}

/** The created chain as a post-write structure read should report it. */
function createdSnapshot(overrides: Partial<StructureSnapshot> = {}) {
  const snapshot: StructureSnapshot = {
    ...emptySnapshot(),
    campaigns: [
      {
        campaignId: "camp-new",
        name: "Tractor Launch",
        state: "PAUSED",
        dailyBudget: 5,
        startDate: "2026-09-01",
        endDate: null,
        targetingType: "MANUAL",
        dynamicBidding: null,
        raw: {},
      },
    ],
    adGroups: [
      {
        adGroupId: "ag-new",
        campaignId: "camp-new",
        name: "Core",
        state: "PAUSED",
        defaultBid: 0.4,
        raw: {},
      },
    ],
    ads: [
      {
        adId: "ad-new",
        campaignId: "camp-new",
        adGroupId: "ag-new",
        state: "PAUSED",
        asin: "B012345678",
        sku: null,
        raw: {},
      },
    ],
    keywords: [
      {
        keywordId: "kw-new-1",
        campaignId: "camp-new",
        adGroupId: "ag-new",
        keywordText: "tractor book",
        matchType: "EXACT",
        state: "PAUSED",
        bid: 0.45,
        raw: {},
      },
      {
        keywordId: "kw-new-2",
        campaignId: "camp-new",
        adGroupId: "ag-new",
        keywordText: "farm colouring",
        matchType: "BROAD",
        state: "PAUSED",
        bid: 0.3,
        raw: {},
      },
    ],
  };
  return { ...snapshot, ...overrides };
}

const AMAZON_IDS_BY_KIND: Record<string, string> = {
  create_campaign: "camp-new",
  create_ad_group: "ag-new",
  create_product_ad: "ad-new",
};

/** A product-target row as a post-write structure read should report it. */
function targetRow(targetId: string, asin: string) {
  return {
    targetId,
    campaignId: "camp-new",
    adGroupId: "ag-new",
    state: "PAUSED",
    bid: 0.5,
    expressionType: "ASIN_SAME_AS",
    expression: [{ type: "ASIN_SAME_AS", value: asin }],
    raw: {},
  };
}

function gatewayBase() {
  let keywordCount = 0;
  let targetCount = 0;
  return {
    syncCampaignStructure: vi.fn(async () => emptySnapshot()),
    getCampaignBidControls: vi.fn(async () => {
      throw new Error("Unexpected Max CPC controls call");
    }),
    applyActions: vi.fn(
      async (set: {
        actions: { actionId: string; kind: string }[];
      }): Promise<ActionResult[]> =>
        set.actions.map((action) => ({
          actionId: action.actionId,
          status: "applied",
          code: "SUCCESS",
          amazonEntityId:
            action.kind === "create_keyword"
              ? `kw-new-${++keywordCount}`
              : action.kind === "create_target"
                ? `tg-new-${++targetCount}`
                : AMAZON_IDS_BY_KIND[action.kind],
        })),
    ),
  };
}

function creationInput(bookId: string): CampaignCreationCreate {
  return {
    profileIds: ["amz-profile-1"],
    campaign: {
      name: "Tractor Launch",
      dailyBudget: "5.00",
      targetingType: "MANUAL",
      startDate: "2026-09-01",
      state: "paused",
    },
    adGroup: { name: "Core", defaultBid: "0.40" },
    bookId,
    keywords: [
      { text: "tractor book", matchType: "EXACT", bid: "0.45" },
      { text: "farm colouring", matchType: "BROAD", bid: "0.30" },
    ],
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
  const book = db.seedBook({ asin: "B012345678", title: "Tractor Book" });
  db.seedBookProfileLink({
    book_id: book.id,
    profile_id: profile.id,
    marketplace_asin: "B012345678",
  });
  const gateway = gatewayBase();
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
  return { db, service, gateway, profile, book };
}

// -- draft creation ------------------------------------------------------------

describe("campaign creation change sets", () => {
  it("creates one change set per profile with the full spec and 3 + N actions", async () => {
    const { db, service, book } = setup();

    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      creationInput(book.id as string),
      META,
    );

    expect(result.changeSets).toHaveLength(1);
    expect(result.changeSets[0]).toMatchObject({
      profileId: "amz-profile-1",
      status: "draft",
      kind: "campaign_creation",
    });
    expect(db.tables.changeSets[0]!.metadata).toMatchObject({
      bookId: book.id,
      campaign: { name: "Tractor Launch", state: "paused" },
      adGroup: { name: "Core", defaultBid: "0.40" },
      asin: "B012345678",
      keywords: [
        { text: "tractor book", matchType: "EXACT", bid: "0.45" },
        { text: "farm colouring", matchType: "BROAD", bid: "0.30" },
      ],
    });
    expect(db.tables.changeActions).toHaveLength(5);
    expect(db.tables.changeActions.map((a) => a.action_type)).toEqual([
      "create_campaign",
      "create_ad_group",
      "create_product_ad",
      "create_keyword",
      "create_keyword",
    ]);
    for (const action of db.tables.changeActions) {
      expect(action.campaign_id).toBeNull();
      expect(action.ad_group_id).toBeNull();
      expect(action.target_id).toBeNull();
    }
    expect(db.tables.changeActions[0]).toMatchObject({
      entity_name: "Tractor Launch",
      after_state: { name: "Tractor Launch", dailyBudget: "5.00" },
    });
    expect(
      db.tables.auditEvents.some(
        (r) => r.event === "campaign.creation.change_set.create",
      ),
    ).toBe(true);
  });

  it("replays the same set when the identical spec is re-submitted", async () => {
    const { db, service, book } = setup();
    const input = creationInput(book.id as string);

    const first = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    const second = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );

    expect(second.changeSets[0]!.id).toBe(first.changeSets[0]!.id);
    expect(db.tables.changeSets).toHaveLength(1);
    expect(db.tables.changeActions).toHaveLength(5);
  });

  it("rejects when the book is not linked to a requested profile", async () => {
    const { db, service, book, profile } = setup();
    // Remove the only marketplace link.
    db.tables.bookProfileLinks.length = 0;

    await service
      .createCampaignCreationChangeSets(
        authFixture(),
        creationInput(book.id as string),
        META,
      )
      .catch((error) => expectApiError(error, "BOOK_PROFILE_NOT_LINKED"));
    expect(db.tables.changeSets).toHaveLength(0);

    // An unknown profile is rejected the same way as other write drafts.
    db.seedBookProfileLink({
      book_id: book.id,
      profile_id: profile.id,
      marketplace_asin: "B012345678",
    });
    await service
      .createCampaignCreationChangeSets(
        authFixture(),
        { ...creationInput(book.id as string), profileIds: ["amz-other"] },
        META,
      )
      .catch((error) => expectApiError(error, "NOT_FOUND"));
    expect(db.tables.changeSets).toHaveLength(0);
  });

  it("rejects an unknown book", async () => {
    const { service } = setup();
    await service
      .createCampaignCreationChangeSets(
        authFixture(),
        creationInput("book-missing"),
        META,
      )
      .catch((error) => expectApiError(error, "NOT_FOUND"));
  });

  it("creates a targets-only change set and replays it identically", async () => {
    const { db, service, book } = setup();
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }, { asin: "B0GHIJKL34" }],
    };

    const first = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    const second = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );

    expect(second.changeSets[0]!.id).toBe(first.changeSets[0]!.id);
    expect(db.tables.changeSets).toHaveLength(1);
    expect(db.tables.changeSets[0]!.metadata).toMatchObject({
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }, { asin: "B0GHIJKL34" }],
    });
    expect(db.tables.changeActions.map((a) => a.action_type)).toEqual([
      "create_campaign",
      "create_ad_group",
      "create_product_ad",
      "create_target",
      "create_target",
    ]);
    const targetActions = db.tables.changeActions.filter(
      (a) => a.action_type === "create_target",
    );
    expect(targetActions[0]).toMatchObject({
      search_term: "B0ABCDEF12",
      after_value: "0.50",
      entity_name: "B0ABCDEF12",
      after_state: {
        expressionAsin: "B0ABCDEF12",
        bid: "0.50",
        state: "paused",
      },
    });
    expect(targetActions[1]).toMatchObject({
      search_term: "B0GHIJKL34",
      after_value: null,
      entity_name: "B0GHIJKL34",
      after_state: { expressionAsin: "B0GHIJKL34", state: "paused" },
    });
    // A target without a bid inherits the ad group default — no bid is stored.
    expect(targetActions[1]!.after_state).not.toHaveProperty("bid");
  });

  it("creates an automatic campaign with no manual targeting actions", async () => {
    const { db, service, book } = setup();
    const base = creationInput(book.id as string);
    const input: CampaignCreationCreate = {
      ...base,
      campaign: { ...base.campaign, targetingType: "AUTO" },
      // Amazon rejects manual keywords/targets in auto campaigns and creates
      // its own default auto targets, so none are drafted.
      keywords: [],
    };

    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );

    expect(result.changeSets).toHaveLength(1);
    expect(db.tables.changeActions.map((a) => a.action_type)).toEqual([
      "create_campaign",
      "create_ad_group",
      "create_product_ad",
    ]);
    expect(db.tables.changeActions[0]!.after_state).toMatchObject({
      targetingType: "AUTO",
    });
  });
});

// -- guarded apply -------------------------------------------------------------

describe("campaign creation apply", () => {
  async function createDraft(
    setupResult: ReturnType<typeof setup>,
  ): Promise<string> {
    const { service, book } = setupResult;
    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      creationInput(book.id as string),
      META,
    );
    return result.changeSets[0]!.id;
  }

  it("applies the chain, records Amazon ids, and enqueues a structure sync", async () => {
    const setupResult = setup();
    const { db, service, gateway, profile } = setupResult;
    const changeSetId = await createDraft(setupResult);
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot()) // pre-check: nothing exists yet
      .mockResolvedValueOnce(createdSnapshot()); // post-write verification

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(applied.actions.map((a) => a.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
    expect(gateway.applyActions).toHaveBeenCalledTimes(1);
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    const campaignActionId = db.tables.changeActions.find(
      (a) => a.action_type === "create_campaign",
    )!.id;
    const adGroupActionId = db.tables.changeActions.find(
      (a) => a.action_type === "create_ad_group",
    )!.id;
    expect(sent.actions).toEqual([
      expect.objectContaining({
        kind: "create_campaign",
        actionId: campaignActionId,
        name: "Tractor Launch",
        dailyBudget: "5.00",
        targetingType: "MANUAL",
        startDate: "2026-09-01",
        state: "paused",
      }),
      expect.objectContaining({
        kind: "create_ad_group",
        campaignActionId,
        name: "Core",
        defaultBid: "0.40",
      }),
      expect.objectContaining({
        kind: "create_product_ad",
        adGroupActionId,
        asin: "B012345678",
      }),
      expect.objectContaining({
        kind: "create_keyword",
        adGroupActionId,
        keywordText: "tractor book",
        matchType: "EXACT",
        bid: "0.45",
      }),
      expect.objectContaining({
        kind: "create_keyword",
        adGroupActionId,
        keywordText: "farm colouring",
        matchType: "BROAD",
        bid: "0.30",
      }),
    ]);
    expect(db.tables.changeActions.map((a) => a.amazon_entity_id)).toEqual([
      "camp-new",
      "ag-new",
      "ad-new",
      "kw-new-1",
      "kw-new-2",
    ]);
    const syncJob = db.tables.jobQueue.find(
      (job) => job.type === "structure_sync",
    );
    expect(syncJob?.payload).toEqual({ profileId: profile.id });
  });

  it("applies an automatic campaign: only the three entity creates are sent", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const base = creationInput(book.id as string);
    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      {
        ...base,
        campaign: { ...base.campaign, targetingType: "AUTO" },
        keywords: [],
      },
      META,
    );
    const changeSetId = result.changeSets[0]!.id;
    const autoSnapshot = createdSnapshot({
      campaigns: [
        { ...createdSnapshot().campaigns[0]!, targetingType: "AUTO" },
      ],
      keywords: [],
    });
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot()) // pre-check: nothing exists yet
      .mockResolvedValueOnce(autoSnapshot); // post-write verification

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(applied.actions.map((a) => a.status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions.map((a) => a.kind)).toEqual([
      "create_campaign",
      "create_ad_group",
      "create_product_ad",
    ]);
    expect(sent.actions[0]).toEqual(
      expect.objectContaining({ targetingType: "AUTO" }),
    );
    expect(db.tables.changeActions.map((a) => a.amazon_entity_id)).toEqual([
      "camp-new",
      "ag-new",
      "ad-new",
    ]);
  });

  it("skips the write when a campaign with the same name already exists", async () => {
    const setupResult = setup();
    const { db, service, gateway } = setupResult;
    const changeSetId = await createDraft(setupResult);
    gateway.syncCampaignStructure.mockResolvedValue(createdSnapshot());

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(gateway.applyActions).not.toHaveBeenCalled();
    for (const action of db.tables.changeActions) {
      expect(action.status).toBe("applied");
      expect(action.amazon_response).toMatchObject({
        code: "ALREADY_PRESENT",
      });
    }
    expect(db.tables.changeActions.map((a) => a.amazon_entity_id)).toEqual([
      "camp-new",
      "ag-new",
      "ad-new",
      "kw-new-1",
      "kw-new-2",
    ]);
  });

  it("marks verification_failed when a created entity is missing afterwards", async () => {
    const setupResult = setup();
    const { service, gateway } = setupResult;
    const changeSetId = await createDraft(setupResult);
    // The write "succeeds" but the post-write read never shows the entities.
    gateway.syncCampaignStructure.mockResolvedValue(emptySnapshot());

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("failed");
    expect(applied.actions.map((a) => a.status)).toEqual([
      "verification_failed",
      "verification_failed",
      "verification_failed",
      "verification_failed",
      "verification_failed",
    ]);
  });

  it("propagates PARENT_FAILED for orphans of a failed parent", async () => {
    const setupResult = setup();
    const { db, service, gateway } = setupResult;
    const changeSetId = await createDraft(setupResult);
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      // Only the campaign made it; verification confirms it and nothing else.
      .mockResolvedValueOnce(
        createdSnapshot({ adGroups: [], ads: [], keywords: [] }),
      );
    gateway.applyActions.mockImplementation(
      async (set: { actions: { actionId: string; kind: string }[] }) =>
        set.actions.map((action) =>
          action.kind === "create_campaign"
            ? {
                actionId: action.actionId,
                status: "applied" as const,
                code: "SUCCESS",
                amazonEntityId: "camp-new",
              }
            : {
                actionId: action.actionId,
                status: "failed" as const,
                code: "PARENT_FAILED",
                message: "The parent action failed",
              },
        ),
    );

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("partially_applied");
    expect(applied.actions[0]).toMatchObject({
      actionType: "create_campaign",
      status: "applied",
    });
    for (const action of applied.actions.slice(1)) {
      expect(action.status).toBe("failed");
    }
    const orphan = db.tables.changeActions.find(
      (a) => a.action_type === "create_ad_group",
    )!;
    expect(orphan.amazon_response).toMatchObject({ code: "PARENT_FAILED" });
  });

  it("applies targets with ad-group parent resolution and verifies the created target", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
    };
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    const changeSetId = draft.changeSets[0]!.id;
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce(
        createdSnapshot({ targets: [targetRow("tg-new-1", "B0ABCDEF12")] }),
      );

    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(applied.actions.map((a) => a.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
    const adGroupActionId = db.tables.changeActions.find(
      (a) => a.action_type === "create_ad_group",
    )!.id;
    const targetAction = db.tables.changeActions.find(
      (a) => a.action_type === "create_target",
    )!;
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions).toContainEqual(
      expect.objectContaining({
        kind: "create_target",
        actionId: targetAction.id,
        adGroupActionId,
        expressionAsin: "B0ABCDEF12",
        bid: "0.50",
        state: "paused",
      }),
    );
    expect(targetAction.amazon_entity_id).toBe("tg-new-1");
  });

  it("treats an existing ASIN target in the same-name campaign as already satisfied", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
    };
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    // The campaign already exists with a matching ASIN target; the snapshot
    // reports the expression value in lowercase to prove the case-insensitive
    // match.
    gateway.syncCampaignStructure.mockResolvedValue(
      createdSnapshot({ targets: [targetRow("tg-existing", "b0abcdef12")] }),
    );

    const applied = await service.applyChangeSet(
      authFixture(),
      draft.changeSets[0]!.id,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(gateway.applyActions).not.toHaveBeenCalled();
    const targetAction = db.tables.changeActions.find(
      (a) => a.action_type === "create_target",
    )!;
    expect(targetAction.status).toBe("applied");
    expect(targetAction.amazon_response).toMatchObject({
      code: "ALREADY_PRESENT",
    });
    expect(targetAction.amazon_entity_id).toBe("tg-existing");
  });

  it("resumes a partially created chain: existing parents are skipped, the missing target is sent", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
    };
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    // A previous attempt created the campaign, ad group, and product ad on
    // Amazon but failed before the target: the pre-check snapshot shows all
    // three, and only the target may be (re)sent.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(createdSnapshot())
      .mockResolvedValueOnce(
        createdSnapshot({ targets: [targetRow("tg-new-1", "B0ABCDEF12")] }),
      );

    const applied = await service.applyChangeSet(
      authFixture(),
      draft.changeSets[0]!.id,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    const sent = gateway.applyActions.mock.calls[0]![0] as {
      actions: Array<Record<string, unknown>>;
    };
    const targetAction = db.tables.changeActions.find(
      (a) => a.action_type === "create_target",
    )!;
    expect(sent.actions).toEqual([
      expect.objectContaining({
        kind: "create_target",
        actionId: targetAction.id,
        resolvedCampaignId: "camp-new",
        resolvedAdGroupId: "ag-new",
        expressionAsin: "B0ABCDEF12",
      }),
    ]);
    for (const parent of db.tables.changeActions.filter(
      (a) => a.action_type !== "create_target",
    )) {
      expect(parent.status).toBe("applied");
      expect(parent.amazon_response).toMatchObject({ code: "ALREADY_PRESENT" });
    }
    expect(targetAction.status).toBe("applied");
    expect(targetAction.amazon_entity_id).toBe("tg-new-1");
  });

  it("marks create_target verification_failed when the target is missing afterwards", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
    };
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    // The write "succeeds" but the post-write read never shows the target.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce(createdSnapshot());

    const applied = await service.applyChangeSet(
      authFixture(),
      draft.changeSets[0]!.id,
      META,
    );

    expect(applied.changeSet.status).toBe("partially_applied");
    const targetAction = db.tables.changeActions.find(
      (a) => a.action_type === "create_target",
    )!;
    expect(targetAction.status).toBe("verification_failed");
  });

  it("propagates PARENT_FAILED to a target whose ad group failed", async () => {
    const setupResult = setup();
    const { db, service, gateway, book } = setupResult;
    const input: CampaignCreationCreate = {
      ...creationInput(book.id as string),
      keywords: [],
      targets: [{ asin: "B0ABCDEF12", bid: "0.50" }],
    };
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce(
        createdSnapshot({ adGroups: [], ads: [], keywords: [] }),
      );
    gateway.applyActions.mockImplementation(
      async (set: { actions: { actionId: string; kind: string }[] }) =>
        set.actions.map((action) =>
          action.kind === "create_campaign"
            ? {
                actionId: action.actionId,
                status: "applied" as const,
                code: "SUCCESS",
                amazonEntityId: "camp-new",
              }
            : {
                actionId: action.actionId,
                status: "failed" as const,
                code: "PARENT_FAILED",
                message: "The parent action failed",
              },
        ),
    );

    const applied = await service.applyChangeSet(
      authFixture(),
      draft.changeSets[0]!.id,
      META,
    );

    expect(applied.changeSet.status).toBe("partially_applied");
    const targetAction = db.tables.changeActions.find(
      (a) => a.action_type === "create_target",
    )!;
    expect(targetAction.status).toBe("failed");
    expect(targetAction.amazon_response).toMatchObject({
      code: "PARENT_FAILED",
    });
  });

  it("kill switch blocks apply before any Amazon call", async () => {
    const setupResult = setup({ killSwitch: true });
    const { db, service, gateway, profile } = setupResult;
    const set = db.seedChangeSet({
      profile_id: profile.id,
      status: "previewed",
      kind: "campaign_creation",
    });

    await service
      .applyChangeSet(authFixture(), set.id as string, META)
      .catch((error) => expectApiError(error, "WRITES_DISABLED"));
    expect(gateway.syncCampaignStructure).not.toHaveBeenCalled();
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });

  it("a read-only profile blocks apply before any Amazon call", async () => {
    const setupResult = setup({ writeEnabled: false });
    const { db, service, gateway, book, profile } = setupResult;
    // Create the draft while writes are enabled, then flip the profile.
    db.tables.amazonProfiles[0]!.write_enabled = true;
    const draft = await service.createCampaignCreationChangeSets(
      authFixture(),
      creationInput(book.id as string),
      META,
    );
    db.tables.amazonProfiles.find((p) => p.id === profile.id)!.write_enabled =
      false;

    await service
      .applyChangeSet(authFixture(), draft.changeSets[0]!.id, META)
      .catch((error) => expectApiError(error, "WRITES_DISABLED"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
  });

  it("creation actions are not rollbackable", async () => {
    const setupResult = setup();
    const { db, service, profile } = setupResult;
    const set = db.seedChangeSet({
      profile_id: profile.id,
      status: "applied",
      kind: "campaign_creation",
    });
    const action = db.seedChangeAction({
      change_set_id: set.id,
      action_type: "create_campaign",
      campaign_id: null,
      ad_group_id: null,
      target_id: null,
      before_value: null,
      after_value: "5.00",
      status: "applied",
      amazon_entity_id: "camp-new",
      entity_name: "Tractor Launch",
    });

    await service
      .rollbackAction(authFixture(), action.id as string, META)
      .catch((error) => expectApiError(error, "NOT_ROLLBACKABLE"));
  });

  it("is not blocked by cooldowns from recent bid changes recorded without an internal target", async () => {
    const setupResult = setup();
    const { db, service, gateway, profile } = setupResult;
    // A bid change applied inside the 7-day cooldown, recorded with only an
    // Amazon entity id (no internal target row) — the shape live bid applies
    // produce. Creation actions have no target id either and must not
    // cooldown-match against it (null never establishes a match).
    const recentSet = db.seedChangeSet({
      profile_id: profile.id,
      status: "applied",
      applied_at: new Date(),
    });
    db.seedChangeAction({
      change_set_id: recentSet.id,
      action_type: "update_bid",
      target_id: null,
      amazon_entity_id: "454063756440621",
      status: "applied",
    });
    const changeSetId = await createDraft(setupResult);

    const preview = await service.previewChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(preview.guardrails).toEqual([]);

    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot()) // pre-check: nothing exists yet
      .mockResolvedValueOnce(createdSnapshot()); // post-write verification
    const applied = await service.applyChangeSet(
      authFixture(),
      changeSetId,
      META,
    );
    expect(applied.changeSet.status).toBe("applied");
  });
});

// -- cannibalization-linked creation -------------------------------------------

describe("cannibalization-linked campaign creation", () => {
  const SEARCH_TERM = "tractor colouring book";
  const ASIN_TERM = "B0COMPBOOK";

  function setupLinked(searchTerm: string = SEARCH_TERM) {
    const base = setup();
    const { db, profile } = base;
    const campaignA = db.seedCampaign({
      id: "10",
      profile_id: profile.id,
      amazon_campaign_id: "camp-a",
      name: "Exact campaign",
      targeting_type: "manual",
    });
    const campaignB = db.seedCampaign({
      id: "11",
      profile_id: profile.id,
      amazon_campaign_id: "camp-b",
      name: "Discovery campaign",
      targeting_type: "auto",
    });
    const recommendation = db.seedRecommendation({
      profile_id: profile.id,
      type: "cannibalization_conflict",
      campaign_id: null,
      ad_group_id: null,
      target_id: null,
      search_term: searchTerm,
      current_value: null,
      proposed_value: null,
      evidence_window_end: new Date(),
      data_freshness_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
    });
    db.seedRecommendationEvidence(recommendation.id as string, {
      searchTerm,
      campaigns: [
        { campaignId: campaignA.id, orders: 3, costMicros: 13_000_000 },
        { campaignId: campaignB.id, orders: 1, costMicros: 8_980_000 },
      ],
    });
    return { ...base, campaignA, campaignB, recommendation };
  }

  function linkedInput(bookId: string, recommendationId: string) {
    return {
      ...creationInput(bookId),
      cannibalization: { recommendationId },
    };
  }

  function snapshotWithNegatives(campaignIds: string[]): StructureSnapshot {
    return {
      ...emptySnapshot(),
      negativeKeywords: campaignIds.map((campaignId, index) => ({
        negativeKeywordId: `neg-${index + 1}`,
        campaignId,
        adGroupId: null,
        keywordText: SEARCH_TERM,
        matchType: "NEGATIVE_EXACT",
        state: "ENABLED",
        raw: {},
      })),
    };
  }

  function snapshotWithNegativeTargets(
    campaignIds: string[],
    asin: string = ASIN_TERM,
  ): StructureSnapshot {
    return {
      ...emptySnapshot(),
      negativeTargets: campaignIds.map((campaignId, index) => ({
        negativeTargetId: `neg-t-${index + 1}`,
        campaignId,
        adGroupId: null,
        state: "ENABLED",
        expression: [{ type: "ASIN_SAME_AS", value: asin }],
        raw: {},
      })),
    };
  }

  it("drafts negatives for every conflicting campaign, locked behind the creation set", async () => {
    const { db, service, book, recommendation, campaignA, campaignB } =
      setupLinked();

    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      linkedInput(book.id as string, recommendation.id as string),
      META,
    );

    expect(result.changeSets).toHaveLength(2);
    const [creationSet, negativesSet] = result.changeSets;
    expect(creationSet).toMatchObject({ kind: "campaign_creation" });
    expect(negativesSet).toMatchObject({
      kind: "recommendation",
      status: "draft",
      dependsOnChangeSetId: creationSet!.id,
    });
    const negativesRow = db.tables.changeSets.find(
      (set) => set.id === negativesSet!.id,
    )!;
    expect(negativesRow.metadata).toMatchObject({
      strategy: "route_to_new_campaign",
      recommendationId: recommendation.id,
      searchTerm: SEARCH_TERM,
      dependsOnChangeSetId: creationSet!.id,
    });
    const negativeActions = db.tables.changeActions.filter(
      (action) => action.action_type === "add_negative_exact",
    );
    expect(negativeActions).toHaveLength(2);
    expect(negativeActions.map((action) => action.campaign_id).sort()).toEqual(
      [campaignA.id, campaignB.id].sort(),
    );
    for (const action of negativeActions) {
      expect(action.search_term).toBe(SEARCH_TERM);
      expect(action.before_state).toMatchObject({ present: false });
      expect(action.after_state).toMatchObject({ present: true });
    }
    expect(db.tables.recommendations[0]!.state).toBe("approved");
  });

  it("rejects when the wizard does not cover the conflict's profile, creating nothing", async () => {
    const { db, service, book, recommendation } = setupLinked();

    await service
      .createCampaignCreationChangeSets(
        authFixture(),
        {
          ...linkedInput(book.id as string, recommendation.id as string),
          profileIds: ["amz-other"],
        },
        META,
      )
      .catch((error) => expectApiError(error, "BAD_REQUEST"));
    expect(db.tables.changeSets).toHaveLength(0);
  });

  it("rejects an expired finding before creating anything", async () => {
    const { db, service, book, recommendation } = setupLinked();
    db.tables.recommendations[0]!.expires_at = new Date(
      Date.now() - 86_400_000,
    );

    await service
      .createCampaignCreationChangeSets(
        authFixture(),
        linkedInput(book.id as string, recommendation.id as string),
        META,
      )
      .catch((error) => expectApiError(error, "RECOMMENDATION_EXPIRED"));
    expect(db.tables.changeSets).toHaveLength(0);
  });

  it("replays both sets when the identical linked spec is re-submitted", async () => {
    const { db, service, book, recommendation } = setupLinked();
    const input = linkedInput(book.id as string, recommendation.id as string);

    const first = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );
    const second = await service.createCampaignCreationChangeSets(
      authFixture(),
      input,
      META,
    );

    expect(second.changeSets.map((set) => set.id)).toEqual(
      first.changeSets.map((set) => set.id),
    );
    expect(db.tables.changeSets).toHaveLength(2);
  });

  it("blocks the negatives apply until the creation set is applied", async () => {
    const { db, service, gateway, book, recommendation } = setupLinked();
    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      linkedInput(book.id as string, recommendation.id as string),
      META,
    );
    const [creationSet, negativesSet] = result.changeSets;

    // Locked while the new campaign does not exist on Amazon yet.
    await service
      .applyChangeSet(authFixture(), negativesSet!.id, META)
      .catch((error) => expectApiError(error, "DEPENDENCY_NOT_APPLIED"));
    expect(gateway.applyActions).not.toHaveBeenCalled();
    expect(
      db.tables.changeSets.find((set) => set.id === negativesSet!.id)!.status,
    ).toBe("draft");

    // Apply the creation set first.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce(createdSnapshot());
    const creationApplied = await service.applyChangeSet(
      authFixture(),
      creationSet!.id,
      META,
    );
    expect(creationApplied.changeSet.status).toBe("applied");

    // Now the negatives apply through the normal guarded pipeline.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot()) // before-state: no negatives yet
      .mockResolvedValueOnce(snapshotWithNegatives(["camp-a", "camp-b"]));
    gateway.applyActions.mockImplementationOnce(
      async (set: {
        actions: { actionId: string }[];
      }): Promise<ActionResult[]> =>
        set.actions.map((action, index) => ({
          actionId: action.actionId,
          status: "applied",
          code: "SUCCESS",
          amazonEntityId: `neg-${index + 1}`,
        })),
    );
    const negativesApplied = await service.applyChangeSet(
      authFixture(),
      negativesSet!.id,
      META,
    );

    expect(negativesApplied.changeSet.status).toBe("applied");
    expect(negativesApplied.actions.map((action) => action.status)).toEqual([
      "applied",
      "applied",
    ]);
  });

  it("drafts negative ASIN targets for an ASIN term, locked behind the creation set", async () => {
    const { db, service, book, recommendation, campaignA, campaignB } =
      setupLinked(ASIN_TERM);

    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      linkedInput(book.id as string, recommendation.id as string),
      META,
    );

    expect(result.changeSets).toHaveLength(2);
    const [creationSet, negativesSet] = result.changeSets;
    expect(negativesSet).toMatchObject({
      kind: "recommendation",
      status: "draft",
      dependsOnChangeSetId: creationSet!.id,
    });
    const negativeActions = db.tables.changeActions.filter(
      (action) => action.action_type === "add_negative_target",
    );
    expect(negativeActions).toHaveLength(2);
    expect(negativeActions.map((action) => action.campaign_id).sort()).toEqual(
      [campaignA.id, campaignB.id].sort(),
    );
    for (const action of negativeActions) {
      expect(action.search_term).toBe(ASIN_TERM);
      expect(action.before_state).toEqual({
        scope: "campaign",
        targetType: "ASIN_SAME_AS",
        present: false,
      });
      expect(action.after_state).toEqual({
        scope: "campaign",
        targetType: "ASIN_SAME_AS",
        present: true,
      });
    }
    expect(db.tables.recommendations[0]!.state).toBe("approved");
  });

  it("applies negative ASIN targets with before-state compare and id back-fill", async () => {
    const { db, service, gateway, book, recommendation } =
      setupLinked(ASIN_TERM);
    const result = await service.createCampaignCreationChangeSets(
      authFixture(),
      linkedInput(book.id as string, recommendation.id as string),
      META,
    );
    const [creationSet, negativesSet] = result.changeSets;

    // Locked while the new campaign does not exist on Amazon yet.
    await service
      .applyChangeSet(authFixture(), negativesSet!.id, META)
      .catch((error) => expectApiError(error, "DEPENDENCY_NOT_APPLIED"));
    expect(gateway.applyActions).not.toHaveBeenCalled();

    // Apply the creation set first.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce(createdSnapshot());
    const creationApplied = await service.applyChangeSet(
      authFixture(),
      creationSet!.id,
      META,
    );
    expect(creationApplied.changeSet.status).toBe("applied");

    // Now the negative targets apply through the normal guarded pipeline.
    gateway.syncCampaignStructure
      .mockResolvedValueOnce(emptySnapshot()) // before-state: no negatives yet
      .mockResolvedValueOnce(snapshotWithNegativeTargets(["camp-a", "camp-b"]));
    gateway.applyActions.mockImplementationOnce(
      async (set: {
        actions: { actionId: string }[];
      }): Promise<ActionResult[]> =>
        set.actions.map((action, index) => ({
          actionId: action.actionId,
          status: "applied",
          code: "SUCCESS",
          amazonEntityId: `neg-t-${index + 1}`,
        })),
    );
    const negativesApplied = await service.applyChangeSet(
      authFixture(),
      negativesSet!.id,
      META,
    );

    expect(negativesApplied.changeSet.status).toBe("applied");
    expect(negativesApplied.actions.map((action) => action.status)).toEqual([
      "applied",
      "applied",
    ]);
    const sent = gateway.applyActions.mock.calls.at(-1)![0] as {
      actions: Array<Record<string, unknown>>;
    };
    expect(sent.actions).toEqual([
      expect.objectContaining({
        kind: "add_negative_target",
        campaignId: "camp-a",
        expressionAsin: ASIN_TERM,
      }),
      expect.objectContaining({
        kind: "add_negative_target",
        campaignId: "camp-b",
        expressionAsin: ASIN_TERM,
      }),
    ]);
    const negativeActions = db.tables.changeActions.filter(
      (action) => action.action_type === "add_negative_target",
    );
    expect(
      negativeActions.map((action) => action.amazon_entity_id).sort(),
    ).toEqual(["neg-t-1", "neg-t-2"]);
  });

  it("skips sending a negative ASIN target that already exists", async () => {
    const { db, service, gateway, recommendation } = setupLinked(ASIN_TERM);
    // Route to the existing camp-a: the negative target only goes to camp-b.
    const result = await service.createCannibalizationChangeSet(
      authFixture(),
      recommendation.id as string,
      "camp-a",
      META,
    );
    expect(result.changeSet.status).toBe("draft");
    const negativeAction = db.tables.changeActions.find(
      (action) => action.action_type === "add_negative_target",
    )!;
    expect(negativeAction.search_term).toBe(ASIN_TERM);

    gateway.syncCampaignStructure.mockResolvedValue(
      snapshotWithNegativeTargets(["camp-b"]),
    );
    const applied = await service.applyChangeSet(
      authFixture(),
      result.changeSet.id,
      META,
    );

    expect(applied.changeSet.status).toBe("applied");
    expect(gateway.applyActions).not.toHaveBeenCalled();
    expect(negativeAction.status).toBe("applied");
    expect(negativeAction.amazon_response).toMatchObject({
      code: "ALREADY_PRESENT",
    });
    // The negative predates this set, so no rollback id is recorded.
    expect(negativeAction.amazon_entity_id).toBeNull();
  });

  it("negative ASIN targets are not rollbackable", async () => {
    const { db, service, profile } = setupLinked(ASIN_TERM);
    const set = db.seedChangeSet({
      profile_id: profile.id,
      status: "applied",
      kind: "recommendation",
    });
    const action = db.seedChangeAction({
      change_set_id: set.id,
      action_type: "add_negative_target",
      campaign_id: null,
      ad_group_id: null,
      target_id: null,
      search_term: ASIN_TERM,
      before_value: null,
      after_value: null,
      status: "applied",
      amazon_entity_id: "neg-t-1",
    });

    await service
      .rollbackAction(authFixture(), action.id as string, META)
      .catch((error) => expectApiError(error, "NOT_ROLLBACKABLE"));
  });
});
