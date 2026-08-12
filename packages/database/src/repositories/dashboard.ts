import type { Db } from "../db.js";

/**
 * Read-side dashboard queries (plan §12 screens): campaign explorer rows,
 * campaign detail hierarchy, daily trend series, and per-profile data
 * freshness. Monetary values come back as string-encoded numerics; callers
 * must not aggregate across currencies (metrics.dashboardTotals enforces the
 * same rule for single-profile totals).
 */

export interface TotalsRow {
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  orders: number;
}

interface RawTotals {
  impressions: string | null;
  clicks: string | null;
  cost: string | null;
  sales: string | null;
  orders: string | null;
}

function toTotals(row: RawTotals): TotalsRow {
  return {
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    cost: row.cost ?? "0",
    sales: row.sales ?? "0",
    orders: Number(row.orders ?? 0),
  };
}

export interface CampaignRowData {
  campaignPk: string;
  profilePk: string;
  amazonProfileId: string;
  amazonCampaignId: string;
  name: string;
  state: string;
  totals: TotalsRow;
}

/** Campaigns of a workspace with metric totals over a date range. */
export async function listCampaignRows(
  db: Db,
  workspaceId: string,
  dateStart: string,
  dateEnd: string,
): Promise<CampaignRowData[]> {
  const result = await db.query<
    RawTotals & {
      id: string;
      profile_id: string;
      amazon_profile_id: string;
      amazon_campaign_id: string;
      name: string;
      state: string;
    }
  >(
    `select c.id, c.profile_id, p.profile_id as amazon_profile_id,
            c.amazon_campaign_id, c.name, c.state,
            sum(m.impressions)::text as impressions,
            sum(m.clicks)::text as clicks,
            sum(m.cost)::text as cost,
            sum(m.sales)::text as sales,
            sum(m.orders)::text as orders
     from campaigns c
     join amazon_profiles p on p.id = c.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     left join campaign_metrics_daily m
       on m.profile_id = c.profile_id
      and m.campaign_id = c.amazon_campaign_id
      and m.metric_date between $2 and $3
     where conn.workspace_id = $1
     group by c.id, p.profile_id
     order by coalesce(sum(m.cost), 0) desc, c.id`,
    [workspaceId, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    campaignPk: row.id,
    profilePk: row.profile_id,
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id,
    name: row.name,
    state: row.state,
    totals: toTotals(row),
  }));
}

export interface NamedMetricRowData {
  id: string;
  name: string;
  state: string;
  totals: TotalsRow;
}

/** Ad groups of a campaign with totals aggregated from target-grain facts. */
export async function listAdGroupRows(
  db: Db,
  campaignPk: string,
  dateStart: string,
  dateEnd: string,
): Promise<NamedMetricRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_ad_group_id: string;
      name: string;
      state: string;
    }
  >(
    `select g.amazon_ad_group_id, g.name, g.state,
            sum(m.impressions)::text as impressions,
            sum(m.clicks)::text as clicks,
            sum(m.cost)::text as cost,
            sum(m.sales)::text as sales,
            sum(m.orders)::text as orders
     from ad_groups g
     left join target_metrics_daily m
       on m.profile_id = g.profile_id
      and m.ad_group_id = g.amazon_ad_group_id
      and m.metric_date between $2 and $3
     where g.campaign_id = $1
     group by g.id
     order by coalesce(sum(m.cost), 0) desc, g.id`,
    [campaignPk, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    id: row.amazon_ad_group_id,
    name: row.name,
    state: row.state,
    totals: toTotals(row),
  }));
}

/** Targets (keywords/product targets) of a campaign with metric totals. */
export async function listTargetRows(
  db: Db,
  campaignPk: string,
  dateStart: string,
  dateEnd: string,
): Promise<NamedMetricRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_target_id: string;
      name: string;
      state: string;
    }
  >(
    `select t.amazon_target_id,
            coalesce(t.match_type, t.target_kind) as name,
            t.state,
            sum(m.impressions)::text as impressions,
            sum(m.clicks)::text as clicks,
            sum(m.cost)::text as cost,
            sum(m.sales)::text as sales,
            sum(m.orders)::text as orders
     from targets t
     left join target_metrics_daily m
       on m.profile_id = t.profile_id
      and m.target_id = t.amazon_target_id
      and m.metric_date between $2 and $3
     where t.campaign_id = $1
     group by t.id
     order by coalesce(sum(m.cost), 0) desc, t.id`,
    [campaignPk, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    id: row.amazon_target_id,
    name: row.name,
    state: row.state,
    totals: toTotals(row),
  }));
}

