import { computeBackoffMsWithJitter } from "./backoff.js";
import { withTransaction } from "./pool.js";
import type { Db, Pool } from "./db.js";

/**
 * PostgreSQL-backed job queue (plan §7/§8): durable work claimed with
 * FOR UPDATE SKIP LOCKED, protected by leases and heartbeats so dead
 * workers do not strand jobs.
 */

export type JobStatus = "pending" | "running" | "done" | "failed" | "dead";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  runAt: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: string;
}

interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  run_at: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/** Enqueue a job; runAt defaults to now. Returns the new job id. */
export async function enqueue(
  db: Db,
  type: string,
  payload: unknown = {},
  runAt?: Date,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into job_queue (type, payload, run_at)
     values ($1, $2::jsonb, coalesce($3::timestamptz, now()))
     returning id`,
    [type, JSON.stringify(payload), runAt ?? null],
  );
  return result.rows[0]!.id;
}

/**
 * Claim at most one runnable job of the given types for workerId.
 * Uses FOR UPDATE SKIP LOCKED so concurrent claimers never get the same job;
 * the lease expires after leaseSeconds unless completed or heartbeated.
 * Returns null when no job is available.
 */
export async function claim(
  pool: Pool,
  workerId: string,
  types: readonly string[],
  leaseSeconds: number,
): Promise<Job | null> {
  return withTransaction(pool, async (client) => {
    const selected = await client.query<{ id: string }>(
      `select id from job_queue
       where status = 'pending'
         and run_at <= now()
         and type = any($1::text[])
       order by run_at
       limit 1
       for update skip locked`,
      [types],
    );
    const row = selected.rows[0];
    if (!row) {
      return null;
    }
    const updated = await client.query<JobRow>(
      `update job_queue
       set status = 'running',
           locked_by = $2,
           attempts = attempts + 1,
           heartbeat_at = now(),
           lease_expires_at = now() + make_interval(secs => $3)
       where id = $1
       returning *`,
      [row.id, workerId, leaseSeconds],
    );
    return toJob(updated.rows[0]!);
  });
}

/**
 * Prove the worker is still alive and extend the lease. Returns false when
 * the job is no longer running under this worker (e.g. lease was reaped).
 */
export async function heartbeat(
  db: Db,
  jobId: string,
  workerId: string,
  leaseSeconds?: number,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update job_queue
     set heartbeat_at = now(),
         lease_expires_at = case
           when $3::int is null then lease_expires_at
           else now() + make_interval(secs => $3)
         end
     where id = $1 and status = 'running' and locked_by = $2
     returning id`,
    [jobId, workerId, leaseSeconds ?? null],
  );
  return result.rowCount === 1;
}

/** Mark a claimed job as successfully finished. */
export async function complete(
  db: Db,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update job_queue
     set status = 'done', locked_by = null, lease_expires_at = null
     where id = $1 and status = 'running' and locked_by = $2
     returning id`,
    [jobId, workerId],
  );
  return result.rowCount === 1;
}

export interface FailOptions {
  /** Skip the retry schedule and mark the job dead immediately. */
  terminal?: boolean;
}

/**
 * Mark a claimed job as failed. When attempts remain, the job goes back to
 * 'pending' with an exponential-backoff run_at (full jitter, plan §8);
 * otherwise it is moved to 'dead'.
 */
export async function fail(
  db: Db,
  jobId: string,
  workerId: string,
  error: string,
  options: FailOptions = {},
): Promise<JobStatus | null> {
  const current = await db.query<{ attempts: number; max_attempts: number }>(
    `select attempts, max_attempts from job_queue
     where id = $1 and status = 'running' and locked_by = $2`,
    [jobId, workerId],
  );
  const row = current.rows[0];
  if (!row) {
    return null;
  }
  const exhausted =
    options.terminal === true || row.attempts >= row.max_attempts;
  if (exhausted) {
    const result = await db.query<{ status: JobStatus }>(
      `update job_queue
       set status = 'dead', last_error = $3, locked_by = null, lease_expires_at = null
       where id = $1 and status = 'running' and locked_by = $2
       returning status`,
      [jobId, workerId, error],
    );
    return result.rows[0]?.status ?? null;
  }
  const backoffMs = computeBackoffMsWithJitter(row.attempts);
  const result = await db.query<{ status: JobStatus }>(
    `update job_queue
     set status = 'pending',
         last_error = $3,
         locked_by = null,
         lease_expires_at = null,
         run_at = now() + make_interval(secs => $4 / 1000.0)
     where id = $1 and status = 'running' and locked_by = $2
     returning status`,
    [jobId, workerId, error, backoffMs],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Return jobs whose lease expired while 'running' to 'pending' so another
 * worker can claim them. Returns the reaped job ids.
 */
export async function reapExpiredLeases(db: Db): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `update job_queue
     set status = 'pending', locked_by = null, lease_expires_at = null
     where status = 'running' and lease_expires_at < now()
     returning id`,
  );
  return result.rows.map((row) => row.id);
}

/**
 * Fail still-pending jobs addressed to the given internal profile ids
 * (payload->>'profileId'). Used when an Amazon connection is disconnected so
 * queued syncs for its profiles do not run against a dead grant (plan §5
 * "Disconnecting Amazon"). Returns the number cancelled.
 */
export async function failPendingJobsForProfiles(
  db: Db,
  profilePks: readonly string[],
  reason: string,
): Promise<number> {
  if (profilePks.length === 0) {
    return 0;
  }
  const result = await db.query<{ id: string }>(
    `update job_queue
     set status = 'failed', last_error = $2
     where status = 'pending'
       and payload->>'profileId' = any($1::text[])
     returning id`,
    [profilePks.map(String), reason],
  );
  return result.rowCount ?? 0;
}
