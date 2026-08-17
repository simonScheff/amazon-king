import type {
  ChangeActionStatus,
  ChangeActionType,
  ChangeSetStatus,
} from "@amazon-king/contracts";
import { withTransaction } from "../pool.js";
import type { Db, Pool } from "../db.js";

/**
 * Change sets and change actions (plan §10): immutable user-approved
 * batches applied through the guarded Amazon write path. Fingerprints make
 * creation idempotent; an advisory lock serializes creation per profile.
 */

export interface ChangeSet {
  id: string;
  profileId: string;
  creatorUserId: string;
  status: ChangeSetStatus;
  guardrailResult: unknown | null;
  fingerprint: string;
  createdAt: string;
  appliedAt: string | null;
  kind:
    | "recommendation"
    | "max_cpc"
    | "rollback"
    | "campaign_creation"
    | "campaign_update";
  metadata: Record<string, unknown>;
}

interface ChangeSetRow {
  id: string;
  profile_id: string;
  creator_user_id: string;
  status: ChangeSetStatus;
  guardrail_result: unknown | null;
  fingerprint: string;
  created_at: string;
  applied_at: string | null;
  kind:
    | "recommendation"
    | "max_cpc"
    | "rollback"
    | "campaign_creation"
    | "campaign_update";
  metadata: Record<string, unknown>;
}

function toChangeSet(row: ChangeSetRow): ChangeSet {
  return {
    id: row.id,
    profileId: row.profile_id,
    creatorUserId: row.creator_user_id,
    status: row.status,
    guardrailResult: row.guardrail_result,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    kind: row.kind,
    metadata: row.metadata,
  };
}

export interface ChangeAction {
  id: string;
  changeSetId: string;
  recommendationId: string | null;
  actionType: ChangeActionType;
  campaignId: string | null;
  adGroupId: string | null;
  targetId: string | null;
  searchTerm: string | null;
  /** Resolved campaign name; only populated by listChangeActions. */
  campaignName: string | null;
  /** Resolved Amazon campaign id (app route key); only listChangeActions. */
  amazonCampaignId: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  fingerprint: string;
  status: ChangeActionStatus;
  amazonRequest: unknown | null;
  amazonResponse: unknown | null;
  amazonRequestId: string | null;
  verifiedAt: string | null;
  rollbackOfId: string | null;
  createdAt: string;
  amazonEntityId: string | null;
  entityName: string | null;
  beforeState: unknown | null;
  afterState: unknown | null;
}

interface ChangeActionRow {
  id: string;
  change_set_id: string;
  recommendation_id: string | null;
  action_type: ChangeActionType;
  campaign_id: string | null;
  ad_group_id: string | null;
  target_id: string | null;
  search_term: string | null;
  /** Present only when the query joined campaigns (listChangeActions). */
  campaign_name?: string | null;
  amazon_campaign_id?: string | null;
  before_value: string | null;
  after_value: string | null;
  fingerprint: string;
  status: ChangeActionStatus;
  amazon_request: unknown | null;
  amazon_response: unknown | null;
  amazon_request_id: string | null;
  verified_at: string | null;
  rollback_of_id: string | null;
  created_at: string;
  amazon_entity_id: string | null;
  entity_name: string | null;
  before_state: unknown | null;
  after_state: unknown | null;
}

function toChangeAction(row: ChangeActionRow): ChangeAction {
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    recommendationId: row.recommendation_id,
    actionType: row.action_type,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    targetId: row.target_id,
    searchTerm: row.search_term,
    campaignName: row.campaign_name ?? null,
    amazonCampaignId: row.amazon_campaign_id ?? null,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    fingerprint: row.fingerprint,
    status: row.status,
    amazonRequest: row.amazon_request,
    amazonResponse: row.amazon_response,
    amazonRequestId: row.amazon_request_id,
    verifiedAt: row.verified_at,
    rollbackOfId: row.rollback_of_id,
    createdAt: row.created_at,
    amazonEntityId: row.amazon_entity_id,
    entityName: row.entity_name,
    beforeState: row.before_state,
    afterState: row.after_state,
  };
}

