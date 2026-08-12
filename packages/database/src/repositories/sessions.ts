import type { Db } from "../db.js";

/**
 * Sessions, passwordless login tokens, and OAuth states (plan §5).
 * All lookups are by token/state hash — raw tokens never touch the database.
 */

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  ip: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

export async function createSession(
  db: Db,
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<Session> {
  const result = await db.query<SessionRow>(
    `insert into sessions (user_id, token_hash, expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      input.userId,
      input.tokenHash,
      input.expiresAt,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  return toSession(result.rows[0]!);
}

/** Find a live session by token hash (not revoked, not expired). */
export async function findValidSession(
  db: Db,
  tokenHash: string,
): Promise<Session | null> {
  const result = await db.query<SessionRow>(
    `select * from sessions
     where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ? toSession(result.rows[0]) : null;
}

/** Revoke a session by token hash. Returns true when a live session was revoked. */
export async function revokeSession(
  db: Db,
  tokenHash: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update sessions set revoked_at = now()
     where token_hash = $1 and revoked_at is null
     returning id`,
    [tokenHash],
  );
  return result.rowCount === 1;
}

/**
 * Rolling expiry: extend a live session's expiry (plan §5). Returns the new
 * expiry, or null when the session is no longer valid.
 */
export async function extendSession(
  db: Db,
  tokenHash: string,
  expiresAt: Date,
): Promise<string | null> {
  const result = await db.query<{ expires_at: string }>(
    `update sessions set expires_at = $2
     where token_hash = $1 and revoked_at is null and expires_at > now()
     returning expires_at`,
    [tokenHash, expiresAt],
  );
  return result.rows[0]?.expires_at ?? null;
}

/** Create a passwordless email login token. Returns the row id. */
export async function createLoginToken(
  db: Db,
  input: { email: string; tokenHash: string; expiresAt: Date },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into login_tokens (email, token_hash, expires_at)
     values ($1, $2, $3)
     returning id`,
    [input.email, input.tokenHash, input.expiresAt],
  );
  return result.rows[0]!.id;
}

/**
 * Single-use consume: marks the token used atomically and returns the email
 * only when the token was unused and unexpired; null otherwise.
 */
export async function consumeLoginToken(
  db: Db,
  tokenHash: string,
): Promise<string | null> {
  const result = await db.query<{ email: string }>(
    `update login_tokens set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()
     returning email`,
    [tokenHash],
  );
  return result.rows[0]?.email ?? null;
}

/** Create a one-time OAuth state tied to the authenticated user. */
export async function createOAuthState(
  db: Db,
  input: {
    stateHash: string;
    userId: string;
    returnTo?: string | null;
    expiresAt: Date;
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into oauth_states (state_hash, user_id, return_to, expires_at)
     values ($1, $2, $3, $4)
     returning id`,
    [input.stateHash, input.userId, input.returnTo ?? null, input.expiresAt],
  );
  return result.rows[0]!.id;
}

export interface ConsumedOAuthState {
  userId: string;
  returnTo: string | null;
}

/**
 * Single-use consume: marks the state used atomically and returns it only
 * when unused and unexpired; null otherwise (bad/expired/replayed state).
 */
export async function consumeOAuthState(
  db: Db,
  stateHash: string,
): Promise<ConsumedOAuthState | null> {
  const result = await db.query<{ user_id: string; return_to: string | null }>(
    `update oauth_states set used_at = now()
     where state_hash = $1 and used_at is null and expires_at > now()
     returning user_id, return_to`,
    [stateHash],
  );
  const row = result.rows[0];
  return row ? { userId: row.user_id, returnTo: row.return_to } : null;
}
