import type { Db } from "../db.js";
import { fxRateJoins } from "./dashboard.js";

/**
 * Spend explorer queries (the /spend dashboard page): per-entity per-day
 * spend/sales/orders over a window, grouped by market, campaign, or search
 * term. Rows are keyed by (entity, parent, date, currency) at the finest
 * grain any consumer needs — campaign rows carry their market as `parent`,
 * search-term rows their campaign — so the read service can aggregate upward
 * for the breakdown tabs and nest downward for the treemap. Sales/orders use
 * the browser-facing 14-day click-attribution columns, matching the other
 * dashboard queries.
 */

export type SpendGrain = "market" | "campaign" | "searchTerm";

export interface SpendSeriesRow {
  /** Country code, Amazon campaign id, or the search term itself. */
  id: string;
  /** Display name (campaign name when synced, else the id). */
  name: string;
  /** Owning market (campaign grain) or campaign (search-term grain). */
  parent: string | null;
  date: string;
  spend: string;
  sales: string;
  orders: number;
  currency: string;
  /** True when a non-zero fact in this group lacked a covering fixing. */
  ratesMissing: boolean;
}

interface GrainShape {
  /** SELECT fragments producing entity_id/entity_name/parent_id. */
  keys: string;
  /** FROM + JOINs; the fact source is always aliased `m`. */
  source: string;
  groupBy: string;
}

const GRAINS: Record<SpendGrain, GrainShape> = {
  market: {
    keys: `p.country_code as entity_id,
           p.country_code as entity_name,
           null::text as parent_id`,
    source: `campaign_metrics_daily m
             join amazon_profiles p on p.id = m.profile_id`,
    groupBy: `p.country_code, m.metric_date, m.currency`,
  },
  campaign: {
    keys: `m.campaign_id as entity_id,
           coalesce(max(c.name), m.campaign_id) as entity_name,
           min(p.country_code) as parent_id`,
    source: `campaign_metrics_daily m
             join amazon_profiles p on p.id = m.profile_id
             left join campaigns c
               on c.profile_id = m.profile_id
              and c.amazon_campaign_id = m.campaign_id`,
    groupBy: `m.campaign_id, m.metric_date, m.currency`,
  },
  searchTerm: {
    keys: `m.search_term as entity_id,
           m.search_term as entity_name,
           m.campaign_id as parent_id`,
    source: `search_term_metrics_daily m`,
    groupBy: `m.search_term, m.campaign_id, m.metric_date, m.currency`,
  },
};

interface RawSpendRow {
  entity_id: string;
  entity_name: string;
  parent_id: string | null;
  metric_date: string;
  spend: string | null;
  sales: string | null;
  orders: string | null;
  currency: string;
  rates_missing?: boolean;
}

function toRow(row: RawSpendRow, converted: boolean): SpendSeriesRow {
  return {
    id: row.entity_id,
    name: row.entity_name,
    parent: row.parent_id,
    date: row.metric_date,
    spend: row.spend ?? "0",
    sales: row.sales ?? "0",
    orders: Number(row.orders ?? 0),
    currency: row.currency,
    ratesMissing: converted ? (row.rates_missing ?? false) : false,
  };
}

/**
 * Native-currency spend series per entity and day for the given profiles.
 * Currencies are not mixed by the query — each group carries its own
 * currency and the caller refuses multi-currency results.
 */
export async function spendDailySeries(
  db: Db,
  grain: SpendGrain,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
): Promise<SpendSeriesRow[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const shape = GRAINS[grain];
  const result = await db.query<RawSpendRow>(
    `select ${shape.keys},
            m.metric_date::text as metric_date,
            sum(m.cost)::text as spend,
            sum(m.sales14d)::text as sales,
            sum(m.purchases14d)::text as orders,
            m.currency
     from ${shape.source}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
     group by ${shape.groupBy}
     order by ${shape.groupBy}`,
    [profilePks.map(String), dateStart, dateEnd],
  );
  return result.rows.map((row) => toRow(row, false));
}

/**
 * All-market variant: every fact converted into the display currency at its
 * own metric date's fixing through the USD pivot, exactly like the overview's
 * converting queries (docs/fx-rates-all-market-plan.md §4). A group whose
 * facts lack a covering fixing raises `ratesMissing` — never a silently
 * unconverted number.
 */
export async function convertedSpendDailySeries(
  db: Db,
  grain: SpendGrain,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  displayCurrency: string,
): Promise<SpendSeriesRow[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const shape = GRAINS[grain];
  const result = await db.query<RawSpendRow>(
    `select ${shape.keys},
            m.metric_date::text as metric_date,
            round(sum(m.cost * dr.rate / nr.rate), 4)::text as spend,
            round(sum(m.sales14d * dr.rate / nr.rate), 4)::text as sales,
            sum(m.purchases14d)::text as orders,
            min(m.currency) as currency,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null)
              and (m.cost <> 0 or m.sales14d <> 0)
            ), false) as rates_missing
     from ${shape.source}
     ${fxRateJoins(4)}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
     group by ${shape.groupBy}
     order by ${shape.groupBy}`,
    [profilePks.map(String), dateStart, dateEnd, displayCurrency],
  );
  return result.rows.map((row) => toRow(row, true));
}
