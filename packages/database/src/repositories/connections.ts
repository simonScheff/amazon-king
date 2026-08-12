import type { Db } from "../db.js";

/**
 * Amazon LWA connections (plan §5 Login B). The refresh token is only ever
 * stored as envelope-encrypted ciphertext (bytea) plus a key version; the
 * plaintext never touches the database or logs.
 */

export type ConnectionStatus =
  "connected" | "reconnect_required" | "disconnected";

export interface AmazonConnection {
  id: string;
  workspaceId: string;
  encryptedRefreshToken: Buffer;
  encryptionKeyVersion: number;
  status: ConnectionStatus;
  grantedAt: string | null;
  revokedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  encrypted_refresh_token: Buffer;
  encryption_key_version: number;
  status: ConnectionStatus;
  granted_at: string | null;
  revoked_at: string | null;
  last_error_code: string | null;
  created_at: string;
}

function toConnection(row: ConnectionRow): AmazonConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    encryptedRefreshToken: row.encrypted_refresh_token,
    encryptionKeyVersion: row.encryption_key_version,
    status: row.status,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  };
}

/** Insert a new connection after a successful OAuth code exchange. */
export async function createConnection(
  db: Db,
  input: {
    workspaceId: string;
    encryptedRefreshToken: Buffer;
    encryptionKeyVersion: number;
  },
): Promise<AmazonConnection> {
  const result = await db.query<ConnectionRow>(
    `insert into amazon_connections
       (workspace_id, encrypted_refresh_token, encryption_key_version, status, granted_at)
     values ($1, $2, $3, 'connected', now())
     returning *`,
    [
      input.workspaceId,
      input.encryptedRefreshToken,
      input.encryptionKeyVersion,
    ],
  );
  return toConnection(result.rows[0]!);
}

export async function getConnection(
  db: Db,
  connectionId: string,
): Promise<AmazonConnection | null> {
  const result = await db.query<ConnectionRow>(
    `select * from amazon_connections where id = $1`,
    [connectionId],
  );
  return result.rows[0] ? toConnection(result.rows[0]) : null;
}

/**
 * The workspace's current (non-disconnected) connection, if any. The product
 * is single-owner with one Amazon account, so at most one live connection is
 * expected; the newest wins if several rows exist.
 */
export async function findLiveConnectionByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<AmazonConnection | null> {
  const result = await db.query<ConnectionRow>(
    `select * from amazon_connections
     where workspace_id = $1 and status <> 'disconnected'
     order by id desc
     limit 1`,
    [workspaceId],
  );
  return result.rows[0] ? toConnection(result.rows[0]) : null;
}

/** The most recent connection of any status (for the status endpoint). */
export async function findLatestConnectionByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<AmazonConnection | null> {
  const result = await db.query<ConnectionRow>(
    `select * from amazon_connections
     where workspace_id = $1
     order by id desc
     limit 1`,
    [workspaceId],
  );
  return result.rows[0] ? toConnection(result.rows[0]) : null;
}

/** Update the stored ciphertext after a token refresh (key rotation safe). */
export async function updateConnectionSecret(
  db: Db,
  connectionId: string,
  input: { encryptedRefreshToken: Buffer; encryptionKeyVersion: number },
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update amazon_connections
     set encrypted_refresh_token = $2, encryption_key_version = $3
     where id = $1
     returning id`,
    [connectionId, input.encryptedRefreshToken, input.encryptionKeyVersion],
  );
  return result.rowCount === 1;
}

/** Mark the connection status (e.g. reconnect_required after invalid_grant). */
export async function updateConnectionStatus(
  db: Db,
  connectionId: string,
  status: ConnectionStatus,
  lastErrorCode?: string | null,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update amazon_connections
     set status = $2,
         last_error_code = coalesce($3, last_error_code)
     where id = $1
     returning id`,
    [connectionId, status, lastErrorCode ?? null],
  );
  return result.rowCount === 1;
}

/**
 * Disconnect: wipe the ciphertext (empty bytea keeps the NOT NULL constraint;
 * it can never decrypt) and mark revoked. No usable token material remains.
 */
export async function disconnectConnection(
  db: Db,
  connectionId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update amazon_connections
     set status = 'disconnected',
         revoked_at = now(),
         encrypted_refresh_token = '\\x'::bytea
     where id = $1 and status <> 'disconnected'
     returning id`,
    [connectionId],
  );
  return result.rowCount === 1;
}
