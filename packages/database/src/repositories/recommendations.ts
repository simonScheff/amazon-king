import type {
  RecommendationState,
  RecommendationType,
} from "@amazon-king/contracts";
import type { Db } from "../db.js";

/**
 * Recommendations and their immutable evidence (plan §7/§9).
 * State transitions are guarded updates so concurrent workers cannot
 * double-approve or act on expired rows.
 */

export interface Recommendation {
  id: string;
  profileId: string;
  type: RecommendationType;
  campaignId: string | null;
  adGroupId: string | null;
  targetId: string | null;
  searchTerm: string | null;
  priority: number;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  currentValue: string | null;
  proposedValue: string | null;
  rationale: string;
  confidence: string;
  state: RecommendationState;
  ruleVersion: string;
  dataFreshnessAt: string;
  expiresAt: string;
  createdAt: string;
}

interface RecommendationRow {
  id: string;
  profile_id: string;
  type: RecommendationType;
  campaign_id: string | null;
  ad_group_id: string | null;
  target_id: string | null;
  search_term: string | null;
  priority: number;
  evidence_window_start: string;
  evidence_window_end: string;
  current_value: string | null;
  proposed_value: string | null;
  rationale: string;
  confidence: string;
  state: RecommendationState;
  rule_version: string;
  data_freshness_at: string;
  expires_at: string;
  created_at: string;
}

function toRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    profileId: row.profile_id,
    type: row.type,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    targetId: row.target_id,
    searchTerm: row.search_term,
    priority: row.priority,
    evidenceWindowStart: row.evidence_window_start,
    evidenceWindowEnd: row.evidence_window_end,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    rationale: row.rationale,
    confidence: row.confidence,
    state: row.state,
    ruleVersion: row.rule_version,
    dataFreshnessAt: row.data_freshness_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export interface RecommendationInsert {
  profileId: string;
  type: RecommendationType;
  campaignId?: string | null;
  adGroupId?: string | null;
  targetId?: string | null;
  searchTerm?: string | null;
  priority: number;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  currentValue?: string | null;
  proposedValue?: string | null;
  rationale: string;
  confidence: string;
  ruleVersion: string;
  dataFreshnessAt: string;
  expiresAt: string;
  /** Immutable rule inputs stored in recommendation_evidence (§9). */
  evidenceInputs: unknown;
}

/** Insert a recommendation together with its immutable evidence row. */
export async function insertRecommendation(
  db: Db,
  input: RecommendationInsert,
): Promise<Recommendation> {
  const result = await db.query<{ recommendation: RecommendationRow }>(
    `with rec as (
       insert into recommendations
         (profile_id, type, campaign_id, ad_group_id, target_id, search_term,
          priority, evidence_window_start, evidence_window_end,
          current_value, proposed_value, rationale, confidence,
          rule_version, data_freshness_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       returning *
     ),
     ev as (
       insert into recommendation_evidence (recommendation_id, inputs)
       select id, $17::jsonb from rec
     )
     select row_to_json(rec) as recommendation from rec`,
    [
      input.profileId,
      input.type,
      input.campaignId ?? null,
      input.adGroupId ?? null,
      input.targetId ?? null,
      input.searchTerm ?? null,
      input.priority,
      input.evidenceWindowStart,
      input.evidenceWindowEnd,
      input.currentValue ?? null,
      input.proposedValue ?? null,
      input.rationale,
      input.confidence,
      input.ruleVersion,
      input.dataFreshnessAt,
      input.expiresAt,
      JSON.stringify(input.evidenceInputs),
    ],
  );
  const row = result.rows[0]!.recommendation as RecommendationRow;
  return toRecommendation(row);
}

export interface PendingFilter {
  profileId?: string;
  type?: RecommendationType;
  limit?: number;
}

/** List pending recommendations (inbox), highest priority first. */
export async function listPendingRecommendations(
  db: Db,
  filter: PendingFilter = {},
): Promise<Recommendation[]> {
  const result = await db.query<RecommendationRow>(
    `select * from recommendations
     where state = 'pending'
       and ($1::bigint is null or profile_id = $1)
       and ($2::text is null or type = $2)
     order by priority asc, created_at desc
     limit coalesce($3, 100)`,
    [filter.profileId ?? null, filter.type ?? null, filter.limit ?? null],
  );
  return result.rows.map(toRecommendation);
}

