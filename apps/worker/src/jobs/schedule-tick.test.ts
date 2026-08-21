import { describe, expect, it } from "vitest";
import { createScheduleTickHandler } from "./schedule-tick.js";
import { FakeStore, makeDeps, runHandler } from "../test-utils.js";
import type { ProfileRecord } from "../store.js";

const ENABLED_PROFILE: ProfileRecord = {
  id: "7",
  amazonProfileId: "amz-profile-7",
  connectionId: "3",
  workspaceId: "1",
  region: "NA",
  currencyCode: "USD",
  enabled: true,
};

// 12:00 UTC — after the 05:00 UTC daily-settle cutoff.
const NOW = new Date("2026-08-06T12:00:00.000Z");

function tickDeps(store: FakeStore, now: Date = NOW) {
  return makeDeps({ store, now: () => now });
}

describe("schedule_tick", () => {
  it("enqueues due recurring work and reschedules itself", async () => {
    const store = new FakeStore();
    store.profiles.push(ENABLED_PROFILE);
    await runHandler(createScheduleTickHandler(tickDeps(store)), {});

    const types = store.jobs.map((job) => job.type).sort();
    expect(types).toEqual(
      [
        "profile_discovery",
        "connection_health",
        "structure_sync",
        "metrics_sync",
        "recent_window_resync",
        "schedule_tick",
      ].sort(),
    );
    // Daily metrics sync imports yesterday.
    const metricsJob = store.jobs.find((job) => job.type === "metrics_sync")!;
    expect(metricsJob.payload).toEqual({
      profileId: "7",
      startDate: "2026-08-05",
      endDate: "2026-08-05",
    });
    // The next tick is scheduled one interval out and carries the marks.
    const nextTick = store.jobs.find((job) => job.type === "schedule_tick")!;
    expect(nextTick.runAt!.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
    const marks = (nextTick.payload as { lastEnqueued: Record<string, string> })
      .lastEnqueued;
    expect(marks["profile_discovery"]).toBeDefined();
    expect(marks["metrics_sync:7"]).toBeDefined();
  });

  it("does not double-enqueue when ticked again immediately", async () => {
    const store = new FakeStore();
    store.profiles.push(ENABLED_PROFILE);
    const handler = createScheduleTickHandler(tickDeps(store));
    await runHandler(handler, {});
    const countAfterFirst = store.jobs.length;

    // Simulate the next tick firing early with the carried-forward marks.
    const nextTick = store.jobs.find((job) => job.type === "schedule_tick")!;
    await runHandler(handler, nextTick.payload);

    // Nothing new: every recurring job is still pending (dedupe backstop) and
    // the cadence marks say nothing is due; no second tick is created either.
    expect(store.jobs.length).toBe(countAfterFirst);
  });

  it("waits for the daily-settle hour before enqueueing daily metrics", async () => {
    const store = new FakeStore();
    store.profiles.push(ENABLED_PROFILE);
    await runHandler(
      createScheduleTickHandler(
        tickDeps(store, new Date("2026-08-06T02:00:00.000Z")),
      ),
      {},
    );
    expect(store.jobs.some((job) => job.type === "metrics_sync")).toBe(false);
    expect(store.jobs.some((job) => job.type === "recent_window_resync")).toBe(
      false,
    );
    // Non-daily work is still enqueued.
    expect(store.jobs.some((job) => job.type === "structure_sync")).toBe(true);
  });

  it("enqueues fx_sync only after 17:00 UTC (ECB fixing published)", async () => {
    const before = new FakeStore();
    await runHandler(
      createScheduleTickHandler(
        tickDeps(before, new Date("2026-08-06T16:30:00.000Z")),
      ),
      {},
    );
    expect(before.jobs.some((job) => job.type === "fx_sync")).toBe(false);

    const after = new FakeStore();
    await runHandler(
      createScheduleTickHandler(
        tickDeps(after, new Date("2026-08-06T18:00:00.000Z")),
      ),
      {},
    );
    const fxJob = after.jobs.find((job) => job.type === "fx_sync");
    expect(fxJob).toBeDefined();
    expect(fxJob!.payload).toEqual({});
    const nextTick = after.jobs.find((job) => job.type === "schedule_tick")!;
    const marks = (nextTick.payload as { lastEnqueued: Record<string, string> })
      .lastEnqueued;
    expect(marks["fx_sync"]).toBeDefined();
  });

  it("does not re-enqueue fx_sync when ticked again the same day", async () => {
    const store = new FakeStore();
    const now = new Date("2026-08-06T18:00:00.000Z");
    const handler = createScheduleTickHandler(tickDeps(store, now));
    await runHandler(handler, {});
    expect(store.jobs.filter((job) => job.type === "fx_sync")).toHaveLength(1);

    const nextTick = store.jobs.find((job) => job.type === "schedule_tick")!;
    await runHandler(handler, nextTick.payload);
    expect(store.jobs.filter((job) => job.type === "fx_sync")).toHaveLength(1);
  });

  it("skips disabled profiles", async () => {
    const store = new FakeStore();
    store.profiles.push({ ...ENABLED_PROFILE, enabled: false });
    await runHandler(createScheduleTickHandler(tickDeps(store)), {});
    expect(store.jobs.some((job) => job.type === "structure_sync")).toBe(false);
    expect(store.jobs.some((job) => job.type === "metrics_sync")).toBe(false);
    expect(store.jobs.some((job) => job.type === "profile_discovery")).toBe(
      true,
    );
  });
});
