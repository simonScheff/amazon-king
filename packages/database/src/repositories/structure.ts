import type { Db } from "../db.js";

/**
 * Idempotent structure upserts (plan §7): each is a single atomic statement
 * (INSERT ... ON CONFLICT DO UPDATE inside a CTE) that also records
 * name/bid/budget/state changes into entity_change_history and returns
 * which fields changed.
 */

export interface StructureUpsertResult {
  /** Internal identity PK of the upserted row. */
  id: string;
  created: boolean;
  /** Fields whose value changed (recorded in entity_change_history). */
  changedFields: string[];
}

interface UpsertRow {
  id: string;
  created: boolean;
  changed_fields: string[] | null;
}

function toResult(row: UpsertRow): StructureUpsertResult {
  return {
    id: row.id,
    created: row.created,
    changedFields: row.changed_fields ?? [],
  };
}

export interface CampaignUpsertInput {
  profileId: string;
  amazonCampaignId: string;
  name: string;
  state: string;
  targetingType?: string | null;
  dailyBudget?: string | null;
  portfolioId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  rawJson?: unknown;
  sourceUpdatedAt?: string | null;
}

export async function upsertCampaign(
  db: Db,
  input: CampaignUpsertInput,
): Promise<StructureUpsertResult> {
  const result = await db.query<UpsertRow>(
    `with old as (
       select id, name, state, daily_budget::text as daily_budget
       from campaigns where profile_id = $1 and amazon_campaign_id = $2
     ),
     ins as (
       insert into campaigns
         (profile_id, amazon_campaign_id, name, state, targeting_type, daily_budget,
          portfolio_id, start_date, end_date, raw_json, source_updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       on conflict (profile_id, amazon_campaign_id) do update set
         name = excluded.name,
         state = excluded.state,
         targeting_type = excluded.targeting_type,
         daily_budget = excluded.daily_budget,
         portfolio_id = excluded.portfolio_id,
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         raw_json = excluded.raw_json,
         source_updated_at = excluded.source_updated_at
       returning id
     ),
     hist as (
       insert into entity_change_history (entity_type, entity_id, field, old_value, new_value)
       select 'campaign', (select id from ins), f.field, f.old_value, f.new_value
       from (
         select 'name' as field, o.name as old_value, $3::text as new_value
         from old o where o.name is distinct from $3::text
         union all
         select 'state', o.state, $4::text
         from old o where o.state is distinct from $4::text
         union all
         select 'daily_budget', o.daily_budget, $6::numeric::text
         from old o where o.daily_budget::numeric is distinct from $6::numeric
       ) f
       returning field
     )
     select (select id from ins) as id,
            not exists (select 1 from old) as created,
            (select array_agg(field) from hist) as changed_fields`,
    [
      input.profileId,
      input.amazonCampaignId,
      input.name,
      input.state,
      input.targetingType ?? null,
      input.dailyBudget ?? null,
      input.portfolioId ?? null,
      input.startDate ?? null,
      input.endDate ?? null,
      input.rawJson == null ? "{}" : JSON.stringify(input.rawJson),
      input.sourceUpdatedAt ?? null,
    ],
  );
  return toResult(result.rows[0]!);
}

export interface AdGroupUpsertInput {
  profileId: string;
  campaignId: string; // internal campaigns.id
  amazonAdGroupId: string;
  name: string;
  state: string;
  defaultBid?: string | null;
  rawJson?: unknown;
  sourceUpdatedAt?: string | null;
}

export async function upsertAdGroup(
  db: Db,
  input: AdGroupUpsertInput,
): Promise<StructureUpsertResult> {
  const result = await db.query<UpsertRow>(
    `with old as (
       select id, name, state, default_bid::text as default_bid
       from ad_groups where profile_id = $1 and amazon_ad_group_id = $2
     ),
     ins as (
       insert into ad_groups
         (profile_id, campaign_id, amazon_ad_group_id, name, state, default_bid,
          raw_json, source_updated_at)
       values ($1, $3, $2, $4, $5, $6, $7::jsonb, $8)
       on conflict (profile_id, amazon_ad_group_id) do update set
         campaign_id = excluded.campaign_id,
         name = excluded.name,
         state = excluded.state,
         default_bid = excluded.default_bid,
         raw_json = excluded.raw_json,
         source_updated_at = excluded.source_updated_at
       returning id
     ),
     hist as (
       insert into entity_change_history (entity_type, entity_id, field, old_value, new_value)
       select 'ad_group', (select id from ins), f.field, f.old_value, f.new_value
       from (
         select 'name' as field, o.name as old_value, $4::text as new_value
         from old o where o.name is distinct from $4::text
         union all
         select 'state', o.state, $5::text
         from old o where o.state is distinct from $5::text
         union all
         select 'default_bid', o.default_bid, $6::numeric::text
         from old o where o.default_bid::numeric is distinct from $6::numeric
       ) f
       returning field
     )
     select (select id from ins) as id,
            not exists (select 1 from old) as created,
            (select array_agg(field) from hist) as changed_fields`,
    [
      input.profileId,
      input.amazonAdGroupId,
      input.campaignId,
      input.name,
      input.state,
      input.defaultBid ?? null,
      input.rawJson == null ? "{}" : JSON.stringify(input.rawJson),
      input.sourceUpdatedAt ?? null,
    ],
  );
  return toResult(result.rows[0]!);
}

