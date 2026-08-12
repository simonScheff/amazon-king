import { z } from "zod";
import { addDays, formatIsoDate } from "@amazon-king/optimizer";
import type { IsoDate } from "@amazon-king/contracts";
import type { JobHandler } from "../loop.js";
import type { JobDeps } from "./types.js";

/**
 * schedule_tick — the self-rescheduling heartbeat that enqueues due recurring
 * work (plan §8 cadence). It re-enqueues itself every `scheduleTickMs` and
 * tracks last-enqueued times in its own payload so they survive restarts;
 * `enqueueIfNotQueued` is the backstop against duplicates.
 *
 * Cadence (plan §8 schedule table):
 * - profile_discovery: daily
 * - structure_sync per enabled profile: every 45 min (30–60 min band)
 * - metrics_sync per enabled profile: once daily after data settles (05:00 UTC)
 * - recent_window_resync per enabled profile: once daily (attribution lag)
 * - connection_health: every 4 hours
 * - recommendation_run: chained by metrics_sync on success, not scheduled here
 */
const PROFILE_DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STRUCTURE_SYNC_INTERVAL_MS = 45 * 60 * 1000;
const CONNECTION_HEALTH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Daily jobs wait until Amazon data is reasonably settled (UTC hour). */
const DAILY_AFTER_UTC_HOUR = 5;

const payloadSchema = z.looseObject({
  lastEnqueued: z.record(z.string(), z.string()).optional(),
});

export function createScheduleTickHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const parsed = payloadSchema.parse(payload ?? {});
    const now = deps.now();
    const nowMs = now.getTime();
    const last = parsed.lastEnqueued ?? {};
    const next: Record<string, string> = { ...last };

    const dueAfter = (key: string, intervalMs: number): boolean => {
      const stamp = next[key];
      return stamp === undefined || nowMs - Date.parse(stamp) >= intervalMs;
    };
    const dueDaily = (key: string): boolean => {
      if (now.getUTCHours() < DAILY_AFTER_UTC_HOUR) {
        return false;
      }
      const stamp = next[key];
      return stamp === undefined || stamp.slice(0, 10) < formatIsoDate(nowMs);
    };
    const mark = (key: string): void => {
      next[key] = now.toISOString();
    };

    if (dueAfter("profile_discovery", PROFILE_DISCOVERY_INTERVAL_MS)) {
      await deps.store.enqueueIfNotQueued("profile_discovery", {});
      mark("profile_discovery");
    }
    if (dueAfter("connection_health", CONNECTION_HEALTH_INTERVAL_MS)) {
      await deps.store.enqueueIfNotQueued("connection_health", {});
      mark("connection_health");
    }

    const profiles = await deps.store.listEnabledProfiles();
    const today = formatIsoDate(nowMs);
    const yesterday = addDays(today as IsoDate, -1);
    for (const profile of profiles) {
      const structureKey = `structure_sync:${profile.id}`;
      if (dueAfter(structureKey, STRUCTURE_SYNC_INTERVAL_MS)) {
        await deps.store.enqueueIfNotQueued("structure_sync", {
          profileId: profile.id,
        });
        mark(structureKey);
      }
      const metricsKey = `metrics_sync:${profile.id}`;
      if (dueDaily(metricsKey)) {
        await deps.store.enqueueIfNotQueued("metrics_sync", {
          profileId: profile.id,
          startDate: yesterday,
          endDate: yesterday,
        });
        mark(metricsKey);
      }
      const resyncKey = `recent_window_resync:${profile.id}`;
      if (dueDaily(resyncKey)) {
        await deps.store.enqueueIfNotQueued("recent_window_resync", {
          profileId: profile.id,
        });
        mark(resyncKey);
      }
    }

    // Self-reschedule; guarded so a retried tick never creates a duplicate.
    if (!(await deps.store.hasPendingJob("schedule_tick"))) {
      await deps.store.enqueue(
        "schedule_tick",
        { lastEnqueued: next },
        new Date(nowMs + deps.config.scheduleTickMs),
      );
    }
    logger.info({ profiles: profiles.length }, "Schedule tick processed");
  };
}
