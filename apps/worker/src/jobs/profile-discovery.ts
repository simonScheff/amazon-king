import { z } from "zod";
import { AmazonAuthError } from "@amazon-king/amazon-ads";
import { TerminalJobError, type JobHandler } from "../loop.js";
import type { JobDeps } from "./types.js";

/**
 * profile_discovery (plan §5 step 5): list authorized profiles across all
 * regional hosts for each connected Amazon connection and mirror them into
 * amazon_profiles. New profiles stay disabled until the owner enables them.
 */
const payloadSchema = z.looseObject({
  connectionId: z.string().regex(/^\d+$/).optional(),
});

export function createProfileDiscoveryHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const parsed = payloadSchema.parse(payload ?? {});
    const requested = parsed.connectionId
      ? await deps.store.getConnection(parsed.connectionId)
      : null;
    const connections = parsed.connectionId
      ? requested !== null && requested.status === "connected"
        ? [requested]
        : []
      : await deps.store.listActiveConnections();

    for (const connection of connections) {
      let profiles;
      try {
        profiles = await deps.gateway.listProfiles(connection.id);
      } catch (error) {
        if (error instanceof AmazonAuthError && error.unrecoverable) {
          // The TokenManager circuit breaker marks the connection too; belt and braces.
          await deps.store.markConnectionReconnectRequired(
            connection.id,
            error.code,
          );
          throw new TerminalJobError(error.message);
        }
        throw error;
      }
      for (const profile of profiles) {
        await deps.store.insertDiscoveredProfile({
          connectionId: connection.id,
          profileId: profile.profileId,
          accountId: profile.accountId,
          region: profile.region,
          countryCode: profile.countryCode,
          currencyCode: profile.currencyCode,
          timezone: profile.timezone,
          accountType: profile.accountType,
        });
      }
      await deps.store.setConnectionError(connection.id, null);
      logger.info(
        { connectionId: connection.id, profiles: profiles.length },
        "Profile discovery completed",
      );
    }
  };
}
