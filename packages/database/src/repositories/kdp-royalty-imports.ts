import type { Db } from "../db.js";

/**
 * KDP royalty import batches (migration 0019). Each row is one uploaded
 * Royalties Estimator workbook with its derived suggestions; the payload hash
 * makes re-uploading the same file an idempotent replay. The normalized
 * report rows are stored too (migration 0022) so the KDP history tables can
 * be rebuilt from the database alone — batches predating that column carry
 * an empty array and become rebuildable only by re-uploading the file.
 */

export interface KdpRoyaltyImport {
  id: string;
  workspaceId: string;
  fileName: string;
  payloadSha256: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  suggestions: unknown[];
  skipped: unknown[];
  createdAt: string;
  appliedAt: string | null;
}

interface KdpRoyaltyImportRow {
  id: string;
  workspace_id: string;
  file_name: string;
  payload_sha256: string;
  period_start: string;
  period_end: string;
  row_count: number;
  suggestions: unknown[];
  skipped: unknown[];
  created_at: string;
  applied_at: string | null;
}

function toImport(row: KdpRoyaltyImportRow): KdpRoyaltyImport {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fileName: row.file_name,
    payloadSha256: row.payload_sha256,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowCount: row.row_count,
    suggestions: row.suggestions,
    skipped: row.skipped,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

export interface KdpRoyaltyImportInput {
  workspaceId: string;
  fileName: string;
  payloadSha256: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  suggestions: unknown[];
  skipped: unknown[];
  /** Normalized report rows (KdpRoyaltyRow[]), stored for history rebuilds. */
  rows: unknown[];
}

/**
 * Insert a batch, or return the existing one when the same payload hash was
 * imported before (`created: false` — the caller reports it as a replay).
 */
export async function insertKdpRoyaltyImport(
  db: Db,
  input: KdpRoyaltyImportInput,
): Promise<{ import: KdpRoyaltyImport; created: boolean }> {
  const inserted = await db.query<KdpRoyaltyImportRow>(
    `insert into kdp_royalty_imports
       (workspace_id, file_name, payload_sha256, period_start, period_end,
        row_count, suggestions, skipped, rows)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     on conflict (workspace_id, payload_sha256) do nothing
     returning *`,
    [
      input.workspaceId,
      input.fileName,
      input.payloadSha256,
      input.periodStart,
      input.periodEnd,
      input.rowCount,
      JSON.stringify(input.suggestions),
      JSON.stringify(input.skipped),
      JSON.stringify(input.rows),
    ],
  );
  if (inserted.rows[0]) {
    return { import: toImport(inserted.rows[0]), created: true };
  }
  const existing = await db.query<KdpRoyaltyImportRow>(
    `select * from kdp_royalty_imports
     where workspace_id = $1 and payload_sha256 = $2`,
    [input.workspaceId, input.payloadSha256],
  );
  return { import: toImport(existing.rows[0]!), created: false };
}

/** Fetch one batch, scoped to the workspace so foreign ids are invisible. */
export async function getKdpRoyaltyImport(
  db: Db,
  workspaceId: string,
  importId: string,
): Promise<KdpRoyaltyImport | null> {
  const result = await db.query<KdpRoyaltyImportRow>(
    `select * from kdp_royalty_imports
     where workspace_id = $1 and id = $2`,
    [workspaceId, importId],
  );
  return result.rows[0] ? toImport(result.rows[0]) : null;
}

/** Recent batches, newest first. */
export async function listKdpRoyaltyImports(
  db: Db,
  workspaceId: string,
  limit = 25,
): Promise<KdpRoyaltyImport[]> {
  const result = await db.query<KdpRoyaltyImportRow>(
    `select * from kdp_royalty_imports
     where workspace_id = $1
     order by created_at desc, id desc
     limit $2`,
    [workspaceId, limit],
  );
  return result.rows.map(toImport);
}

export interface KdpRoyaltyImportPayload {
  id: string;
  fileName: string;
  /** Normalized report rows; empty for batches imported before migration 0022. */
  rows: unknown[];
  createdAt: string;
}

/**
 * Every batch's stored report rows, oldest first — the input of
 * scripts/rebuild-kdp-history.ts. Not part of the API surface; the rows can
 * be large (up to 20k per batch) and never leave the backend.
 */
export async function listKdpRoyaltyImportPayloads(
  db: Db,
  workspaceId: string,
): Promise<KdpRoyaltyImportPayload[]> {
  const result = await db.query<{
    id: string;
    file_name: string;
    rows: unknown[];
    created_at: string;
  }>(
    `select id, file_name, rows, created_at
     from kdp_royalty_imports
     where workspace_id = $1
     order by created_at asc, id asc`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    rows: row.rows,
    createdAt: row.created_at,
  }));
}

/**
 * Stamp a batch applied. Returns null when it does not exist in the
 * workspace or was already applied — apply is a one-way, one-time transition.
 */
export async function markKdpRoyaltyImportApplied(
  db: Db,
  workspaceId: string,
  importId: string,
): Promise<KdpRoyaltyImport | null> {
  const result = await db.query<KdpRoyaltyImportRow>(
    `update kdp_royalty_imports set applied_at = now()
     where workspace_id = $1 and id = $2 and applied_at is null
     returning *`,
    [workspaceId, importId],
  );
  return result.rows[0] ? toImport(result.rows[0]) : null;
}
