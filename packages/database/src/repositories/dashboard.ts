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
  currency: string;
  totals: TotalsRow;
  /** Null when activity exists but royalty economics are incomplete. */
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
  dataCurrentThrough: string | null;
  mixedCurrency: boolean;
}

/**
 * Campaigns of a workspace with metric totals and KDP royalty over a date
 * range. Profitability is calculated in one batched query so the campaigns
 * page does not issue one query per campaign.
 */
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
      currency: string;
      estimated_royalty: string | null;
      economics_missing: boolean;
      data_current_through: string | null;
      mixed_currency: boolean;
    }
  >(
    `with campaign_rollup as (
       select profile_id, campaign_id,
              sum(impressions)::text as impressions,
              sum(clicks)::text as clicks,
              sum(cost)::text as cost,
              sum(sales)::text as sales,
              sum(orders)::text as orders,
              min(currency)::text as currency,
              count(distinct currency) > 1 as mixed_currency,
              max(metric_date)::text as data_current_through
       from campaign_metrics_daily
       where metric_date between $2 and $3
       group by profile_id, campaign_id
     ),
     campaign_days as (
       select profile_id, campaign_id, metric_date,
              sum(orders) as orders,
              min(currency)::text as currency,
              count(distinct currency) > 1 as mixed_currency
       from campaign_metrics_daily
       where metric_date between $2 and $3
       group by profile_id, campaign_id, metric_date
     ),
     single_book_campaigns as (
       select c.profile_id, c.amazon_campaign_id as campaign_id,
              min(bpl.book_id) as book_id
       from campaigns c
       join ad_groups g on g.campaign_id = c.id
       join ads a on a.profile_id = c.profile_id and a.ad_group_id = g.id
       left join book_profile_links bpl
         on bpl.profile_id = c.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       group by c.profile_id, c.amazon_campaign_id
       having count(distinct bpl.book_id) = 1
          and count(*) filter (where bpl.book_id is null) = 0
     ),
     royalty_daily as (
       select m.profile_id, m.campaign_id, m.metric_date,
              sum(m.orders * economics.estimated_royalty_per_sale)
                as estimated_royalty,
              bool_or(economics.estimated_royalty_per_sale is null)
                as economics_missing,
              count(distinct m.currency) > 1 as mixed_currency
       from advertised_product_metrics_daily m
       left join ads a
         on a.profile_id = m.profile_id and a.amazon_ad_id = m.ad_id
       left join lateral (
         select be.estimated_royalty_per_sale
         from book_profile_links bpl
         join book_economics be
           on be.book_id = bpl.book_id and be.profile_id = bpl.profile_id
         where bpl.profile_id = m.profile_id
           and bpl.marketplace_asin = a.asin
           and bpl.enabled = true
           and be.currency = m.currency
           and be.effective_from <= m.metric_date
         order by be.effective_from desc, be.id desc
         limit 1
       ) economics on true
       where m.metric_date between $2 and $3
       group by m.profile_id, m.campaign_id, m.metric_date
     ),
     royalty_rollup as (
       select d.profile_id, d.campaign_id,
              bool_or(
                d.orders > 0
                and (
                  (r.metric_date is not null and r.economics_missing)
                  or (r.metric_date is null and fallback.royalty is null)
                )
              )
                as economics_missing,
              bool_or(
                d.mixed_currency or coalesce(r.mixed_currency, false)
              ) as mixed_currency,
              case
                when bool_or(
                  d.orders > 0
                  and (
                    (r.metric_date is not null and r.economics_missing)
                    or (r.metric_date is null and fallback.royalty is null)
                  )
                )
                  then null
                else coalesce(sum(
                  case
                    when d.orders = 0 then 0
                    when r.metric_date is not null then r.estimated_royalty
                    else d.orders * fallback.royalty
                  end
                ), 0)::text
              end as estimated_royalty
       from campaign_days d
       left join royalty_daily r
         on r.profile_id = d.profile_id
        and r.campaign_id = d.campaign_id
        and r.metric_date = d.metric_date
       left join single_book_campaigns sbc
         on sbc.profile_id = d.profile_id
        and sbc.campaign_id = d.campaign_id
       left join lateral (
         select be.estimated_royalty_per_sale as royalty
         from book_economics be
         where be.book_id = sbc.book_id
           and be.profile_id = d.profile_id
           and be.currency = d.currency
           and be.effective_from <= d.metric_date
         order by be.effective_from desc, be.id desc
         limit 1
       ) fallback on r.metric_date is null
       group by d.profile_id, d.campaign_id
     )
     select c.id, c.profile_id, p.profile_id as amazon_profile_id,
            c.amazon_campaign_id, c.name, c.state,
            cr.impressions, cr.clicks, cr.cost, cr.sales, cr.orders,
            coalesce(cr.currency, p.currency_code)::text as currency,
            rr.estimated_royalty,
            coalesce(rr.economics_missing, false) as economics_missing,
            cr.data_current_through,
            coalesce(cr.mixed_currency, false)
              or coalesce(rr.mixed_currency, false) as mixed_currency
     from campaigns c
     join amazon_profiles p on p.id = c.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     left join campaign_rollup cr
       on cr.profile_id = c.profile_id
      and cr.campaign_id = c.amazon_campaign_id
     left join royalty_rollup rr
       on rr.profile_id = c.profile_id
      and rr.campaign_id = c.amazon_campaign_id
     where conn.workspace_id = $1
     order by coalesce(cr.cost::numeric, 0) desc, c.id`,
    [workspaceId, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    campaignPk: row.id,
    profilePk: row.profile_id,
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id,
    name: row.name,
    state: row.state,
    currency: row.currency,
    totals: toTotals(row),
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
    dataCurrentThrough: row.data_current_through,
    mixedCurrency: row.mixed_currency,
  }));
}

