import { z } from "zod";
import { AmazonAuthError } from "@amazon-king/amazon-ads";
import type { JobHandler } from "../loop.js";
import type { JobDeps } from "./types.js";

/**
 * connection_health (plan §8): a cheap authorized call per connected
 * connection. Unrecoverable auth errors mark the connection
 * reconnect_required (the TokenManager circuit breaker does this too);
 * transient errors are recorded on the connection without failing the job.
 * The schema has no last-health timestamp column, so success only clears the
 * recorded error.
 */
const payloadSchema = z.looseObject({
  connectionId: z.string().regex(/^\d+$/).optional(),
});

export function createConnectionHealthHandler(deps: JobDeps): JobHandler {
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
      try {
        await deps.gateway.listProfiles(connection.id);
        await deps.store.setConnectionError(connection.id, null);
        logger.info({ connectionId: connection.id }, "Connection healthy");
      } catch (error) {
        if (error instanceof AmazonAuthError && error.unrecoverable) {
          await deps.store.markConnectionReconnectRequired(
            connection.id,
            error.code,
          );
          logger.warn(
            { connectionId: connection.id, code: error.code },
            "Connection requires reconnect",
          );
          continue;
        }
        const code =
          error instanceof AmazonAuthError ? error.code : (error as Error).name;
        await deps.store.setConnectionError(connection.id, code);
        logger.warn(
          { connectionId: connection.id, err: error },
          "Connection health check failed (transient)",
        );
      }
    }
  };
}
