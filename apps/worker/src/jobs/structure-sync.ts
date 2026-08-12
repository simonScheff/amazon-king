import { z } from "zod";
import { AmazonAuthError } from "@amazon-king/amazon-ads";
import { TerminalJobError, type JobHandler } from "../loop.js";
import { profilePkSchema, type JobDeps } from "./types.js";

/**
 * structure_sync (plan §8): pull the profile's Sponsored Products structure
 * snapshot and upsert it idempotently. The structure repository records
 * name/bid/budget/state changes into entity_change_history automatically.
 */
const payloadSchema = z.looseObject({
  profileId: profilePkSchema,
});

export function createStructureSyncHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const { profileId } = payloadSchema.parse(payload);
    const profile = await deps.store.getProfile(profileId);
    if (!profile) {
      throw new TerminalJobError(`Unknown profile ${profileId}`);
    }
    if (!profile.enabled) {
      logger.info({ profileId }, "Profile disabled; skipping structure sync");
      return;
    }

    const syncRunId = await deps.store.createSyncRun(profileId, "structure");
    try {
      let snapshot;
      try {
        snapshot = await deps.gateway.syncCampaignStructure(profile.id);
      } catch (error) {
        if (error instanceof AmazonAuthError && error.unrecoverable) {
          await deps.store.markConnectionReconnectRequired(
            profile.connectionId,
            error.code,
          );
          throw new TerminalJobError(error.message);
        }
        throw error;
      }
      await deps.store.applyStructureSnapshot(profile, snapshot);
      await deps.store.finishSyncRun(syncRunId, "complete");
      logger.info(
        {
          profileId,
          campaigns: snapshot.campaigns.length,
          adGroups: snapshot.adGroups.length,
          ads: snapshot.ads.length,
          keywords: snapshot.keywords.length,
          targets: snapshot.targets.length,
        },
        "Structure sync completed",
      );
    } catch (error) {
      await deps.store.finishSyncRun(
        syncRunId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  };
}
