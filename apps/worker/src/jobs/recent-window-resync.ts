import { z } from "zod";
import { addDays, formatIsoDate } from "@amazon-king/optimizer";
import type { IsoDate } from "@amazon-king/contracts";
import type { JobHandler } from "../loop.js";
import { profilePkSchema, type JobDeps } from "./types.js";

/**
 * recent_window_resync (plan §8): re-import the most recent N days daily so
 * late-attributed conversions correct recent fact rows. Implemented by
 * enqueueing a metrics_sync for the trailing window, deduped against an
 * already queued/running identical job.
 */
const payloadSchema = z.looseObject({
  profileId: profilePkSchema,
});

export function createRecentWindowResyncHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const { profileId } = payloadSchema.parse(payload);
    const today = formatIsoDate(deps.now().getTime());
    const endDate = addDays(today as IsoDate, -1);
    const startDate = addDays(endDate, -(deps.config.recentWindowDays - 1));
    const enqueued = await deps.store.enqueueIfNotQueued("metrics_sync", {
      profileId,
      startDate,
      endDate,
    });
    logger.info(
      { profileId, startDate, endDate, enqueued: enqueued !== null },
      "Recent-window resync scheduled",
    );
  };
}
