import type { SyncRunKind } from "@amazon-king/contracts";
import type { Db } from "../db.js";

/** sync_runs and report_jobs lifecycle (plan §8 report state machine). */

export type SyncRunStatus = "running" | "complete" | "failed";

export interface SyncRun {
  id: string;
  profileId: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface SyncRunRow {
  id: string;
  profile_id: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

function toSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

/** Fetch a sync run by id (null when unknown). */
export async function getSyncRun(
  db: Db,
  syncRunId: string,
): Promise<SyncRun | null> {
  const result = await db.query<SyncRunRow>(
    `select * from sync_runs where id = $1`,
    [syncRunId],
  );
  return result.rows[0] ? toSyncRun(result.rows[0]) : null;
}

export async function createSyncRun(
  db: Db,
  profileId: string,
  kind: SyncRunKind,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into sync_runs (profile_id, kind) values ($1, $2) returning id`,
    [profileId, kind],
  );
  return result.rows[0]!.id;
}

/** Finish a sync run; only call after reconciliation checks pass (§8 step 12). */
export async function finishSyncRun(
  db: Db,
  syncRunId: string,
  status: Exclude<SyncRunStatus, "running">,
  error?: string | null,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update sync_runs set status = $2, finished_at = now(), error = $3
     where id = $1 and status = 'running'
     returning id`,
    [syncRunId, status, error ?? null],
  );
  return result.rowCount === 1;
}

export type ReportJobStatus =
  | "queued"
  | "requested"
  | "polling"
  | "downloading"
  | "validating"
  | "importing"
  | "complete"
  | "retryable"
  | "failed"
  | "dead_letter";

export interface ReportJob {
  id: string;
  syncRunId: string;
  profileId: string;
  reportType: string;
  specFingerprint: string;
  amazonReportId: string | null;
  status: ReportJobStatus;
  attempts: number;
  checksum: string | null;
  storageKey: string | null;
  error: string | null;
  dateStart: string;
  dateEnd: string;
  createdAt: string;
  updatedAt: string;
}

interface ReportJobRow {
  id: string;
  sync_run_id: string;
  profile_id: string;
  report_type: string;
  spec_fingerprint: string;
  amazon_report_id: string | null;
  status: ReportJobStatus;
  attempts: number;
  checksum: string | null;
  storage_key: string | null;
  error: string | null;
  date_start: string;
  date_end: string;
  created_at: string;
  updated_at: string;
}

function toReportJob(row: ReportJobRow): ReportJob {
  return {
    id: row.id,
    syncRunId: row.sync_run_id,
    profileId: row.profile_id,
    reportType: row.report_type,
    specFingerprint: row.spec_fingerprint,
    amazonReportId: row.amazon_report_id,
    status: row.status,
    attempts: row.attempts,
    checksum: row.checksum,
    storageKey: row.storage_key,
    error: row.error,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Find a report job by its deterministic spec fingerprint (§8 step 2). */
export async function findReportJobByFingerprint(
  db: Db,
  specFingerprint: string,
): Promise<ReportJob | null> {
  const result = await db.query<ReportJobRow>(
    `select * from report_jobs where spec_fingerprint = $1`,
    [specFingerprint],
  );
  return result.rows[0] ? toReportJob(result.rows[0]) : null;
}

export async function createReportJob(
  db: Db,
  input: {
    syncRunId: string;
    profileId: string;
    reportType: string;
    specFingerprint: string;
    dateStart: string;
    dateEnd: string;
  },
): Promise<ReportJob> {
  const result = await db.query<ReportJobRow>(
    `insert into report_jobs
       (sync_run_id, profile_id, report_type, spec_fingerprint, date_start, date_end)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      input.syncRunId,
      input.profileId,
      input.reportType,
      input.specFingerprint,
      input.dateStart,
      input.dateEnd,
    ],
  );
  return toReportJob(result.rows[0]!);
}

export interface ReportJobUpdate {
  status: ReportJobStatus;
  amazonReportId?: string | null;
  checksum?: string | null;
  storageKey?: string | null;
  error?: string | null;
  /** Increment the attempts counter (retries, §8 backoff). */
  incrementAttempts?: boolean;
}

/** Advance a report job through the state machine. */
export async function updateReportJob(
  db: Db,
  reportJobId: string,
  update: ReportJobUpdate,
): Promise<ReportJob | null> {
  const result = await db.query<ReportJobRow>(
    `update report_jobs set
       status = $2,
       amazon_report_id = coalesce($3, amazon_report_id),
       checksum = coalesce($4, checksum),
       storage_key = coalesce($5, storage_key),
       error = case when $6::text is null then error else $6 end,
       attempts = attempts + case when $7 then 1 else 0 end,
       updated_at = now()
     where id = $1
     returning *`,
    [
      reportJobId,
      update.status,
      update.amazonReportId ?? null,
      update.checksum ?? null,
      update.storageKey ?? null,
      update.error ?? null,
      update.incrementAttempts === true,
    ],
  );
  return result.rows[0] ? toReportJob(result.rows[0]) : null;
}

/** List report jobs of a sync run that are not complete (reconciliation). */
export async function listIncompleteReportJobs(
  db: Db,
  syncRunId: string,
): Promise<ReportJob[]> {
  const result = await db.query<ReportJobRow>(
    `select * from report_jobs
     where sync_run_id = $1 and status <> 'complete'
     order by id`,
    [syncRunId],
  );
  return result.rows.map(toReportJob);
}
