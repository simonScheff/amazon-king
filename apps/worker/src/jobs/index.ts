import type { JobHandler } from "../loop.js";
import type { JobDeps } from "./types.js";
import { createProfileDiscoveryHandler } from "./profile-discovery.js";
import { createStructureSyncHandler } from "./structure-sync.js";
import { createMetricsSyncHandler } from "./metrics-sync.js";
import { createRecentWindowResyncHandler } from "./recent-window-resync.js";
import { createRecommendationRunHandler } from "./recommendation-run.js";
import { createConnectionHealthHandler } from "./connection-health.js";
import { createFxSyncHandler } from "./fx-sync.js";
import { createScheduleTickHandler } from "./schedule-tick.js";

/** All job types the worker claims (plan §8 cadence). */
export const JOB_TYPES = [
  "profile_discovery",
  "structure_sync",
  "metrics_sync",
  "recent_window_resync",
  "recommendation_run",
  "connection_health",
  "fx_sync",
  "schedule_tick",
] as const;

export function createJobHandlers(deps: JobDeps): Record<string, JobHandler> {
  return {
    profile_discovery: createProfileDiscoveryHandler(deps),
    structure_sync: createStructureSyncHandler(deps),
    metrics_sync: createMetricsSyncHandler(deps),
    recent_window_resync: createRecentWindowResyncHandler(deps),
    recommendation_run: createRecommendationRunHandler(deps),
    connection_health: createConnectionHealthHandler(deps),
    fx_sync: createFxSyncHandler(deps),
    schedule_tick: createScheduleTickHandler(deps),
  };
}