export interface NamedMetricRowData {
  id: string;
  name: string;
  state: string;
  totals: TotalsRow;
}

export interface NegativeKeywordRowData {
  id: string;
  keywordText: string;
  matchType: string;
  level: "campaign" | "ad_group";
  adGroupId: string | null;
  adGroupName: string | null;
  state: string;
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

/** Current campaign- and ad-group-level negative keywords for a campaign. */
export async function listNegativeKeywordRows(
  db: Db,
  campaignPk: string,
): Promise<NegativeKeywordRowData[]> {
  const result = await db.query<{
    amazon_negative_keyword_id: string;
    keyword_text: string;
    match_type: string;
    amazon_ad_group_id: string | null;
    ad_group_name: string | null;
    state: string;
  }>(
    `select n.amazon_negative_keyword_id, n.keyword_text, n.match_type,
            g.amazon_ad_group_id, g.name as ad_group_name, n.state
     from negative_keywords n
     left join ad_groups g on g.id = n.ad_group_id
     where n.campaign_id = $1
     order by lower(n.keyword_text), n.id`,
    [campaignPk],
  );
  return result.rows.map((row) => ({
    id: row.amazon_negative_keyword_id,
    keywordText: row.keyword_text,
    matchType: row.match_type,
    level: row.amazon_ad_group_id === null ? "campaign" : "ad_group",
    adGroupId: row.amazon_ad_group_id,
    adGroupName: row.ad_group_name,
    state: row.state,
  }));
}

/**
 * Shared CTEs for the cross-campaign search-term screens. `st_daily` rolls
 * search-term facts up to term × campaign × ad group × day; royalty is then
 * attributed through the ad group's book exactly like single-book campaigns
 * (plan §9): only when every ad in the ad group maps to one book with
 * in-effect, currency-matching economics. $4 optionally pins one search term;
 * $5 optionally restricts the facts to ad groups advertising one book.
 */
const SEARCH_TERM_CTES = `with st_daily as (
       select m.profile_id, m.search_term, m.campaign_id, m.ad_group_id,
              m.metric_date,
              sum(m.impressions) as impressions,
              sum(m.clicks) as clicks,
              sum(m.cost) as cost,
              sum(m.sales) as sales,
              sum(m.orders) as orders,
              min(m.currency)::text as currency,
              count(distinct m.currency) > 1 as mixed_currency
       from search_term_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       where conn.workspace_id = $1
         and m.metric_date between $2 and $3
         and ($4::text is null or m.search_term = $4)
         and ($5::bigint is null or exists (
           select 1
           from ad_groups fg
           join ads fa
             on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
           join book_profile_links fb
             on fb.profile_id = fg.profile_id
            and fb.marketplace_asin = fa.asin
            and fb.enabled = true
           where fg.profile_id = m.profile_id
             and fg.amazon_ad_group_id = m.ad_group_id
             and fb.book_id = $5
         ))
       group by m.profile_id, m.search_term, m.campaign_id, m.ad_group_id,
                m.metric_date
     ),
     single_book_ad_groups as (
       select g.profile_id, g.amazon_ad_group_id, min(bpl.book_id) as book_id
       from ad_groups g
       join ads a on a.profile_id = g.profile_id and a.ad_group_id = g.id
       left join book_profile_links bpl
         on bpl.profile_id = g.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       group by g.profile_id, g.amazon_ad_group_id
       having count(distinct bpl.book_id) = 1
          and count(*) filter (where bpl.book_id is null) = 0
     ),
     royalty_daily as (
       select d.profile_id, d.search_term, d.campaign_id, d.ad_group_id,
              d.metric_date,
              d.orders * economics.estimated_royalty_per_sale
                as estimated_royalty
       from st_daily d
       join single_book_ad_groups s
         on s.profile_id = d.profile_id
        and s.amazon_ad_group_id = d.ad_group_id
       join lateral (
         select be.estimated_royalty_per_sale
         from book_economics be
         where be.book_id = s.book_id
           and be.profile_id = d.profile_id
           and be.currency = d.currency
           and be.effective_from <= d.metric_date
         order by be.effective_from desc, be.id desc
         limit 1
       ) economics on true
       where d.orders > 0
     )`;

export interface SearchTermRollupRowData {
  searchTerm: string;
  campaignCount: number;
  /** Distinct marketplace country codes contributing to the row, sorted. */
  countryCodes: string[];
  currency: string;
  totals: TotalsRow;
  /** Null when orders exist but royalty economics are incomplete. */
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
  dataCurrentThrough: string | null;
  mixedCurrency: boolean;
}

/**
 * Search terms aggregated across every campaign of the workspace, with KDP
 * royalty estimated per ad group (single-book attribution, as in
 * listCampaignRows). `estimatedRoyalty` is null for a term whenever any
 * campaign-day with orders lacks attributable economics — profit is never
 * guessed.
 */
export async function listSearchTermRollupRows(
  db: Db,
  workspaceId: string,
  dateStart: string,
  dateEnd: string,
  bookId: string | null = null,
): Promise<SearchTermRollupRowData[]> {
  const result = await db.query<
    RawTotals & {
      search_term: string;
      campaign_count: string;
      country_codes: string[];
      currency: string;
      estimated_royalty: string | null;
      economics_missing: boolean;
      data_current_through: string | null;
      mixed_currency: boolean;
    }
  >(
    `${SEARCH_TERM_CTES}
     select d.search_term,
            count(distinct (d.profile_id, d.campaign_id))::text as campaign_count,
            array_agg(distinct ap.country_code order by ap.country_code) as country_codes,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales)::text as sales,
            sum(d.orders)::text as orders,
            min(d.currency)::text as currency,
            bool_or(d.mixed_currency) as mixed_currency,
            max(d.metric_date)::text as data_current_through,
            bool_or(d.orders > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.orders > 0 and r.ad_group_id is null) then null
              else coalesce(sum(r.estimated_royalty), 0)::text
            end as estimated_royalty
     from st_daily d
     join amazon_profiles ap on ap.id = d.profile_id
     left join royalty_daily r
       on r.profile_id = d.profile_id
      and r.search_term = d.search_term
      and r.campaign_id = d.campaign_id
      and r.ad_group_id = d.ad_group_id
      and r.metric_date = d.metric_date
     group by d.search_term
     order by sum(d.cost) desc, d.search_term`,
    [workspaceId, dateStart, dateEnd, null, bookId],
  );
  return result.rows.map((row) => ({
    searchTerm: row.search_term,
    campaignCount: Number(row.campaign_count),
    countryCodes: row.country_codes,
    currency: row.currency,
    totals: toTotals(row),
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
    dataCurrentThrough: row.data_current_through,
    mixedCurrency: row.mixed_currency,
  }));
}

export interface SearchTermCampaignRowData {
  amazonProfileId: string;
  amazonCampaignId: string;
  name: string;
  state: string;
  currency: string;
  totals: TotalsRow;
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
  dataCurrentThrough: string | null;
  mixedCurrency: boolean;
}

/** Per-campaign breakdown for one shopper search term (drill-down). */
export async function listSearchTermCampaignRows(
  db: Db,
  workspaceId: string,
  searchTerm: string,
  dateStart: string,
  dateEnd: string,
  bookId: string | null = null,
): Promise<SearchTermCampaignRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_profile_id: string;
      amazon_campaign_id: string;
      name: string;
      state: string;
      currency: string;
      estimated_royalty: string | null;
      economics_missing: boolean;
      data_current_through: string | null;
      mixed_currency: boolean;
    }
  >(
    `${SEARCH_TERM_CTES}
     select p.profile_id as amazon_profile_id,
            d.campaign_id as amazon_campaign_id,
            c.name, c.state,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales)::text as sales,
            sum(d.orders)::text as orders,
            min(d.currency)::text as currency,
            bool_or(d.mixed_currency) as mixed_currency,
            max(d.metric_date)::text as data_current_through,
            bool_or(d.orders > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.orders > 0 and r.ad_group_id is null) then null
              else coalesce(sum(r.estimated_royalty), 0)::text
            end as estimated_royalty
     from st_daily d
     join campaigns c
       on c.profile_id = d.profile_id and c.amazon_campaign_id = d.campaign_id
     join amazon_profiles p on p.id = d.profile_id
     left join royalty_daily r
       on r.profile_id = d.profile_id
      and r.search_term = d.search_term
      and r.campaign_id = d.campaign_id
      and r.ad_group_id = d.ad_group_id
      and r.metric_date = d.metric_date
     group by p.profile_id, d.campaign_id, c.name, c.state
     order by sum(d.cost) desc, d.campaign_id`,
    [workspaceId, dateStart, dateEnd, searchTerm, bookId],
  );
  return result.rows.map((row) => ({
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id,
    name: row.name,
    state: row.state,
    currency: row.currency,
    totals: toTotals(row),
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
    dataCurrentThrough: row.data_current_through,
    mixedCurrency: row.mixed_currency,
  }));
}