/**
 * Guarded state transition: succeeds only when the row is currently in
 * `from`. Returns the updated row, or null when the guard did not match.
 */
export async function transitionRecommendationState(
  db: Db,
  recommendationId: string,
  from: RecommendationState,
  to: RecommendationState,
): Promise<Recommendation | null> {
  const result = await db.query<RecommendationRow>(
    `update recommendations set state = $3
     where id = $1 and state = $2
     returning *`,
    [recommendationId, from, to],
  );
  return result.rows[0] ? toRecommendation(result.rows[0]) : null;
}

/**
 * Expire stale pending recommendations (expires_at reached or source data
 * went stale, §9). Returns the number expired.
 */
export async function expireStaleRecommendations(
  db: Db,
  now?: Date,
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `update recommendations set state = 'expired'
     where state = 'pending' and expires_at <= coalesce($1::timestamptz, now())
     returning id`,
    [now ?? null],
  );
  return result.rowCount ?? 0;
}

export interface RecommendationWithProfile extends Recommendation {
  /** Amazon's profile id (what API payloads expose as profileId). */
  amazonProfileId: string;
  /**
   * Campaign identity resolved through `campaign_id`, so payloads can name
   * and link the campaign instead of exposing its internal row id. Null when
   * the finding has no campaign grain.
   */
  amazonCampaignId: string | null;
  campaignName: string | null;
  campaignState: string | null;
}

type RecommendationJoinRow = RecommendationRow & {
  amazon_profile_id: string;
  amazon_campaign_id: string | null;
  campaign_name: string | null;
  campaign_state: string | null;
};

function withProfile(row: RecommendationJoinRow): RecommendationWithProfile {
  return {
    ...toRecommendation(row),
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    campaignState: row.campaign_state ?? null,
  };
}

/** Profile and campaign identity columns shared by the workspace queries. */
const RECOMMENDATION_IDENTITY_COLUMNS = `p.profile_id as amazon_profile_id,
            rc.amazon_campaign_id, rc.name as campaign_name,
            rc.state as campaign_state`;

export interface RecommendationListFilter {
  type?: RecommendationType;
  state?: RecommendationState;
  limit?: number;
  /**
   * Product filter (null/undefined or empty = no filter): keep
   * recommendations whose ad group — or any ad group of their campaign —
   * advertises one of the selected books. Recommendations with no campaign
   * or ad group linkage are not attributable to a book and stay listed.
   */
  bookIds?: bigint[] | null;
}

/** List recommendations for a workspace (any state), highest priority first. */
export async function listRecommendationsByWorkspace(
  db: Db,
  workspaceId: string,
  filter: RecommendationListFilter = {},
): Promise<RecommendationWithProfile[]> {
  const result = await db.query<RecommendationJoinRow>(
    `select r.*, ${RECOMMENDATION_IDENTITY_COLUMNS}
     from recommendations r
     join amazon_profiles p on p.id = r.profile_id
     join amazon_connections c on c.id = p.connection_id
     left join campaigns rc on rc.id = r.campaign_id
     where c.workspace_id = $1
       and ($2::text is null or r.type = $2)
       and ($3::text is null or r.state = $3)
       and (coalesce(cardinality($5::bigint[]), 0) = 0 or
         case
           when r.ad_group_id is not null then exists (
             select 1
             from ads fa
             join book_profile_links fb
               on fb.profile_id = fa.profile_id
              and fb.marketplace_asin = fa.asin
              and fb.enabled = true
             where fa.ad_group_id = r.ad_group_id
               and fb.book_id = any($5)
           )
           when r.campaign_id is not null then exists (
             select 1
             from ad_groups fg
             join ads fa
               on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
             join book_profile_links fb
               on fb.profile_id = fg.profile_id
              and fb.marketplace_asin = fa.asin
              and fb.enabled = true
             where fg.campaign_id = r.campaign_id
               and fb.book_id = any($5)
           )
           else true
         end)
     order by r.priority asc, r.created_at desc
     limit coalesce($4, 100)`,
    [
      workspaceId,
      filter.type ?? null,
      filter.state ?? null,
      filter.limit ?? null,
      filter.bookIds ?? null,
    ],
  );
  return result.rows.map(withProfile);
}