export interface AdUpsertInput {
  profileId: string;
  adGroupId: string; // internal ad_groups.id
  amazonAdId: string;
  asin: string;
  state: string;
  rawJson?: unknown;
  sourceUpdatedAt?: string | null;
}

export async function upsertAd(
  db: Db,
  input: AdUpsertInput,
): Promise<StructureUpsertResult> {
  const result = await db.query<UpsertRow>(
    `with old as (
       select id, state
       from ads where profile_id = $1 and amazon_ad_id = $2
     ),
     ins as (
       insert into ads
         (profile_id, ad_group_id, amazon_ad_id, asin, state, raw_json, source_updated_at)
       values ($1, $3, $2, $4, $5, $6::jsonb, $7)
       on conflict (profile_id, amazon_ad_id) do update set
         ad_group_id = excluded.ad_group_id,
         asin = excluded.asin,
         state = excluded.state,
         raw_json = excluded.raw_json,
         source_updated_at = excluded.source_updated_at
       returning id
     ),
     hist as (
       insert into entity_change_history (entity_type, entity_id, field, old_value, new_value)
       select 'ad', (select id from ins), 'state', o.state, $5::text
       from old o where o.state is distinct from $5::text
       returning field
     )
     select (select id from ins) as id,
            not exists (select 1 from old) as created,
            (select array_agg(field) from hist) as changed_fields`,
    [
      input.profileId,
      input.amazonAdId,
      input.adGroupId,
      input.asin,
      input.state,
      input.rawJson == null ? "{}" : JSON.stringify(input.rawJson),
      input.sourceUpdatedAt ?? null,
    ],
  );
  return toResult(result.rows[0]!);
}

export interface TargetUpsertInput {
  profileId: string;
  campaignId: string; // internal campaigns.id
  adGroupId: string; // internal ad_groups.id
  amazonTargetId: string;
  targetKind: string;
  expression?: unknown;
  matchType?: string | null;
  bid?: string | null;
  state: string;
  rawJson?: unknown;
  sourceUpdatedAt?: string | null;
}

export async function upsertTarget(
  db: Db,
  input: TargetUpsertInput,
): Promise<StructureUpsertResult> {
  const result = await db.query<UpsertRow>(
    `with old as (
       select id, state, bid::text as bid
       from targets where profile_id = $1 and amazon_target_id = $2
     ),
     ins as (
       insert into targets
         (profile_id, campaign_id, ad_group_id, amazon_target_id, target_kind,
          expression, match_type, bid, state, raw_json, source_updated_at)
       values ($1, $3, $4, $2, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11)
       on conflict (profile_id, amazon_target_id) do update set
         campaign_id = excluded.campaign_id,
         ad_group_id = excluded.ad_group_id,
         target_kind = excluded.target_kind,
         expression = excluded.expression,
         match_type = excluded.match_type,
         bid = excluded.bid,
         state = excluded.state,
         raw_json = excluded.raw_json,
         source_updated_at = excluded.source_updated_at
       returning id
     ),
     hist as (
       insert into entity_change_history (entity_type, entity_id, field, old_value, new_value)
       select 'target', (select id from ins), f.field, f.old_value, f.new_value
       from (
         select 'state' as field, o.state as old_value, $9::text as new_value
         from old o where o.state is distinct from $9::text
         union all
         select 'bid', o.bid, $8::numeric::text
         from old o where o.bid::numeric is distinct from $8::numeric
       ) f
       returning field
     )
     select (select id from ins) as id,
            not exists (select 1 from old) as created,
            (select array_agg(field) from hist) as changed_fields`,
    [
      input.profileId,
      input.amazonTargetId,
      input.campaignId,
      input.adGroupId,
      input.targetKind,
      input.expression == null ? null : JSON.stringify(input.expression),
      input.matchType ?? null,
      input.bid ?? null,
      input.state,
      input.rawJson == null ? "{}" : JSON.stringify(input.rawJson),
      input.sourceUpdatedAt ?? null,
    ],
  );
  return toResult(result.rows[0]!);
}