export interface CampaignDailyPoint {
  date: string;
  cost: string;
  sales: string;
  orders: number;
  currency: string;
  /** Null when an advertised book has no in-effect KDP economics. */
  estimatedRoyalty: string | null;
}

/**
 * Daily performance and estimated KDP royalty for one campaign. Campaign
 * spend/sales remain sourced from the canonical campaign report. Royalty is
 * attributed at advertised-product grain so campaigns containing multiple
 * books use each book's own effective-dated economics. When Amazon's product
 * report omits a day for a campaign whose current ads all map to one book, the
 * campaign orders use that single book's in-effect royalty as a safe fallback.
 */
export async function campaignDailySeries(
  db: Db,
  profilePk: string,
  amazonCampaignId: string,
  dateStart: string,
  dateEnd: string,
): Promise<CampaignDailyPoint[]> {
  const result = await db.query<{
    metric_date: string;
    cost: string;
    sales: string;
    orders: string;
    currency: string;
    estimated_royalty: string | null;
  }>(
    `with campaign_daily as (
       select metric_date, sum(cost)::text as cost, sum(sales)::text as sales,
              sum(orders) as orders, currency
       from campaign_metrics_daily
       where profile_id = $1 and campaign_id = $2
         and metric_date between $3 and $4
       group by metric_date, currency
     ),
     royalty_daily as (
       select m.metric_date,
              sum(m.orders * economics.estimated_royalty_per_sale)::text
                as estimated_royalty,
              bool_or(economics.estimated_royalty_per_sale is null)
                as economics_missing
       from advertised_product_metrics_daily m
       left join ads a
         on a.profile_id = m.profile_id and a.amazon_ad_id = m.ad_id
       left join lateral (
         select be.estimated_royalty_per_sale
         from book_profile_links bpl
         join book_economics be
           on be.book_id = bpl.book_id and be.profile_id = bpl.profile_id
         where bpl.profile_id = m.profile_id
           and bpl.marketplace_asin = a.asin
           and bpl.enabled = true
           and be.currency = m.currency
           and be.effective_from <= m.metric_date
         order by be.effective_from desc, be.id desc
         limit 1
       ) economics on true
       where m.profile_id = $1 and m.campaign_id = $2
         and m.metric_date between $3 and $4
       group by m.metric_date
     ),
     single_book_campaign as (
       select min(bpl.book_id) as book_id
       from campaigns campaign
       join ad_groups g on g.campaign_id = campaign.id
       join ads a
         on a.profile_id = campaign.profile_id and a.ad_group_id = g.id
       left join book_profile_links bpl
         on bpl.profile_id = campaign.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       where campaign.profile_id = $1
         and campaign.amazon_campaign_id = $2
       group by campaign.id
       having count(distinct bpl.book_id) = 1
          and count(*) filter (where bpl.book_id is null) = 0
     )
     select c.metric_date::text as metric_date, c.cost, c.sales,
            c.orders::text as orders,
            c.currency,
            case
              when c.orders = 0 then '0'
              when r.metric_date is not null and not r.economics_missing
                then coalesce(r.estimated_royalty, '0')
              when r.metric_date is null and fallback.royalty is not null
                then (c.orders * fallback.royalty)::text
              else null
            end as estimated_royalty
     from campaign_daily c
     left join royalty_daily r on r.metric_date = c.metric_date
     left join single_book_campaign sbc on true
     left join lateral (
       select be.estimated_royalty_per_sale as royalty
       from book_economics be
       where be.book_id = sbc.book_id
         and be.profile_id = $1
         and be.currency = c.currency
         and be.effective_from <= c.metric_date
       order by be.effective_from desc, be.id desc
       limit 1
     ) fallback on r.metric_date is null
     order by c.metric_date`,
    [profilePk, amazonCampaignId, dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    cost: row.cost,
    sales: row.sales,
    orders: Number(row.orders),
    currency: row.currency,
    estimatedRoyalty: row.estimated_royalty,
  }));
}

export interface DailyPoint {
  date: string;
  profilePk: string;
  cost: string;
  sales: string;
  orders: number;
  currency: string;
}

/**
 * Per-day cost/sales/orders for each given profile (trend chart). Rows remain
 * separate by profile so the caller can apply profile-specific royalty
 * economics before combining them. The caller must refuse to merge differing
 * currencies.
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
    profile_id: string;
    cost: string;
    sales: string;
    orders: string;
    currency: string;
  }>(
    `select metric_date::text as metric_date,
            profile_id::text as profile_id,
            sum(cost)::text as cost,
            sum(sales)::text as sales,
            sum(orders)::text as orders,
            currency
     from campaign_metrics_daily
     where profile_id = any($1::bigint[])
       and metric_date between $2 and $3
     group by metric_date, profile_id, currency
     order by metric_date, profile_id`,
    [profilePks.map(String), dateStart, dateEnd],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    profilePk: row.profile_id,
    cost: row.cost,
    sales: row.sales,
    orders: Number(row.orders),
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
