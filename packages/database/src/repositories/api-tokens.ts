import type { Db } from "../db.js";

/**
 * Machine tokens for the MCP HTTP transport (docs/mcp-server-plan.md D3).
 * Only SHA-256 hashes are stored — the plaintext token is shown once at
 * issuance and never persisted or logged.
 */

export interface ApiToken {
  id: string;
  workspaceId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiTokenRow {
  id: string;
  workspace_id: string;
  label: string;
  scopes: string[];
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    scopes: row.scopes,
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
  };
}

export async function createApiToken(
  db: Db,
  input: {
    workspaceId: string;
    label: string;
    tokenHash: string;
    scopes?: string[];
  },
): Promise<ApiToken> {
  const scopes = input.scopes ?? ["mcp:read"];
  const result = await db.query<ApiTokenRow>(
    `insert into api_tokens (workspace_id, label, token_hash, scopes)
     values ($1, $2, $3, $4) returning *`,
    [input.workspaceId, input.label, input.tokenHash, scopes],
  );
  return toApiToken(result.rows[0]!);
}

/**
 * Resolve a presented token hash to its live token row. Lookup is by the
 * full unique SHA-256 hash, so no partial-secret timing oracle exists.
 */
export async function findActiveApiTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<ApiToken | null> {
  const result = await db.query<ApiTokenRow>(
    `select * from api_tokens
     where token_hash = $1 and revoked_at is null`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? toApiToken(row) : null;
}

/** Best-effort usage stamp; intentionally not awaited on the hot path. */
export async function touchApiToken(db: Db, id: string): Promise<void> {
  await db.query(`update api_tokens set last_used_at = now() where id = $1`, [
    id,
  ]);
}

export async function listApiTokens(
  db: Db,
  workspaceId: string,
): Promise<ApiToken[]> {
  const result = await db.query<ApiTokenRow>(
    `select * from api_tokens
     where workspace_id = $1 order by created_at desc`,
    [workspaceId],
  );
  return result.rows.map(toApiToken);
}

/** Revoke a workspace-owned token; returns false when unknown or foreign. */
export async function revokeApiToken(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update api_tokens set revoked_at = now()
     where id = $1 and workspace_id = $2 and revoked_at is null
     returning id`,
    [id, workspaceId],
  );
  return result.rowCount === 1;
}