/** Search terms of a campaign with metric totals (search terms have no state). */
export async function listSearchTermRows(
  db: Db,
  profilePk: string,
  amazonCampaignId: string,
  dateStart: string,
  dateEnd: string,
): Promise<NamedMetricRowData[]> {
  const result = await db.query<RawTotals & { search_term: string }>(
    `select m.search_term,
            sum(m.impressions)::text as impressions,
            sum(m.clicks)::text as clicks,
            sum(m.cost)::text as cost,
            sum(m.sales)::text as sales,
            sum(m.orders)::text as orders
     from search_term_metrics_daily m
     where m.profile_id = $1 and m.campaign_id = $2
       and m.metric_date between $3 and $4
     group by m.search_term
     order by sum(m.cost) desc, m.search_term`,
    [profilePk, amazonCampaignId, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    id: row.search_term,
    name: row.search_term,
    state: "n/a",
    totals: toTotals(row),
  }));
}

export interface DailyPoint {
  date: string;
  cost: string;
  sales: string;
  currency: string;
}

/**
 * Per-day cost/sales across the given profiles (trend chart). Rows are per
 * currency; the caller must refuse to merge differing currencies.
 */
export async function dailySeries(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
): Promise<DailyPoint[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    metric_date: string;
    cost: string;
    sales: string;
    currency: string;
  }>(
    `select metric_date::text as metric_date,
            sum(cost)::text as cost,
            sum(sales)::text as sales,
            currency
     from campaign_metrics_daily
     where profile_id = any($1::bigint[])
       and metric_date between $2 and $3
     group by metric_date, currency
     order by metric_date`,
    [profilePks.map(String), dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    cost: row.cost,
    sales: row.sales,
    currency: row.currency,
  }));
}

export interface DataFreshnessRow {
  profilePk: string;
  amazonProfileId: string;
  dataset: string;
  lastSuccessAt: string | null;
  completeThrough: string | null;
}

export interface LatestEconomicsRow {
  profilePk: string;
  estimatedRoyaltyPerSale: string;
  currency: string;
}

/**
 * The most recent in-effect economics row per profile (KDP royalty per
 * sale). Missing profiles simply have no row — callers must treat profit as
 * unavailable rather than guess (plan §7/§9).
 */
export async function latestEconomicsForProfiles(
  db: Db,
  profilePks: readonly string[],
  onDate?: string,
): Promise<LatestEconomicsRow[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    profile_id: string;
    estimated_royalty_per_sale: string;
    currency: string;
  }>(
    `select distinct on (profile_id)
            profile_id::text as profile_id,
            estimated_royalty_per_sale::text,
            currency
     from book_economics
     where profile_id = any($1::bigint[])
       and effective_from <= coalesce($2::date, current_date)
     order by profile_id, effective_from desc`,
    [profilePks.map(String), onDate ?? null],
  );
  return result.rows.map((row) => ({
    profilePk: row.profile_id,
    estimatedRoyaltyPerSale: row.estimated_royalty_per_sale,
    currency: row.currency,
  }));
}

/**
 * Per-profile freshness for the structure and metrics datasets: last
 * completed sync run of each kind, plus the newest imported metric date.
 */
export async function dataFreshnessByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<DataFreshnessRow[]> {
  const result = await db.query<{
    profile_pk: string;
    amazon_profile_id: string;
    dataset: string;
    last_success_at: string | null;
    complete_through: string | null;
  }>(
    `select p.id as profile_pk, p.profile_id as amazon_profile_id,
            d.dataset,
            s.last_success_at,
            case when d.dataset = 'metrics' then m.complete_through end as complete_through
     from amazon_profiles p
     join amazon_connections conn on conn.id = p.connection_id
     cross join (values ('structure'), ('metrics')) as d(dataset)
     left join lateral (
       select r.finished_at as last_success_at
       from sync_runs r
       where r.profile_id = p.id and r.kind = d.dataset and r.status = 'complete'
       order by r.finished_at desc
       limit 1
     ) s on true
     left join lateral (
       select max(cm.metric_date)::text as complete_through
       from campaign_metrics_daily cm
       where cm.profile_id = p.id
     ) m on true
     where conn.workspace_id = $1
     order by p.id, d.dataset`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    profilePk: row.profile_pk,
    amazonProfileId: row.amazon_profile_id,
    dataset: row.dataset,
    lastSuccessAt: row.last_success_at,
    completeThrough: row.complete_through,
  }));
}
