import type { Db } from "../db.js";

/**
 * Daily fact upserts and dashboard aggregation (plan §7/§8).
 * Batches are imported as a single atomic INSERT ... ON CONFLICT DO UPDATE
 * (rows passed as jsonb, expanded with jsonb_to_recordset) so retries and
 * duplicate imports converge.
 */

/** Thrown when an aggregation would mix currencies (plan §9 safeguard). */
export class MixedCurrencyError extends Error {
  readonly currencies: string[];

  constructor(currencies: string[]) {
    super(
      `Refusing to aggregate monetary values across currencies: ${currencies.join(", ")}`,
    );
    this.name = "MixedCurrencyError";
    this.currencies = currencies;
  }
}

/** Metric columns shared by every daily fact grain. */
export interface MetricValues {
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  orders: number;
  purchases7d: number;
  sales7d: string;
  purchases14d: number;
  sales14d: string;
  currency: string;
}

export interface CampaignMetricsRow extends MetricValues {
  profileId: string;
  campaignId: string; // Amazon campaign id
  metricDate: string; // ISO date
}

export interface TargetMetricsRow extends MetricValues {
  profileId: string;
  campaignId: string;
  adGroupId: string;
  targetId: string;
  metricDate: string;
}

export interface SearchTermMetricsRow extends MetricValues {
  profileId: string;
  campaignId: string;
  adGroupId: string;
  targetId: string;
  searchTerm: string;
  metricDate: string;
}

export interface AdvertisedProductMetricsRow extends MetricValues {
  profileId: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  metricDate: string;
}

export interface PlacementMetricsRow extends MetricValues {
  profileId: string;
  campaignId: string;
  placement: string;
  metricDate: string;
}

/** Convert camelCase input rows to the snake_case recordset the SQL expects. */
function toRecord(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }
  return out;
}

const METRIC_SET = `
  impressions = excluded.impressions,
  clicks = excluded.clicks,
  cost = excluded.cost,
  sales = excluded.sales,
  orders = excluded.orders,
  purchases7d = excluded.purchases7d,
  sales7d = excluded.sales7d,
  purchases14d = excluded.purchases14d,
  sales14d = excluded.sales14d,
  currency = excluded.currency`;

const METRIC_COLS = `impressions int, clicks int, cost numeric, sales numeric, orders int,
  purchases7d int, sales7d numeric, purchases14d int, sales14d numeric, currency char(3)`;

async function batchUpsert<T extends object>(
  db: Db,
  table: string,
  grainCols: string,
  grainTypes: string,
  conflictTarget: string,
  rows: readonly T[],
  keyFor: (row: T) => string,
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  // Amazon reports can contain the same fact grain more than once. PostgreSQL
  // rejects an INSERT that tries to update one conflict target twice, so keep
  // the final occurrence before sending the atomic batch. Retries and repeated
  // rows then converge on the same stored value.
  const records = [
    ...new Map(rows.map((row) => [keyFor(row), row] as const)).values(),
  ].map(toRecord);
  const result = await db.query(
    `insert into ${table} (${grainCols}, impressions, clicks, cost, sales, orders,
       purchases7d, sales7d, purchases14d, sales14d, currency)
     select ${grainCols}, impressions, clicks, cost, sales, orders,
       purchases7d, sales7d, purchases14d, sales14d, currency
     from jsonb_to_recordset($1::jsonb) as x(${grainTypes}, ${METRIC_COLS})
     on conflict ${conflictTarget} do update set ${METRIC_SET}`,
    [JSON.stringify(records)],
  );
  return result.rowCount ?? 0;
}

export function upsertCampaignMetrics(
  db: Db,
  rows: readonly CampaignMetricsRow[],
) {
  return batchUpsert(
    db,
    "campaign_metrics_daily",
    "profile_id, campaign_id, metric_date",
    "profile_id bigint, campaign_id text, metric_date date",
    "(profile_id, campaign_id, metric_date)",
    rows,
    (row) => JSON.stringify([row.profileId, row.campaignId, row.metricDate]),
  );
}

