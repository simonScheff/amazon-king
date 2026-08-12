import type { Logger } from "pino";
import type { Job } from "@amazon-king/database";
import {
  claim,
  complete,
  fail,
  heartbeat,
  reapExpiredLeases,
} from "@amazon-king/database";
import type { Pool } from "@amazon-king/database";

/**
 * Poll-claim-execute worker loop (plan §8). Single-owner deployment: one job
 * at a time, claimed with FOR UPDATE SKIP LOCKED, protected by a lease that
 * is heartbeated during execution so a dead worker's jobs are reaped and
 * retried by the next run.
 */

/** Thrown by handlers for failures that retrying cannot fix (validation,
 * reconciliation, dead OAuth grants): the job is dead-lettered immediately. */
export class TerminalJobError extends Error {
  override readonly name = "TerminalJobError";
}

export interface JobContext {
  job: Job;
  logger: Logger;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

export interface WorkerLoopOptions {
  pool: Pool;
  workerId: string;
  handlers: Readonly<Record<string, JobHandler>>;
  leaseSeconds: number;
  heartbeatMs: number;
  pollIntervalMs: number;
  reapIntervalMs: number;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the loop until `shouldStop()` returns true. A job already in flight is
 * finished (or failed back to pending) before the loop exits, so graceful
 * shutdown never strands a claimed job.
 */
export async function runWorkerLoop(
  options: WorkerLoopOptions,
  shouldStop: () => boolean,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const types = Object.keys(options.handlers);
  let lastReapAt = 0;

  while (!shouldStop()) {
    if (now() - lastReapAt >= options.reapIntervalMs) {
      lastReapAt = now();
      try {
        const reaped = await reapExpiredLeases(options.pool);
        if (reaped.length > 0) {
          options.logger.warn({ reaped }, "Reaped expired job leases");
        }
      } catch (error) {
        options.logger.error({ err: error }, "Lease reaping failed");
      }
    }

    let job: Job | null;
    try {
      job = await claim(
        options.pool,
        options.workerId,
        types,
        options.leaseSeconds,
      );
    } catch (error) {
      options.logger.error({ err: error }, "Job claim failed");
      await sleep(options.pollIntervalMs);
      continue;
    }
    if (!job) {
      await sleep(options.pollIntervalMs);
      continue;
    }

    await executeJob(job, options);
  }
}

async function executeJob(job: Job, options: WorkerLoopOptions): Promise<void> {
  const logger = options.logger.child({ jobId: job.id, jobType: job.type });
  const handler = options.handlers[job.type];
  logger.info({ attempt: job.attempts }, "Job claimed");

  const heartbeatTimer = setInterval(() => {
    heartbeat(
      options.pool,
      job.id,
      options.workerId,
      options.leaseSeconds,
    ).then(
      (ok) => {
        if (!ok) {
          logger.warn(
            "Heartbeat lost the lease; another worker may have reaped this job",
          );
        }
      },
      (error) => logger.error({ err: error }, "Heartbeat failed"),
    );
  }, options.heartbeatMs);
  heartbeatTimer.unref();

  try {
    if (!handler) {
      await fail(
        options.pool,
        job.id,
        options.workerId,
        `no handler registered for ${job.type}`,
        {
          terminal: true,
        },
      );
      return;
    }
    await handler(job.payload, { job, logger });
    const done = await complete(options.pool, job.id, options.workerId);
    if (!done) {
      logger.warn(
        "Job completion lost the lease; result was already settled elsewhere",
      );
      return;
    }
    logger.info("Job completed");
  } catch (error) {
    const terminal = error instanceof TerminalJobError;
    const message = error instanceof Error ? error.message : String(error);
    const status = await fail(options.pool, job.id, options.workerId, message, {
      terminal,
    });
    logger[status === "dead" ? "error" : "warn"](
      { err: error, status },
      terminal ? "Job failed terminally" : "Job failed; scheduled for retry",
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
}
