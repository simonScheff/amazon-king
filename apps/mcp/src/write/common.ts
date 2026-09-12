import {
  audit,
  buildChangeActionFingerprint,
  buildChangeSetFingerprint,
  changes,
  type Db,
  type Pool,
} from "@amazon-king/database";
import { ChangeSetKind } from "./enums.js";
import type { ResolvedCampaign } from "./types.js";

/** Finds the workspace owner. Throws if no owner membership exists (fail-closed). */
export async function getOwnerUserId(
  db: Db,
  workspaceId: string,
): Promise<string> {
  const res = await db.query<{ user_id: string }>(
    `select user_id from workspace_members where workspace_id = $1 and role = 'owner' limit 1`,
    [workspaceId],
  );
  if (!res.rows[0]) {
    throw new Error(`Workspace '${workspaceId}' has no owner`);
  }
  return res.rows[0].user_id;
}

/** Resolves a campaign by internal or Amazon ID within the workspace. */
export async function resolveCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<ResolvedCampaign | null> {
  const res = await db.query<ResolvedCampaign>(
    `select c.id, c.profile_id, c.amazon_campaign_id, c.name, c.state, c.raw_json
     from campaigns c
     join amazon_profiles p on p.id = c.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1 and (c.id::text = $2 or c.amazon_campaign_id = $2)`,
    [workspaceId, campaignId],
  );
  return res.rows[0] ?? null;
}

/**
 * Resolves a campaign and throws if not found.
 */
export async function requireCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
): Promise<ResolvedCampaign> {
  const campaign = await resolveCampaign(db, workspaceId, campaignId);
  if (!campaign) {
    throw new Error(`Campaign '${campaignId}' not found in workspace`);
  }
  return campaign;
}

/** Resolves an ad group within a campaign (by ID or falls back to the first). */
export async function resolveAdGroupId(
  db: Db,
  campaignId: string,
  adGroupId?: string,
): Promise<string | null> {
  if (adGroupId) {
    const res = await db.query<{ id: string }>(
      `select id from ad_groups where campaign_id = $1 and (id::text = $2 or amazon_ad_group_id = $2) limit 1`,
      [campaignId, adGroupId],
    );
    if (res.rows[0]) return res.rows[0].id;
    throw new Error(`Ad group '${adGroupId}' not found in campaign`);
  }
  const res = await db.query<{ id: string }>(
    `select id from ad_groups where campaign_id = $1 order by id asc limit 1`,
    [campaignId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Record domain audit event into audit_events table.
 */
export async function recordAudit(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    event: string;
    entityType?: string;
    entityId: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await audit.insertAuditEvent(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    event: input.event,
    entityType: input.entityType ?? "change_set",
    entityId: input.entityId,
    details: input.details ?? {},
  });
}

/**
 * Stamps fingerprints onto action inserts and creates the change set in Change Center.
 */
export async function createFingerprintedChangeSet(
  db: Pool,
  opts: {
    profileId: string;
    creatorUserId: string;
    kind:
      | ChangeSetKind
      | "campaign_creation"
      | "campaign_update"
      | "max_cpc"
      | "recommendation"
      | "rollback";
    metadata: Record<string, unknown>;
    actions: (
      | changes.ChangeActionInsert
      | Omit<changes.ChangeActionInsert, "fingerprint">
    )[];
    extraFingerprintSeed?: unknown[];
  },
) {
  const setFingerprint = buildChangeSetFingerprint({
    profileId: opts.profileId,
    creatorUserId: opts.creatorUserId,
    actions: [...(opts.extraFingerprintSeed ?? []), ...opts.actions],
  });

  return changes.createChangeSet(db, {
    profileId: opts.profileId,
    creatorUserId: opts.creatorUserId,
    fingerprint: setFingerprint,
    kind: opts.kind,
    metadata: opts.metadata,
    actions: opts.actions.map((a) => ({
      ...a,
      fingerprint: buildChangeActionFingerprint({
        changeSetId: setFingerprint,
        actionType: a.actionType,
        campaignId: a.campaignId,
        adGroupId: a.adGroupId,
        targetId: a.targetId,
        searchTerm: a.searchTerm,
        beforeValue: a.beforeValue,
        afterValue: a.afterValue,
        beforeState: a.beforeState,
        afterState: a.afterState,
        amazonEntityId: a.amazonEntityId,
      }),
    })),
  });
}