export interface EntityChange {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
}

export interface CampaignRow {
  id: string;
  profileId: string;
  amazonCampaignId: string;
  name: string;
  state: string;
}

/** Fetch a campaign by internal PK. */
export async function getCampaign(
  db: Db,
  campaignPk: string,
): Promise<CampaignRow | null> {
  const result = await db.query<{
    id: string;
    profile_id: string;
    amazon_campaign_id: string;
    name: string;
    state: string;
  }>(
    `select id, profile_id, amazon_campaign_id, name, state
     from campaigns where id = $1`,
    [campaignPk],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        profileId: row.profile_id,
        amazonCampaignId: row.amazon_campaign_id,
        name: row.name,
        state: row.state,
      }
    : null;
}

/** Resolve an Amazon campaign id to its row, scoped to a workspace. */
export async function findCampaignByAmazonId(
  db: Db,
  workspaceId: string,
  amazonCampaignId: string,
): Promise<(CampaignRow & { amazonProfileId: string }) | null> {
  const result = await db.query<{
    id: string;
    profile_id: string;
    amazon_campaign_id: string;
    name: string;
    state: string;
    amazon_profile_id: string;
  }>(
    `select c.id, c.profile_id, c.amazon_campaign_id, c.name, c.state,
            p.profile_id as amazon_profile_id
     from campaigns c
     join amazon_profiles p on p.id = c.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1 and c.amazon_campaign_id = $2
     order by c.id
     limit 1`,
    [workspaceId, amazonCampaignId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        profileId: row.profile_id,
        amazonCampaignId: row.amazon_campaign_id,
        name: row.name,
        state: row.state,
        amazonProfileId: row.amazon_profile_id,
      }
    : null;
}

export interface AdGroupRow {
  id: string;
  profileId: string;
  campaignId: string;
  amazonAdGroupId: string;
  name: string;
  state: string;
}

/** Fetch an ad group by internal PK. */
export async function getAdGroup(
  db: Db,
  adGroupPk: string,
): Promise<AdGroupRow | null> {
  const result = await db.query<{
    id: string;
    profile_id: string;
    campaign_id: string;
    amazon_ad_group_id: string;
    name: string;
    state: string;
  }>(
    `select id, profile_id, campaign_id, amazon_ad_group_id, name, state
     from ad_groups where id = $1`,
    [adGroupPk],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        profileId: row.profile_id,
        campaignId: row.campaign_id,
        amazonAdGroupId: row.amazon_ad_group_id,
        name: row.name,
        state: row.state,
      }
    : null;
}

export interface TargetRow {
  id: string;
  profileId: string;
  campaignId: string;
  adGroupId: string;
  amazonTargetId: string;
  targetKind: string;
  bid: string | null;
  state: string;
}

/** Fetch a target (keyword/product target) by internal PK. */
export async function getTarget(
  db: Db,
  targetPk: string,
): Promise<TargetRow | null> {
  const result = await db.query<{
    id: string;
    profile_id: string;
    campaign_id: string;
    ad_group_id: string;
    amazon_target_id: string;
    target_kind: string;
    bid: string | null;
    state: string;
  }>(
    `select id, profile_id, campaign_id, ad_group_id, amazon_target_id,
            target_kind, bid::text as bid, state
     from targets where id = $1`,
    [targetPk],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        profileId: row.profile_id,
        campaignId: row.campaign_id,
        adGroupId: row.ad_group_id,
        amazonTargetId: row.amazon_target_id,
        targetKind: row.target_kind,
        bid: row.bid,
        state: row.state,
      }
    : null;
}

/** List recorded changes for one structure entity, newest first. */
export async function listEntityChanges(
  db: Db,
  entityType: "campaign" | "ad_group" | "ad" | "target",
  entityId: string,
): Promise<EntityChange[]> {
  const result = await db.query<{
    id: string;
    entity_type: string;
    entity_id: string;
    field: string;
    old_value: string | null;
    new_value: string | null;
    changed_at: string;
  }>(
    `select * from entity_change_history
     where entity_type = $1 and entity_id = $2
     order by changed_at desc, id desc`,
    [entityType, entityId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedAt: row.changed_at,
  }));
}
