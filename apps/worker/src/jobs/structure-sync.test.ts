import { describe, expect, it } from "vitest";
import { createStructureSyncHandler } from "./structure-sync.js";
import { FakeStore, fakeGateway, makeDeps, runHandler } from "../test-utils.js";
import type { ProfileRecord } from "../store.js";

const PROFILE: ProfileRecord = {
  id: "7",
  amazonProfileId: "amz-profile-7",
  connectionId: "3",
  workspaceId: "1",
  region: "NA",
  currencyCode: "USD",
  enabled: true,
};

const EMPTY_SNAPSHOT = {
  profileId: "amz-profile-7",
  retrievedAt: "2026-08-06T12:00:00.000Z",
  campaigns: [],
  adGroups: [],
  ads: [],
  keywords: [],
  targets: [],
  negativeKeywords: [],
  negativeTargets: [],
};

function setup(profile: ProfileRecord = PROFILE) {
  const store = new FakeStore();
  store.profiles.push(profile);
  const deps = makeDeps({
    store,
    gateway: fakeGateway({
      syncCampaignStructure: async () => EMPTY_SNAPSHOT,
    }),
  });
  return { store, handler: createStructureSyncHandler(deps) };
}

describe("structure_sync", () => {
  it("adopts the sync run id from a manual sync payload", async () => {
    const { store, handler } = setup();
    // The API created this row up front and returned it to the browser.
    store.syncRuns.push({
      id: "42",
      profileId: "7",
      kind: "structure",
      status: "running",
      finishedAt: null,
      error: null,
    });

    await runHandler(handler, { profileId: "7", syncRunId: "42" });

    // No second run row; the API-created one is the one that completed.
    expect(store.syncRuns).toHaveLength(1);
    expect(store.syncRuns[0]).toMatchObject({ id: "42", status: "complete" });
  });

  it("creates its own run for scheduled syncs (no syncRunId in payload)", async () => {
    const { store, handler } = setup();

    await runHandler(handler, { profileId: "7" });

    expect(store.syncRuns).toHaveLength(1);
    expect(store.syncRuns[0]).toMatchObject({
      kind: "structure",
      status: "complete",
    });
  });

  it("closes an adopted run when the profile is disabled before the job runs", async () => {
    const { store, handler } = setup({ ...PROFILE, enabled: false });
    store.syncRuns.push({
      id: "42",
      profileId: "7",
      kind: "structure",
      status: "running",
      finishedAt: null,
      error: null,
    });

    await runHandler(handler, { profileId: "7", syncRunId: "42" });

    expect(store.syncRuns[0]!.status).toBe("failed");
  });
});