export function upsertTargetMetrics(db: Db, rows: readonly TargetMetricsRow[]) {
  return batchUpsert(
    db,
    "target_metrics_daily",
    "profile_id, campaign_id, ad_group_id, target_id, metric_date",
    "profile_id bigint, campaign_id text, ad_group_id text, target_id text, metric_date date",
    "(profile_id, target_id, metric_date)",
    rows,
    (row) => JSON.stringify([row.profileId, row.targetId, row.metricDate]),
  );
}

export function upsertSearchTermMetrics(
  db: Db,
  rows: readonly SearchTermMetricsRow[],
) {
  return batchUpsert(
    db,
    "search_term_metrics_daily",
    "profile_id, campaign_id, ad_group_id, target_id, search_term, metric_date",
    "profile_id bigint, campaign_id text, ad_group_id text, target_id text, search_term text, metric_date date",
    "(profile_id, target_id, search_term, metric_date)",
    rows,
    (row) =>
      JSON.stringify([
        row.profileId,
        row.targetId,
        row.searchTerm,
        row.metricDate,
      ]),
  );
}

export function upsertAdvertisedProductMetrics(
  db: Db,
  rows: readonly AdvertisedProductMetricsRow[],
) {
  return batchUpsert(
    db,
    "advertised_product_metrics_daily",
    "profile_id, campaign_id, ad_group_id, ad_id, metric_date",
    "profile_id bigint, campaign_id text, ad_group_id text, ad_id text, metric_date date",
    "(profile_id, ad_id, metric_date)",
    rows,
    (row) => JSON.stringify([row.profileId, row.adId, row.metricDate]),
  );
}

export function upsertPlacementMetrics(
  db: Db,
  rows: readonly PlacementMetricsRow[],
) {
  return batchUpsert(
    db,
    "placement_metrics_daily",
    "profile_id, campaign_id, placement, metric_date",
    "profile_id bigint, campaign_id text, placement text, metric_date date",
    "(profile_id, campaign_id, placement, metric_date)",
    rows,
    (row) =>
      JSON.stringify([
        row.profileId,
        row.campaignId,
        row.placement,
        row.metricDate,
      ]),
  );
}

export interface MetricTotals {
  currency: string;
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  orders: number;
}

interface TotalsRow {
  currency: string;
  impressions: string;
  clicks: string;
  cost: string;
  sales: string;
  orders: string;
}

/**
 * Totals over a date range for a profile (dashboard summary). Aggregating
 * across currencies is refused with MixedCurrencyError; returns null when
 * there is no data in the range. `bookIds` (null or empty = no filter) keeps
 * only facts of campaigns with at least one ad group advertising any of the
 * selected books.
 */
export async function dashboardTotals(
  db: Db,
  profileId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<MetricTotals | null> {
  const result = await db.query<TotalsRow>(
    `select currency,
            sum(impressions)::text as impressions,
            sum(clicks)::text as clicks,
            sum(cost)::text as cost,
            sum(sales)::text as sales,
            sum(orders)::text as orders
     from campaign_metrics_daily m
     where m.profile_id = $1 and m.metric_date between $2 and $3
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from campaigns fc
         join ad_groups fg on fg.campaign_id = fc.id
         join ads fa
           on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
         join book_profile_links fb
           on fb.profile_id = fg.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fc.profile_id = m.profile_id
           and fc.amazon_campaign_id = m.campaign_id
           and fb.book_id = any($4)
       ))
     group by currency`,
    [profileId, dateStart, dateEnd, bookIds],
  );
  if (result.rows.length === 0) {
    return null;
  }
  if (result.rows.length > 1) {
    throw new MixedCurrencyError(result.rows.map((row) => row.currency));
  }
  const row = result.rows[0]!;
  return {
    currency: row.currency,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    cost: row.cost,
    sales: row.sales,
    orders: Number(row.orders),
  };
}
