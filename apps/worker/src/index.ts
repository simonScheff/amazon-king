import { hostname } from "node:os";
import { createAmazonAdsGateway } from "@amazon-king/amazon-ads";
import { createPool } from "@amazon-king/database";
import { createLogger } from "@amazon-king/observability";
import { loadConfig } from "./config.js";
import { createLocalReportStorage } from "./storage.js";
import { createDbStore } from "./store.js";
import { createWorkerTokenManager } from "./tokens.js";
import { createJobHandlers } from "./jobs/index.js";
import { runWorkerLoop } from "./loop.js";

/**
 * Worker entry point (plan §8). The worker is read-only against Amazon in the
 * MVP: it imports structure/metrics and generates recommendations. The
 * KILL_SWITCH flag is loaded now so the future apply worker can honor it
 * (plan §10); no write jobs are registered yet.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger("worker", { level: config.logLevel });
  if (!config.lwaClientId || !config.lwaClientSecret) {
    logger.warn(
      "LWA_CLIENT_ID/LWA_CLIENT_SECRET not set; Amazon API calls will fail",
    );
  }
  if (config.killSwitch) {
    logger.info(
      "KILL_SWITCH is on; no Amazon write jobs are registered in the MVP worker",
    );
  }

  const pool = createPool(config.databaseUrl);
  const store = createDbStore(pool);
  const tokenManager = createWorkerTokenManager(store, config, logger);
  const gateway = createAmazonAdsGateway({
    clientId: config.lwaClientId ?? "unconfigured",
    tokenManager,
    profileDirectory: {
      get: (profilePk) => store.getGatewayProfile(profilePk),
    },
    // Restart-safe report polling: reportId -> owning profile from report_jobs.
    reportOwner: (reportId) => store.findProfilePkForReport(reportId),
    logger,
  });
  const storage = createLocalReportStorage(config.reportStorageDir);
  const handlers = createJobHandlers({
    store,
    gateway,
    storage,
    config,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  // Bootstrap the self-rescheduling scheduler if none is queued (e.g. first
  // boot or after every tick died with the worker).
  if (!(await store.hasPendingJob("schedule_tick"))) {
    await store.enqueue("schedule_tick", {});
    logger.info("Bootstrapped schedule_tick");
  }

  const workerId = `${hostname()}:${process.pid}`;
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal }, "Shutdown requested; finishing current job");
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logger.info({ workerId }, "Worker starting");
  try {
    await runWorkerLoop(
      {
        pool,
        workerId,
        handlers,
        leaseSeconds: config.leaseSeconds,
        heartbeatMs: config.heartbeatMs,
        pollIntervalMs: config.pollIntervalMs,
        reapIntervalMs: config.reapIntervalMs,
        logger,
      },
      () => stopping,
    );
  } finally {
    await pool.end();
    logger.info("Worker stopped");
  }
}

main().catch((error) => {
  createLogger("worker").fatal({ err: error }, "Worker crashed");
  process.exit(1);
});