export interface ChangeActionInsert {
  recommendationId?: string | null;
  actionType: ChangeActionType;
  campaignId?: string | null;
  adGroupId?: string | null;
  targetId?: string | null;
  searchTerm?: string | null;
  beforeValue?: string | null;
  afterValue?: string | null;
  fingerprint: string;
  rollbackOfId?: string | null;
  amazonEntityId?: string | null;
  entityName?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}

export interface CreatedChangeSet {
  changeSet: ChangeSet;
  actions: ChangeAction[];
  /** False when the fingerprint already existed (idempotent replay). */
  created: boolean;
}

export async function findChangeSetByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<ChangeSet | null> {
  const result = await db.query<ChangeSetRow>(
    `select * from change_sets where fingerprint = $1`,
    [fingerprint],
  );
  return result.rows[0] ? toChangeSet(result.rows[0]) : null;
}

export async function findChangeActionByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<ChangeAction | null> {
  const result = await db.query<ChangeActionRow>(
    `select * from change_actions where fingerprint = $1`,
    [fingerprint],
  );
  return result.rows[0] ? toChangeAction(result.rows[0]) : null;
}

export async function listChangeActions(
  db: Db,
  changeSetId: string,
): Promise<ChangeAction[]> {
  const result = await db.query<ChangeActionRow>(
    `select ca.*, c.name as campaign_name, c.amazon_campaign_id
     from change_actions ca
     left join campaigns c on c.id = ca.campaign_id
     where ca.change_set_id = $1
     order by ca.id`,
    [changeSetId],
  );
  return result.rows.map(toChangeAction);
}

/**
 * Create a change set with its actions atomically. A transaction-scoped
 * advisory lock keyed on the profile serializes concurrent creation for the
 * same profile; a fingerprint replay returns the existing set instead of
 * duplicating it.
 */