/** Fetch one recommendation scoped to a workspace (null when not found). */
export async function getRecommendationForWorkspace(
  db: Db,
  workspaceId: string,
  recommendationId: string,
): Promise<RecommendationWithProfile | null> {
  const result = await db.query<RecommendationJoinRow>(
    `select r.*, ${RECOMMENDATION_IDENTITY_COLUMNS}
     from recommendations r
     join amazon_profiles p on p.id = r.profile_id
     join amazon_connections c on c.id = p.connection_id
     left join campaigns rc on rc.id = r.campaign_id
     where c.workspace_id = $1 and r.id = $2`,
    [workspaceId, recommendationId],
  );
  return result.rows[0] ? withProfile(result.rows[0]) : null;
}

/**
 * Identity of a finding, matching the worker's pending-dedupe tuple. Used to
 * suppress a dismissed recommendation on later runs.
 */
export interface RecommendationDismissalIdentity {
  profileId: string;
  type: string;
  campaignId?: string | null;
  adGroupId?: string | null;
  targetId?: string | null;
  searchTerm?: string | null;
}

export interface RecommendationDismissalInput extends RecommendationDismissalIdentity {
  recommendationId?: string | null;
  /** When suppression lapses; null keeps the finding dismissed forever. */
  dismissedUntil?: string | null;
}

/** The stored search term is normalized so casing drift cannot resurrect a dismissal. */
const NORMALIZED_SEARCH_TERM = "nullif(lower(btrim($6::text)), '')";

/**
 * Record (or refresh) a dismissal. Re-rejecting the same finding extends the
 * suppression window rather than inserting a duplicate.
 */
export async function upsertRecommendationDismissal(
  db: Db,
  input: RecommendationDismissalInput,
): Promise<void> {
  await db.query(
    `insert into recommendation_dismissals
       (profile_id, type, campaign_id, ad_group_id, target_id, search_term,
        recommendation_id, dismissed_until)
     values ($1, $2, $3, $4, $5, ${NORMALIZED_SEARCH_TERM}, $7, $8)
     on conflict (profile_id, type, campaign_id, ad_group_id, target_id, search_term)
     do update set
       recommendation_id = excluded.recommendation_id,
       dismissed_at = now(),
       dismissed_until = excluded.dismissed_until`,
    [
      input.profileId,
      input.type,
      input.campaignId ?? null,
      input.adGroupId ?? null,
      input.targetId ?? null,
      input.searchTerm ?? null,
      input.recommendationId ?? null,
      input.dismissedUntil ?? null,
    ],
  );
}

/** True when this finding is currently dismissed and must not be re-inserted. */
export async function activeDismissalExists(
  db: Db,
  identity: RecommendationDismissalIdentity,
  now?: Date,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `select id::text from recommendation_dismissals
     where profile_id = $1 and type = $2
       and campaign_id is not distinct from $3
       and ad_group_id is not distinct from $4
       and target_id is not distinct from $5
       and search_term is not distinct from ${NORMALIZED_SEARCH_TERM}
       and (dismissed_until is null
            or dismissed_until > coalesce($7::timestamptz, now()))
     limit 1`,
    [
      identity.profileId,
      identity.type,
      identity.campaignId ?? null,
      identity.adGroupId ?? null,
      identity.targetId ?? null,
      identity.searchTerm ?? null,
      now ?? null,
    ],
  );
  return result.rows.length > 0;
}

/** Fetch the immutable inputs captured when a recommendation was produced. */
export async function getRecommendationEvidence(
  db: Db,
  recommendationId: string,
): Promise<unknown | null> {
  const result = await db.query<{ inputs: unknown }>(
    `select inputs from recommendation_evidence
     where recommendation_id = $1
     order by id
     limit 1`,
    [recommendationId],
  );
  return result.rows[0]?.inputs ?? null;
}
