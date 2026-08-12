import type { Db } from "../db.js";

/** Audit events (plan §7/§13): safe, non-secret details only. */

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  event: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  sessionId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface AuditEventRow {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  event: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  session_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    event: row.event,
    entityType: row.entity_type,
    entityId: row.entity_id,
    ip: row.ip,
    sessionId: row.session_id,
    details: row.details,
    createdAt: row.created_at,
  };
}

export async function insertAuditEvent(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId?: string | null;
    event: string;
    entityType: string;
    entityId?: string | null;
    ip?: string | null;
    sessionId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<AuditEvent> {
  const result = await db.query<AuditEventRow>(
    `insert into audit_events
       (workspace_id, actor_user_id, event, entity_type, entity_id, ip, session_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning *`,
    [
      input.workspaceId,
      input.actorUserId ?? null,
      input.event,
      input.entityType,
      input.entityId ?? null,
      input.ip ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
  return toAuditEvent(result.rows[0]!);
}

/** List audit events for a workspace, newest first. */
export async function listAuditEvents(
  db: Db,
  workspaceId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<AuditEvent[]> {
  const result = await db.query<AuditEventRow>(
    `select * from audit_events
     where workspace_id = $1
     order by created_at desc, id desc
     limit coalesce($2, 100) offset coalesce($3, 0)`,
    [workspaceId, options.limit ?? null, options.offset ?? null],
  );
  return result.rows.map(toAuditEvent);
}