export async function createChangeSet(
  pool: Pool,
  input: {
    profileId: string;
    creatorUserId: string;
    fingerprint: string;
    guardrailResult?: unknown;
    actions: readonly ChangeActionInsert[];
    kind?:
      | "recommendation"
      | "max_cpc"
      | "rollback"
      | "campaign_creation"
      | "campaign_update";
    metadata?: Record<string, unknown>;
  },
): Promise<CreatedChangeSet> {
  return withTransaction(pool, async (client) => {
    // Serialize change-set creation per profile for the transaction duration.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`change_set:${input.profileId}`],
    );

    const existing = await findChangeSetByFingerprint(
      client,
      input.fingerprint,
    );
    if (existing) {
      return {
        changeSet: existing,
        actions: await listChangeActions(client, existing.id),
        created: false,
      };
    }

    const setResult = await client.query<ChangeSetRow>(
      `insert into change_sets
         (profile_id, creator_user_id, fingerprint, guardrail_result, kind, metadata)
       values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
       returning *`,
      [
        input.profileId,
        input.creatorUserId,
        input.fingerprint,
        input.guardrailResult == null
          ? null
          : JSON.stringify(input.guardrailResult),
        input.kind ?? "recommendation",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const changeSet = toChangeSet(setResult.rows[0]!);

    const actions: ChangeAction[] = [];
    for (const action of input.actions) {
      const actionResult = await client.query<ChangeActionRow>(
        `insert into change_actions
           (change_set_id, recommendation_id, action_type, campaign_id, ad_group_id,
            target_id, search_term, before_value, after_value, fingerprint, rollback_of_id,
            amazon_entity_id, entity_name, before_state, after_state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
         returning *`,
        [
          changeSet.id,
          action.recommendationId ?? null,
          action.actionType,
          action.campaignId ?? null,
          action.adGroupId ?? null,
          action.targetId ?? null,
          action.searchTerm ?? null,
          action.beforeValue ?? null,
          action.afterValue ?? null,
          action.fingerprint,
          action.rollbackOfId ?? null,
          action.amazonEntityId ?? null,
          action.entityName ?? null,
          action.beforeState == null
            ? null
            : JSON.stringify(action.beforeState),
          action.afterState == null ? null : JSON.stringify(action.afterState),
        ],
      );
      actions.push(toChangeAction(actionResult.rows[0]!));
    }
    return { changeSet, actions, created: true };
  });
}

/** Update change-set status; sets applied_at when a terminal applied state is reached. */
export async function updateChangeSetStatus(
  db: Db,
  changeSetId: string,
  status: ChangeSetStatus,
  guardrailResult?: unknown,
): Promise<ChangeSet | null> {
  const result = await db.query<ChangeSetRow>(
    `update change_sets set
       status = $2,
       guardrail_result = coalesce($3::jsonb, guardrail_result),
       applied_at = case
         when $2 in ('applied', 'partially_applied') then now()
         else applied_at
       end
     where id = $1
     returning *`,
    [
      changeSetId,
      status,
      guardrailResult == null ? null : JSON.stringify(guardrailResult),
    ],
  );
  return result.rows[0] ? toChangeSet(result.rows[0]) : null;
}

export interface ActionResultRecord {
  status: ChangeActionStatus;
  amazonRequest?: unknown;
  amazonResponse?: unknown;
  amazonRequestId?: string | null;
  amazonEntityId?: string | null;
  verifiedAt?: string | null;
}

/** Record the Amazon request/response and result for one action (§10 apply flow). */
export async function recordChangeActionResult(
  db: Db,
  changeActionId: string,
  record: ActionResultRecord,
): Promise<ChangeAction | null> {
  const result = await db.query<ChangeActionRow>(
    `update change_actions set
       status = $2,
       amazon_request = coalesce($3::jsonb, amazon_request),
       amazon_response = coalesce($4::jsonb, amazon_response),
       amazon_request_id = coalesce($5, amazon_request_id),
       verified_at = coalesce($6::timestamptz, verified_at),
       amazon_entity_id = coalesce($7, amazon_entity_id)
     where id = $1
     returning *`,
    [
      changeActionId,
      record.status,
      record.amazonRequest == null
        ? null
        : JSON.stringify(record.amazonRequest),
      record.amazonResponse == null
        ? null
        : JSON.stringify(record.amazonResponse),
      record.amazonRequestId ?? null,
      record.verifiedAt ?? null,
      record.amazonEntityId ?? null,
    ],
  );
  return result.rows[0] ? toChangeAction(result.rows[0]) : null;
}

export interface ChangeSetWithProfile extends ChangeSet {
  /** Amazon's profile id (what API payloads expose as profileId). */
  amazonProfileId: string;
}

function withProfile(
  row: ChangeSetRow & { amazon_profile_id: string },
): ChangeSetWithProfile {
  return { ...toChangeSet(row), amazonProfileId: row.amazon_profile_id };
}

/** List change sets of a workspace, newest first. */
export async function listChangeSetsByWorkspace(
  db: Db,
  workspaceId: string,
  options: { limit?: number } = {},
): Promise<ChangeSetWithProfile[]> {
  const result = await db.query<ChangeSetRow & { amazon_profile_id: string }>(
    `select cs.*, p.profile_id as amazon_profile_id
     from change_sets cs
     join amazon_profiles p on p.id = cs.profile_id
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1
     order by cs.created_at desc, cs.id desc
     limit coalesce($2, 100)`,
    [workspaceId, options.limit ?? null],
  );
  return result.rows.map(withProfile);
}

/** Fetch one change set scoped to a workspace (null when not found). */
export async function getChangeSetForWorkspace(
  db: Db,
  workspaceId: string,
  changeSetId: string,
): Promise<ChangeSetWithProfile | null> {
  const result = await db.query<ChangeSetRow & { amazon_profile_id: string }>(
    `select cs.*, p.profile_id as amazon_profile_id
     from change_sets cs
     join amazon_profiles p on p.id = cs.profile_id
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1 and cs.id = $2`,
    [workspaceId, changeSetId],
  );
  return result.rows[0] ? withProfile(result.rows[0]) : null;
}

export interface ChangeActionWithContext extends ChangeAction {
  /** Internal change_sets.profile_id (amazon_profiles PK). */
  profilePk: string;
  /** Amazon's profile id. */
  amazonProfileId: string;
  creatorUserId: string;
}

/** Fetch one change action with its parent set context, workspace-scoped. */
export async function getChangeActionForWorkspace(
  db: Db,
  workspaceId: string,
  changeActionId: string,
): Promise<ChangeActionWithContext | null> {
  const result = await db.query<
    ChangeActionRow & {
      profile_pk: string;
      amazon_profile_id: string;
      creator_user_id: string;
    }
  >(
    `select ca.*, cs.profile_id as profile_pk, cs.creator_user_id,
            p.profile_id as amazon_profile_id
     from change_actions ca
     join change_sets cs on cs.id = ca.change_set_id
     join amazon_profiles p on p.id = cs.profile_id
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1 and ca.id = $2`,
    [workspaceId, changeActionId],
  );
  const row = result.rows[0];
  return row
    ? {
        ...toChangeAction(row),
        profilePk: row.profile_pk,
        amazonProfileId: row.amazon_profile_id,
        creatorUserId: row.creator_user_id,
      }
    : null;
}

/**
 * Guarded change-set status transition: succeeds only when the row is
 * currently in one of `from`. Returns the updated row, or null when the
 * guard did not match (e.g. a concurrent apply already moved it).
 */
export async function transitionChangeSetStatus(
  db: Db,
  changeSetId: string,
  from: readonly ChangeSetStatus[],
  to: ChangeSetStatus,
  guardrailResult?: unknown,
): Promise<ChangeSet | null> {
  const result = await db.query<ChangeSetRow>(
    `update change_sets set
       status = $3,
       guardrail_result = coalesce($4::jsonb, guardrail_result),
       applied_at = case
         when $3 in ('applied', 'partially_applied') then now()
         else applied_at
       end
     where id = $1 and status = any($2::text[])
     returning *`,
    [
      changeSetId,
      [...from],
      to,
      guardrailResult == null ? null : JSON.stringify(guardrailResult),
    ],
  );
  return result.rows[0] ? toChangeSet(result.rows[0]) : null;
}

export interface RecentAppliedAction {
  actionType: ChangeActionType;
  targetId: string | null;
  campaignId: string | null;
  searchTerm: string | null;
  changedAt: string;
  /** Parent change set — lets rollback exclude the change it undoes from cooldowns. */
  changeSetId: string;
}

/**
 * Actions applied for a profile since a cutoff — the cooldown input the
 * optimizer's guardrails read (plan §10: one adjustment per cooldown period).
 * Rollback actions carry rollback_of_id so cooldown suppression ignores them
 * only when the caller chooses; here they are simply included as changes.
 * Actions recorded without an internal target row (e.g. bid changes resolved
 * straight from an Amazon entity id) expose that Amazon id as targetId via
 * the coalesce, so cooldown matching never degenerates to null = null.
 */
export async function listRecentAppliedActions(
  db: Db,
  profilePk: string,
  since: Date,
): Promise<RecentAppliedAction[]> {
  const result = await db.query<{
    action_type: ChangeActionType;
    target_id: string | null;
    campaign_id: string | null;
    search_term: string | null;
    applied_at: string;
    change_set_id: string;
  }>(
    `select ca.action_type,
            coalesce(ca.target_id::text, ca.amazon_entity_id) as target_id,
            ca.campaign_id::text as campaign_id, ca.search_term,
            cs.applied_at, cs.id::text as change_set_id
     from change_actions ca
     join change_sets cs on cs.id = ca.change_set_id
     where cs.profile_id = $1
       and ca.status = 'applied'
       and cs.applied_at is not null
       and cs.applied_at >= $2
     order by cs.applied_at desc`,
    [profilePk, since.toISOString()],
  );
  return result.rows.map((row) => ({
    actionType: row.action_type,
    targetId: row.target_id,
    campaignId: row.campaign_id,
    searchTerm: row.search_term,
    changedAt: row.applied_at,
    changeSetId: row.change_set_id,
  }));
}

/** Fetch a change action by id (no workspace scoping — internal use). */
export async function getChangeAction(
  db: Db,
  changeActionId: string,
): Promise<ChangeAction | null> {
  const result = await db.query<ChangeActionRow>(
    `select * from change_actions where id = $1`,
    [changeActionId],
  );
  return result.rows[0] ? toChangeAction(result.rows[0]) : null;
}
