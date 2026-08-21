import type { Db } from "../db.js";

/**
 * Users, workspaces, and owner membership (plan §5 Login A provisioning).
 * Single-owner product: the first login auto-provisions user + workspace +
 * owner membership; later logins reuse them.
 */

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<User | null> {
  const result = await db.query<UserRow>(
    `select * from users where email = $1`,
    [email],
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export interface OwnerContext {
  user: User;
  workspaceId: string;
}

/**
 * Find the user and their owned workspace, creating user, workspace, and
 * owner membership on first login. Inserts are conflict-safe so concurrent
 * first logins converge.
 */
export async function findOrProvisionOwner(
  db: Db,
  email: string,
): Promise<OwnerContext> {
  const existing = await db.query<UserRow & { workspace_id: string | null }>(
    `select u.*, m.workspace_id
     from users u
     left join workspace_members m on m.user_id = u.id and m.role = 'owner'
     where u.email = $1`,
    [email],
  );
  const existingRow = existing.rows[0];
  if (existingRow && existingRow.workspace_id !== null) {
    return {
      user: toUser(existingRow),
      workspaceId: existingRow.workspace_id,
    };
  }

  const userResult = await db.query<UserRow>(
    `insert into users (email) values ($1)
     on conflict (email) do update set email = excluded.email
     returning *`,
    [email],
  );
  const user = toUser(userResult.rows[0]!);
  if (existingRow && existingRow.workspace_id === null) {
    // User exists but has no membership yet (partial earlier provisioning).
    const membership = await findMembership(db, user.id);
    if (membership) {
      return { user, workspaceId: membership.workspaceId };
    }
  }

  const workspaceResult = await db.query<{ id: string }>(
    `insert into workspaces (name) values ($1) returning id`,
    [`${email}'s workspace`],
  );
  const workspaceId = workspaceResult.rows[0]!.id;
  await db.query(
    `insert into workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner')
     on conflict do nothing`,
    [workspaceId, user.id],
  );
  return { user, workspaceId };
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: string;
}

/** Find the owner's membership for a user (null when none). */
export async function findMembership(
  db: Db,
  userId: string,
): Promise<Membership | null> {
  const result = await db.query<{
    workspace_id: string;
    user_id: string;
    role: string;
  }>(`select * from workspace_members where user_id = $1 and role = 'owner'`, [
    userId,
  ]);
  const row = result.rows[0];
  return row
    ? { workspaceId: row.workspace_id, userId: row.user_id, role: row.role }
    : null;
}

/**
 * Currency of the workspace's all-market dashboard view
 * (docs/fx-rates-all-market-plan.md, decision 5). Null only when the
 * workspace row itself is missing; the column defaults to 'USD'.
 */
export async function getWorkspaceDisplayCurrency(
  db: Db,
  workspaceId: string,
): Promise<string | null> {
  const result = await db.query<{ display_currency: string }>(
    `select display_currency from workspaces where id = $1`,
    [workspaceId],
  );
  return result.rows[0]?.display_currency ?? null;
}

/**
 * Update the workspace's display currency. A display setting only — stored
 * facts keep their native currency and are never rewritten. Returns false
 * when the workspace does not exist.
 */
export async function setWorkspaceDisplayCurrency(
  db: Db,
  workspaceId: string,
  displayCurrency: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update workspaces set display_currency = $2 where id = $1 returning id`,
    [workspaceId, displayCurrency],
  );
  return result.rowCount === 1;
}
