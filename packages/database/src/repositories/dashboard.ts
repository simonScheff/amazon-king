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
  units: number;
}

interface RawTotals {
  impressions: string | null;
  clicks: string | null;
  cost: string | null;
  sales: string | null;
  orders: string | null;
  units: string | null;
}

function toTotals(row: RawTotals): TotalsRow {
  return {
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    cost: row.cost ?? "0",
    sales: row.sales ?? "0",
    orders: Number(row.orders ?? 0),
    units: Number(row.units ?? 0),
  };
}

/**
 * SQL fragment for the number of copies a royalty is earned on, on the
 * browser-facing 14-day click-attribution window (matching the Amazon Ads
 * console). KDP pays per copy, so a single order of three copies earns three
 * royalties and `purchases14d` alone undercounts it. `units_sold_clicks14d`
 * arrived later than `purchases14d` (migration 0010) and stays 0 on facts
 * imported before it; since Amazon never reports fewer units than orders,
 * taking the greater of the two degrades to orders on those rows instead of
 * reporting no royalty at all.
 *
 * Exported for the other browser-facing per-copy queries (KDP sales history)
 * so the convention cannot drift.
 */
export function royaltyCopies(alias: string): string {
  return `greatest(${alias}.units_sold_clicks14d, ${alias}.purchases14d)`;
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
  /** Owner-configured campaign-wide CPC ceiling; null when not configured. */
  maxCpc: string | null;
  economicsMissing: boolean;
  dataCurrentThrough: string | null;
  mixedCurrency: boolean;
  /** Distinct catalog books advertised by this campaign; empty if unmapped. */
  bookIds: string[];
}

/**
 * Campaigns of a workspace with metric totals and KDP royalty over a date
 * range. Profitability is calculated in one batched query so the campaigns
 * page does not issue one query per campaign. `bookIds` (null or empty = no
 * filter) keeps only campaigns with at least one ad group advertising any of
 * the selected books; the royalty CTEs are computed per campaign, so they
 * stay consistent with the filtered rows.
 */
export async function listCampaignRows(
  db: Db,
  workspaceId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
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
      max_cpc: string | null;
      economics_missing: boolean;
      data_current_through: string | null;
      mixed_currency: boolean;
      book_ids: string[];
    }
  >(
    `with campaign_rollup as (
       select profile_id, campaign_id,
              sum(impressions)::text as impressions,
              sum(clicks)::text as clicks,
              sum(cost)::text as cost,
              sum(sales14d)::text as sales,
              sum(purchases14d)::text as orders,
              sum(units_sold_clicks14d)::text as units,
              min(currency)::text as currency,
              count(distinct currency) > 1 as mixed_currency,
              max(metric_date)::text as data_current_through
       from campaign_metrics_daily
       where metric_date between $2 and $3
       group by profile_id, campaign_id
     ),
     campaign_days as (
       select profile_id, campaign_id, metric_date,
              sum(purchases14d) as purchases14d,
              sum(units_sold_clicks14d) as units_sold_clicks14d,
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
              sum(${royaltyCopies("m")} * economics.estimated_royalty_per_sale)
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
                d.purchases14d > 0
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
                  d.purchases14d > 0
                  and (
                    (r.metric_date is not null and r.economics_missing)
                    or (r.metric_date is null and fallback.royalty is null)
                  )
                )
                  then null
                else coalesce(sum(
                  case
                    when d.purchases14d = 0 then 0
                    when r.metric_date is not null then r.estimated_royalty
                    else ${royaltyCopies("d")} * fallback.royalty
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
     ),
     campaign_books as (
       select c.profile_id, c.amazon_campaign_id as campaign_id,
              array_agg(distinct bpl.book_id::text order by bpl.book_id::text)
                as book_ids
       from campaigns c
       join ad_groups g on g.campaign_id = c.id
       join ads a on a.profile_id = c.profile_id and a.ad_group_id = g.id
       join book_profile_links bpl
         on bpl.profile_id = c.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       group by c.profile_id, c.amazon_campaign_id
     )
     select c.id, c.profile_id, p.profile_id as amazon_profile_id,
            c.amazon_campaign_id, c.name, c.state,
            cr.impressions, cr.clicks, cr.cost, cr.sales, cr.orders, cr.units,
            coalesce(cr.currency, p.currency_code)::text as currency,
            rr.estimated_royalty,
            policy.max_cpc::text as max_cpc,
            coalesce(rr.economics_missing, false) as economics_missing,
            cr.data_current_through,
            coalesce(cr.mixed_currency, false)
              or coalesce(rr.mixed_currency, false) as mixed_currency,
            coalesce(cb.book_ids, '{}'::text[]) as book_ids
     from campaigns c
     join amazon_profiles p on p.id = c.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     left join campaign_rollup cr
       on cr.profile_id = c.profile_id
      and cr.campaign_id = c.amazon_campaign_id
     left join royalty_rollup rr
       on rr.profile_id = c.profile_id
      and rr.campaign_id = c.amazon_campaign_id
     left join campaign_books cb
       on cb.profile_id = c.profile_id
      and cb.campaign_id = c.amazon_campaign_id
     left join campaign_bid_policies policy on policy.campaign_id = c.id
     where conn.workspace_id = $1
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from ad_groups fg
         join ads fa
           on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
         join book_profile_links fb
           on fb.profile_id = fg.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fg.campaign_id = c.id
           and fb.book_id = any($4)
       ))
     order by coalesce(cr.cost::numeric, 0) desc, c.id`,
    [workspaceId, dateStart, dateEnd, bookIds],
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
    maxCpc: row.max_cpc,
    economicsMissing: row.economics_missing,
    dataCurrentThrough: row.data_current_through,
    mixedCurrency: row.mixed_currency,
    bookIds: row.book_ids ?? [],
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
  /** First-seen timestamp: apply date for app-created negatives, first sync otherwise. */
  firstSeenAt: string;
}

export interface NegativeTargetRowData {
  id: string;
  asin: string;
  targetType: "ASIN_SAME_AS";
  level: "campaign" | "ad_group";
  adGroupId: string | null;
  adGroupName: string | null;
  state: string;
  /** First-seen timestamp: apply date for app-created negatives, first sync otherwise. */
  firstSeenAt: string;
}

/**
 * Ad groups of a campaign with totals aggregated from target-grain facts.
 * `bookIds` (null or empty = no filter) keeps only ad groups advertising any
 * of the selected books.
 */
export async function listAdGroupRows(
  db: Db,
  campaignPk: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
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
            sum(m.sales14d)::text as sales,
            sum(m.purchases14d)::text as orders,
            sum(m.units_sold_clicks14d)::text as units
     from ad_groups g
     left join target_metrics_daily m
       on m.profile_id = g.profile_id
      and m.ad_group_id = g.amazon_ad_group_id
      and m.metric_date between $2 and $3
     where g.campaign_id = $1
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from ads fa
         join book_profile_links fb
           on fb.profile_id = fa.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fa.ad_group_id = g.id
           and fb.book_id = any($4)
       ))
     group by g.id
     order by coalesce(sum(m.cost), 0) desc, g.id`,
    [campaignPk, dateStart, dateEnd, bookIds],
  );
  return result.rows.map((row) => ({
    id: row.amazon_ad_group_id,
    name: row.name,
    state: row.state,
    totals: toTotals(row),
  }));
}

export interface TargetRowData extends NamedMetricRowData {
  kind: "keyword" | "product";
  /** Keyword targets only (exact/phrase/broad); null on product targets. */
  matchType: string | null;
  bid: string | null;
  /** Product targets only: the targeted ASIN; null on auto predicates. */
  asin: string | null;
}

/**
 * Labels for Amazon's automatic targeting predicates, which carry no
 * expression value — Amazon picks the queries/products. Keys cover both the
 * API enum names and the friendly names the demo seed uses.
 */
const AUTO_TARGET_LABELS: Record<string, string> = {
  QUERY_HIGH_REL_MATCHES: "Auto · close match",
  CLOSE_MATCH: "Auto · close match",
  QUERY_BROAD_REL_MATCHES: "Auto · loose match",
  LOOSE_MATCH: "Auto · loose match",
  ASIN_SUBSTITUTE_RELATED: "Auto · substitutes",
  SUBSTITUTES: "Auto · substitutes",
  ASIN_ACCESSORY_RELATED: "Auto · complements",
  COMPLEMENTS: "Auto · complements",
};

interface TargetPredicate {
  type: string;
  value?: string;
}

function toPredicate(raw: unknown): TargetPredicate | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  if (typeof record.value === "string") {
    return { type: record.type, value: record.value };
  }
  // The demo seed stores `{ type, values: [asin] }`.
  const values = record.values;
  if (Array.isArray(values) && typeof values[0] === "string") {
    return { type: record.type, value: values[0] };
  }
  return { type: record.type };
}

/**
 * Normalizes the stored `targets.expression` JSON into predicates. Shapes
 * differ by writer: structure sync stores keywords as
 * `{ type: "keyword", value }` and product targets as the raw Amazon clause
 * (`resolvedExpression` / `expression` arrays of `{ type, value }`), while
 * the demo seed stores bare arrays. Unknown shapes yield no predicates.
 */
function targetPredicates(expression: unknown): TargetPredicate[] {
  let list: unknown;
  if (Array.isArray(expression)) {
    list = expression;
  } else if (expression && typeof expression === "object") {
    const record = expression as Record<string, unknown>;
    list =
      record.resolvedExpression ??
      record.expression ??
      (typeof record.type === "string" ? [expression] : []);
  }
  if (!Array.isArray(list)) return [];
  return list
    .map(toPredicate)
    .filter((predicate): predicate is TargetPredicate => predicate !== null);
}

/**
 * Derives the human-readable target identity from its stored expression:
 * the keyword text for keywords, the targeted ASIN for product targets, an
 * "Auto · …" label for automatic predicates. Falls back to the match type /
 * target kind (the historical name) when the expression is unrecognized.
 */
export function describeTarget(
  targetKind: string,
  matchType: string | null,
  expression: unknown,
): { name: string; asin: string | null } {
  const fallback = matchType ?? targetKind;
  const predicates = targetPredicates(expression);
  if (targetKind === "keyword") {
    const keyword = predicates.find(
      (predicate) =>
        predicate.type.toLowerCase() === "keyword" && predicate.value,
    );
    return { name: keyword?.value ?? fallback, asin: null };
  }
  const valued = predicates.find((predicate) => predicate.value);
  if (valued?.value) return { name: valued.value, asin: valued.value };
  for (const predicate of predicates) {
    const label = AUTO_TARGET_LABELS[predicate.type.toUpperCase()];
    if (label) return { name: label, asin: null };
  }
  return { name: fallback, asin: null };
}

/**
 * Targets (keywords/product targets) of a campaign with metric totals.
 * `bookIds` (null or empty = no filter) keeps only targets whose ad group
 * advertises any of the selected books.
 */
export async function listTargetRows(
  db: Db,
  campaignPk: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<TargetRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_target_id: string;
      target_kind: string;
      match_type: string | null;
      bid: string | null;
      expression: unknown;
      state: string;
    }
  >(
    `select t.amazon_target_id,
            t.target_kind,
            t.match_type,
            t.bid::text as bid,
            t.expression,
            t.state,
            sum(m.impressions)::text as impressions,
            sum(m.clicks)::text as clicks,
            sum(m.cost)::text as cost,
            sum(m.sales14d)::text as sales,
            sum(m.purchases14d)::text as orders,
            sum(m.units_sold_clicks14d)::text as units
     from targets t
     left join target_metrics_daily m
       on m.profile_id = t.profile_id
      and m.target_id = t.amazon_target_id
      and m.metric_date between $2 and $3
     where t.campaign_id = $1
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from ads fa
         join book_profile_links fb
           on fb.profile_id = fa.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fa.ad_group_id = t.ad_group_id
           and fb.book_id = any($4)
       ))
     group by t.id
     order by coalesce(sum(m.cost), 0) desc, t.id`,
    [campaignPk, dateStart, dateEnd, bookIds],
  );
  return result.rows.map((row) => {
    const { name, asin } = describeTarget(
      row.target_kind,
      row.match_type,
      row.expression,
    );
    return {
      id: row.amazon_target_id,
      name,
      state: row.state,
      kind: (row.target_kind === "keyword" ? "keyword" : "product") as
        "keyword" | "product",
      matchType: row.match_type,
      bid: row.bid,
      asin,
      totals: toTotals(row),
    };
  });
}

export interface SearchTermRowData extends NamedMetricRowData {
  /** Null when orders exist but royalty economics are incomplete. */
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
}

/**
 * Search terms of a campaign with metric totals (search terms have no state)
 * and KDP royalty estimated per ad group (single-book attribution, as in
 * listCampaignRows): only when every ad in the ad group maps to one book with
 * in-effect, currency-matching economics. `estimatedRoyalty` is null for a
 * term whenever any ad-group-day with orders lacks attributable economics —
 * profit is never guessed. `bookIds` (null or empty = no filter) keeps only
 * facts whose ad group advertises any of the selected books.
 */
export async function listSearchTermRows(
  db: Db,
  profilePk: string,
  amazonCampaignId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<SearchTermRowData[]> {
  const result = await db.query<
    RawTotals & {
      search_term: string;
      estimated_royalty: string | null;
      economics_missing: boolean;
    }
  >(
    `with st_daily as (
       select m.ad_group_id, m.search_term, m.metric_date,
              sum(m.impressions) as impressions,
              sum(m.clicks) as clicks,
              sum(m.cost) as cost,
              sum(m.sales14d) as sales14d,
              sum(m.purchases14d) as purchases14d,
              sum(m.units_sold_clicks14d) as units_sold_clicks14d,
              min(m.currency)::text as currency
       from search_term_metrics_daily m
       where m.profile_id = $1 and m.campaign_id = $2
         and m.metric_date between $3 and $4
         and (coalesce(cardinality($5::bigint[]), 0) = 0 or exists (
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
             and fb.book_id = any($5)
         ))
       group by m.ad_group_id, m.search_term, m.metric_date
     ),
     single_book_ad_groups as (
       select g.amazon_ad_group_id, min(bpl.book_id) as book_id
       from ad_groups g
       join ads a on a.profile_id = g.profile_id and a.ad_group_id = g.id
       left join book_profile_links bpl
         on bpl.profile_id = g.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       where g.profile_id = $1
       group by g.amazon_ad_group_id
       having count(distinct bpl.book_id) = 1
          and count(*) filter (where bpl.book_id is null) = 0
     ),
     royalty_daily as (
       select d.ad_group_id, d.search_term, d.metric_date,
              ${royaltyCopies("d")} * economics.estimated_royalty_per_sale
                as estimated_royalty
       from st_daily d
       join single_book_ad_groups s
         on s.amazon_ad_group_id = d.ad_group_id
       join lateral (
         select be.estimated_royalty_per_sale
         from book_economics be
         where be.book_id = s.book_id
           and be.profile_id = $1
           and be.currency = d.currency
           and be.effective_from <= d.metric_date
         order by be.effective_from desc, be.id desc
         limit 1
       ) economics on true
       where d.purchases14d > 0
     )
     select d.search_term,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            sum(d.units_sold_clicks14d)::text as units,
            bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
              else coalesce(sum(r.estimated_royalty), 0)::text
            end as estimated_royalty
     from st_daily d
     left join royalty_daily r
       on r.ad_group_id = d.ad_group_id
      and r.search_term = d.search_term
      and r.metric_date = d.metric_date
     group by d.search_term
     order by sum(d.cost) desc, d.search_term`,
    [profilePk, amazonCampaignId, dateStart, dateEnd, bookIds],
  );
  return result.rows.map((row) => ({
    id: row.search_term,
    name: row.search_term,
    state: "n/a",
    totals: toTotals(row),
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
  }));
}

/**
 * Current campaign- and ad-group-level negative keywords for a campaign.
 * `bookIds` (null or empty = no filter) keeps a negative only when its scope
 * advertises any of the selected books: ad-group-level negatives follow their
 * ad group, campaign-level negatives follow the whole campaign.
 */
export async function listNegativeKeywordRows(
  db: Db,
  campaignPk: string,
  bookIds: bigint[] | null = null,
): Promise<NegativeKeywordRowData[]> {
  const result = await db.query<{
    amazon_negative_keyword_id: string;
    keyword_text: string;
    match_type: string;
    amazon_ad_group_id: string | null;
    ad_group_name: string | null;
    state: string;
    created_at: string;
  }>(
    `select n.amazon_negative_keyword_id, n.keyword_text, n.match_type,
            g.amazon_ad_group_id, g.name as ad_group_name, n.state,
            n.created_at
     from negative_keywords n
     left join ad_groups g on g.id = n.ad_group_id
     where n.campaign_id = $1
       and lower(n.state) <> 'deleted'
       and (coalesce(cardinality($2::bigint[]), 0) = 0 or exists (
         select 1
         from ad_groups fg
         join ads fa
           on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
         join book_profile_links fb
           on fb.profile_id = fg.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fb.book_id = any($2)
           and (
             fg.id = n.ad_group_id
             or (n.ad_group_id is null and fg.campaign_id = n.campaign_id)
           )
       ))
     order by lower(n.keyword_text), n.id`,
    [campaignPk, bookIds],
  );
  return result.rows.map((row) => ({
    id: row.amazon_negative_keyword_id,
    keywordText: row.keyword_text,
    matchType: row.match_type,
    level: row.amazon_ad_group_id === null ? "campaign" : "ad_group",
    adGroupId: row.amazon_ad_group_id,
    adGroupName: row.ad_group_name,
    state: row.state,
    firstSeenAt: row.created_at,
  }));
}

/**
 * Current campaign- and ad-group-level negative product targets for a campaign.
 * `bookIds` (null or empty = no filter) keeps a negative only when its scope
 * advertises any of the selected books, matching `listNegativeKeywordRows`.
 */
export async function listNegativeTargetRows(
  db: Db,
  campaignPk: string,
  bookIds: bigint[] | null = null,
): Promise<NegativeTargetRowData[]> {
  const result = await db.query<{
    amazon_negative_target_id: string;
    expression_asin: string;
    amazon_ad_group_id: string | null;
    ad_group_name: string | null;
    state: string;
    created_at: string;
  }>(
    `select n.amazon_negative_target_id, n.expression_asin,
            g.amazon_ad_group_id, g.name as ad_group_name, n.state,
            n.created_at
     from negative_targets n
     left join ad_groups g on g.id = n.ad_group_id
     where n.campaign_id = $1
       and lower(n.state) <> 'deleted'
       and (coalesce(cardinality($2::bigint[]), 0) = 0 or exists (
         select 1
         from ad_groups fg
         join ads fa
           on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
         join book_profile_links fb
           on fb.profile_id = fg.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fb.book_id = any($2)
           and (
             fg.id = n.ad_group_id
             or (n.ad_group_id is null and fg.campaign_id = n.campaign_id)
           )
       ))
     order by lower(n.expression_asin), n.id`,
    [campaignPk, bookIds],
  );
  return result.rows.map((row) => ({
    id: row.amazon_negative_target_id,
    asin: row.expression_asin,
    targetType: "ASIN_SAME_AS",
    level: row.amazon_ad_group_id === null ? "campaign" : "ad_group",
    adGroupId: row.amazon_ad_group_id,
    adGroupName: row.ad_group_name,
    state: row.state,
    firstSeenAt: row.created_at,
  }));
}

/**
 * Shared CTEs for the cross-campaign search-term screens. `st_daily` rolls
 * search-term facts up to term × campaign × ad group × day; royalty is then
 * attributed through the ad group's book exactly like single-book campaigns
 * (plan §9): only when every ad in the ad group maps to one book with
 * in-effect, currency-matching economics. $4 optionally pins one search term;
 * $5 optionally restricts the facts to ad groups advertising any of the
 * selected books (null or empty array = no filter); $6 optionally restricts
 * them to one marketplace country code.
 */
const SEARCH_TERM_CTES = `with st_daily as (
       select m.profile_id, m.search_term, m.campaign_id, m.ad_group_id,
              m.metric_date,
              sum(m.impressions) as impressions,
              sum(m.clicks) as clicks,
              sum(m.cost) as cost,
              sum(m.sales14d) as sales14d,
              sum(m.purchases14d) as purchases14d,
              sum(m.units_sold_clicks14d) as units_sold_clicks14d,
              min(m.currency)::text as currency,
              count(distinct m.currency) > 1 as mixed_currency
       from search_term_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       where conn.workspace_id = $1
         and m.metric_date between $2 and $3
         and ($4::text is null or m.search_term = $4)
         and ($6::text is null or p.country_code = $6)
         and (coalesce(cardinality($5::bigint[]), 0) = 0 or exists (
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
             and fb.book_id = any($5)
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
              ${royaltyCopies("d")} * economics.estimated_royalty_per_sale
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
       where d.purchases14d > 0
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
  /** Distinct catalog books whose ad groups contributed to this term. */
  bookIds: string[];
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
  bookIds: bigint[] | null = null,
  countryCode: string | null = null,
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
      book_ids: string[];
    }
  >(
    `${SEARCH_TERM_CTES},
     term_books as (
       select d.search_term,
              array_agg(distinct bpl.book_id::text order by bpl.book_id::text)
                as book_ids
       from (select distinct profile_id, search_term, ad_group_id from st_daily) d
       join ad_groups g
         on g.profile_id = d.profile_id
        and g.amazon_ad_group_id = d.ad_group_id
       join ads a
         on a.profile_id = g.profile_id and a.ad_group_id = g.id
       join book_profile_links bpl
         on bpl.profile_id = g.profile_id
        and bpl.marketplace_asin = a.asin
        and bpl.enabled = true
       group by d.search_term
     )
     select d.search_term,
            count(distinct (d.profile_id, d.campaign_id))::text as campaign_count,
            array_agg(distinct ap.country_code order by ap.country_code) as country_codes,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            sum(d.units_sold_clicks14d)::text as units,
            min(d.currency)::text as currency,
            bool_or(d.mixed_currency) as mixed_currency,
            max(d.metric_date)::text as data_current_through,
            bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
              else coalesce(sum(r.estimated_royalty), 0)::text
            end as estimated_royalty,
            coalesce(tb.book_ids, '{}'::text[]) as book_ids
     from st_daily d
     join amazon_profiles ap on ap.id = d.profile_id
     left join royalty_daily r
       on r.profile_id = d.profile_id
      and r.search_term = d.search_term
      and r.campaign_id = d.campaign_id
      and r.ad_group_id = d.ad_group_id
      and r.metric_date = d.metric_date
     left join term_books tb on tb.search_term = d.search_term
     group by d.search_term, tb.book_ids
     order by sum(d.cost) desc, d.search_term`,
    [workspaceId, dateStart, dateEnd, null, bookIds, countryCode],
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
    bookIds: row.book_ids ?? [],
  }));
}

export interface SearchTermCampaignRowData {
  amazonProfileId: string;
  countryCode: string;
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
  bookIds: bigint[] | null = null,
): Promise<SearchTermCampaignRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_profile_id: string;
      country_code: string;
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
            p.country_code,
            d.campaign_id as amazon_campaign_id,
            c.name, c.state,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            sum(d.units_sold_clicks14d)::text as units,
            min(d.currency)::text as currency,
            bool_or(d.mixed_currency) as mixed_currency,
            max(d.metric_date)::text as data_current_through,
            bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
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
     group by p.profile_id, p.country_code, d.campaign_id, c.name, c.state
     order by sum(d.cost) desc, d.campaign_id`,
    [workspaceId, dateStart, dateEnd, searchTerm, bookIds, null],
  );
  return result.rows.map((row) => ({
    amazonProfileId: row.amazon_profile_id,
    countryCode: row.country_code,
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

export interface SearchTermPresenceRow {
  countryCode: string;
  currency: string;
  /** Latest metric date the term has any fact in this market, all-time. */
  lastMetricDate: string;
}

/**
 * All-time per-market presence for one shopper search term: which marketplaces
 * hold any facts for it, their currency, and the latest fact date. Backs the
 * search-term detail read when the selected window has no facts, so it can
 * tell "term never served" (null → 404) from "served, but not in this window"
 * (zeroed detail). Same exact term match and book-scope predicate as
 * listSearchTermCampaignRows, without the date window.
 */
export async function listSearchTermPresence(
  db: Db,
  workspaceId: string,
  searchTerm: string,
  bookIds: bigint[] | null = null,
): Promise<SearchTermPresenceRow[]> {
  const result = await db.query<{
    country_code: string;
    currency: string;
    last_metric_date: string;
  }>(
    `select p.country_code,
            min(m.currency)::text as currency,
            max(m.metric_date)::text as last_metric_date
     from search_term_metrics_daily m
     join amazon_profiles p on p.id = m.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1
       and m.search_term = $2
       and (coalesce(cardinality($3::bigint[]), 0) = 0 or exists (
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
           and fb.book_id = any($3)
       ))
     group by p.country_code
     order by p.country_code`,
    [workspaceId, searchTerm, bookIds],
  );
  return result.rows.map((row) => ({
    countryCode: row.country_code,
    currency: row.currency,
    lastMetricDate: row.last_metric_date,
  }));
}

export interface SearchTermServingCampaign {
  /** Internal amazon_profiles PK. */
  profilePk: string;
  /** Internal campaigns PK. */
  campaignPk: string;
}

/**
 * Campaigns that actually served a shopper term within the window — the
 * "did this campaign run the term" check behind all-market exclusion
 * drafting. Same fact source and campaign join as
 * listSearchTermCampaignRows, but matched case-insensitively against the
 * normalized (trimmed + lowercased) term, because the exclusion list keys on
 * the normalized form while fact casing follows the report.
 */
export async function listSearchTermServingCampaigns(
  db: Db,
  workspaceId: string,
  normalizedSearchTerm: string,
  dateStart: string,
  dateEnd: string,
): Promise<SearchTermServingCampaign[]> {
  const result = await db.query<{ profile_pk: string; campaign_pk: string }>(
    `select distinct m.profile_id::text as profile_pk, c.id::text as campaign_pk
     from search_term_metrics_daily m
     join campaigns c
       on c.profile_id = m.profile_id and c.amazon_campaign_id = m.campaign_id
     join amazon_profiles p on p.id = m.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1
       and m.metric_date between $2 and $3
       and lower(m.search_term) = $4`,
    [workspaceId, dateStart, dateEnd, normalizedSearchTerm],
  );
  return result.rows.map((row) => ({
    profilePk: row.profile_pk,
    campaignPk: row.campaign_pk,
  }));
}

export interface SearchTermDailyPoint {
  date: string;
  cost: string;
  sales: string;
  orders: number;
  currency: string;
  /** Null for a day when orders exist but royalty economics are incomplete. */
  estimatedRoyalty: string | null;
}

/**
 * Per-day cost/sales/orders and estimated KDP royalty for one search term in
 * one marketplace (trend chart on the search-term detail screen). Royalty is
 * attributed per ad group exactly like listSearchTermCampaignRows: a day's
 * royalty is null whenever any ad group with orders that day lacks in-effect
 * economics — profit is never guessed.
 */
export async function searchTermDailySeries(
  db: Db,
  workspaceId: string,
  searchTerm: string,
  countryCode: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<SearchTermDailyPoint[]> {
  const result = await db.query<{
    metric_date: string;
    cost: string;
    sales: string;
    orders: string;
    currency: string;
    estimated_royalty: string | null;
  }>(
    `${SEARCH_TERM_CTES}
     select d.metric_date::text as metric_date,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            min(d.currency)::text as currency,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
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
     where ap.country_code = $6
     group by d.metric_date
     order by d.metric_date`,
    [workspaceId, dateStart, dateEnd, searchTerm, bookIds, countryCode],
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

/** Collapse internal whitespace and lowercase so keyword/ASIN keys compare stably. */
const NEGATIVE_VALUE_KEY = (expr: string) =>
  `regexp_replace(lower(btrim(${expr})), '\\s+', ' ', 'g')`;

/**
 * Shared book-scope predicate for a negative row `n`: keep it when the
 * selected books are advertised in the negative's ad group, or anywhere in
 * the campaign for a campaign-level negative. Null/empty $N = no filter.
 */
function negativeBookScope(bookParam: number, alias = "n"): string {
  return `(coalesce(cardinality($${bookParam}::bigint[]), 0) = 0 or exists (
         select 1
         from ad_groups fg
         join ads fa
           on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
         join book_profile_links fb
           on fb.profile_id = fg.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fb.book_id = any($${bookParam})
           and (
             fg.id = ${alias}.ad_group_id
             or (${alias}.ad_group_id is null and fg.campaign_id = ${alias}.campaign_id)
           )
       ))`;
}

/**
 * Union of current (non-deleted) negative keywords and product targets for
 * a workspace. $1 workspace, $4 books, $5 country, $6 kind, $7 value_key.
 */
const NEGATIVE_STRUCTURE_CTE = `negatives as (
       select 'keyword'::text as kind,
              ${NEGATIVE_VALUE_KEY("n.keyword_text")} as value_key,
              n.keyword_text as value_display,
              n.match_type,
              n.state as negative_state,
              n.amazon_negative_keyword_id as amazon_negative_id,
              n.ad_group_id,
              n.campaign_id,
              n.profile_id,
              n.created_at,
              c.amazon_campaign_id,
              c.name as campaign_name,
              c.state as campaign_state,
              g.amazon_ad_group_id,
              g.name as ad_group_name,
              p.country_code,
              p.currency_code,
              p.profile_id as amazon_profile_id,
              lower(c.state) in ('enabled', 'active') as campaign_enabled,
              lower(n.state) in ('enabled', 'active') as negative_enabled
       from negative_keywords n
       join campaigns c on c.id = n.campaign_id
       join amazon_profiles p on p.id = n.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       left join ad_groups g on g.id = n.ad_group_id
       where conn.workspace_id = $1
         and lower(n.state) <> 'deleted'
         and ($5::text is null or p.country_code = $5)
         and ($6::text is null or $6 = 'keyword')
         and ($7::text is null or ${NEGATIVE_VALUE_KEY("n.keyword_text")} = $7)
         and ${negativeBookScope(4)}
       union all
       select 'product'::text,
              ${NEGATIVE_VALUE_KEY("n.expression_asin")},
              upper(btrim(n.expression_asin)),
              'ASIN_SAME_AS',
              n.state,
              n.amazon_negative_target_id,
              n.ad_group_id,
              n.campaign_id,
              n.profile_id,
              n.created_at,
              c.amazon_campaign_id,
              c.name,
              c.state,
              g.amazon_ad_group_id,
              g.name,
              p.country_code,
              p.currency_code,
              p.profile_id,
              lower(c.state) in ('enabled', 'active'),
              lower(n.state) in ('enabled', 'active')
       from negative_targets n
       join campaigns c on c.id = n.campaign_id
       join amazon_profiles p on p.id = n.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       left join ad_groups g on g.id = n.ad_group_id
       where conn.workspace_id = $1
         and lower(n.state) <> 'deleted'
         and n.expression_asin is not null
         and ($5::text is null or p.country_code = $5)
         and ($6::text is null or $6 = 'product')
         and ($7::text is null or ${NEGATIVE_VALUE_KEY("n.expression_asin")} = $7)
         and ${negativeBookScope(4)}
     )`;

export interface NegativePeriodTotalsData {
  totals: TotalsRow;
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
  mixedCurrency: boolean;
  currency: string | null;
}

export interface NegativeRollupRowData {
  kind: "keyword" | "product";
  value: string;
  valueKey: string;
  matchTypes: string[];
  countryCodes: string[];
  structureCurrency: string;
  structureMixedCurrency: boolean;
  bookIds: string[];
  catalogBookId: string | null;
  excludedEverywhere: boolean;
  firstSeenAt: string | Date;
  lastServedAt: string | null;
  blockingCampaignCount: number;
  pausedCampaignCount: number;
  window: NegativePeriodTotalsData;
  before: NegativePeriodTotalsData;
  dataCurrentThrough: string | null;
}

function emptyPeriod(currency: string | null): NegativePeriodTotalsData {
  return {
    totals: {
      impressions: 0,
      clicks: 0,
      cost: "0",
      sales: "0",
      orders: 0,
      units: 0,
    },
    estimatedRoyalty: "0",
    economicsMissing: false,
    mixedCurrency: false,
    currency,
  };
}

function periodFromAgg(
  row: RawTotals & {
    estimated_royalty: string | null;
    economics_missing: boolean | null;
    mixed_currency: boolean | null;
    currency: string | null;
  },
  fallbackCurrency: string,
): NegativePeriodTotalsData {
  if (row.currency === null && Number(row.impressions ?? 0) === 0) {
    return emptyPeriod(fallbackCurrency);
  }
  return {
    totals: toTotals(row),
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing ?? false,
    mixedCurrency: row.mixed_currency ?? false,
    currency: row.currency,
  };
}

/**
 * Unique negative keywords and product ASINs for a workspace, with serving
 * facts for the exact term/ASIN in the window and facts dated before we
 * first saw the negative. $6 kind and $7 value_key are optional pins.
 */
export async function listNegativeRollupRows(
  db: Db,
  workspaceId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
  countryCode: string | null = null,
  kind: "keyword" | "product" | null = null,
  valueKey: string | null = null,
): Promise<NegativeRollupRowData[]> {
  const result = await db.query<
    RawTotals & {
      kind: "keyword" | "product";
      value_key: string;
      value: string;
      match_types: string[];
      country_codes: string[];
      structure_currency: string;
      structure_mixed_currency: boolean;
      book_ids: string[];
      catalog_book_id: string | null;
      excluded_everywhere: boolean;
      first_seen_at: string | Date;
      last_served_at: string | null;
      blocking_campaign_count: string;
      paused_campaign_count: string;
      data_current_through: string | null;
      window_impressions: string | null;
      window_clicks: string | null;
      window_cost: string | null;
      window_sales: string | null;
      window_orders: string | null;
      window_units: string | null;
      window_currency: string | null;
      window_mixed_currency: boolean | null;
      window_estimated_royalty: string | null;
      window_economics_missing: boolean | null;
      before_impressions: string | null;
      before_clicks: string | null;
      before_cost: string | null;
      before_sales: string | null;
      before_orders: string | null;
      before_units: string | null;
      before_currency: string | null;
      before_mixed_currency: boolean | null;
      before_estimated_royalty: string | null;
      before_economics_missing: boolean | null;
    }
  >(
    `with ${NEGATIVE_STRUCTURE_CTE},
     grouped as (
       select n.kind, n.value_key,
              (array_agg(n.value_display order by n.created_at, n.amazon_negative_id))[1]
                as value,
              array_agg(distinct n.match_type order by n.match_type) as match_types,
              array_agg(distinct n.country_code order by n.country_code) as country_codes,
              min(n.currency_code) as structure_currency,
              count(distinct n.currency_code) > 1 as structure_mixed_currency,
              min(n.created_at) as first_seen_at,
              count(distinct n.campaign_id) filter (
                where n.campaign_enabled and n.negative_enabled
              )::text as blocking_campaign_count,
              (
                count(distinct n.campaign_id)
                - count(distinct n.campaign_id) filter (
                    where n.campaign_enabled and n.negative_enabled
                  )
              )::text as paused_campaign_count
       from negatives n
       group by n.kind, n.value_key
     ),
     term_books as (
       select n.kind, n.value_key,
              array_agg(distinct bpl.book_id::text order by bpl.book_id::text)
                as book_ids
       from (select distinct kind, value_key, profile_id, campaign_id, ad_group_id
             from negatives) n
       join ad_groups fg
         on fg.id = n.ad_group_id
         or (n.ad_group_id is null and fg.campaign_id = n.campaign_id)
       join ads fa
         on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
       join book_profile_links bpl
         on bpl.profile_id = fg.profile_id
        and bpl.marketplace_asin = fa.asin
        and bpl.enabled = true
       group by n.kind, n.value_key
     ),
     catalog as (
       select ${NEGATIVE_VALUE_KEY("bpl.marketplace_asin")} as value_key,
              min(bpl.book_id)::text as catalog_book_id
       from book_profile_links bpl
       join amazon_profiles p on p.id = bpl.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       where conn.workspace_id = $1 and bpl.enabled = true
       group by ${NEGATIVE_VALUE_KEY("bpl.marketplace_asin")}
     ),
     keys as (
       select distinct kind, value_key from grouped
     ),
     st_daily as (
       select k.kind, k.value_key, m.profile_id, m.search_term, m.campaign_id,
              m.ad_group_id, m.metric_date,
              sum(m.impressions) as impressions,
              sum(m.clicks) as clicks,
              sum(m.cost) as cost,
              sum(m.sales14d) as sales14d,
              sum(m.purchases14d) as purchases14d,
              sum(m.units_sold_clicks14d) as units_sold_clicks14d,
              min(m.currency)::text as currency,
              count(distinct m.currency) > 1 as mixed_currency
       from search_term_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       join keys k on k.value_key = ${NEGATIVE_VALUE_KEY("m.search_term")}
       where conn.workspace_id = $1
         and m.metric_date <= $3
         and ($5::text is null or p.country_code = $5)
         and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
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
             and fb.book_id = any($4)
         ))
       group by k.kind, k.value_key, m.profile_id, m.search_term, m.campaign_id,
                m.ad_group_id, m.metric_date
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
       select d.kind, d.value_key, d.profile_id, d.search_term, d.campaign_id,
              d.ad_group_id, d.metric_date,
              ${royaltyCopies("d")} * economics.estimated_royalty_per_sale
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
       where d.purchases14d > 0
     ),
     window_agg as (
       select d.kind, d.value_key,
              sum(d.impressions)::text as impressions,
              sum(d.clicks)::text as clicks,
              sum(d.cost)::text as cost,
              sum(d.sales14d)::text as sales,
              sum(d.purchases14d)::text as orders,
              sum(d.units_sold_clicks14d)::text as units,
              min(d.currency)::text as currency,
              bool_or(d.mixed_currency) as mixed_currency,
              max(d.metric_date)::text as data_current_through,
              bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
              case
                when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
                else coalesce(sum(r.estimated_royalty), 0)::text
              end as estimated_royalty
       from st_daily d
       left join royalty_daily r
         on r.kind = d.kind and r.value_key = d.value_key
        and r.profile_id = d.profile_id
        and r.search_term = d.search_term
        and r.campaign_id = d.campaign_id
        and r.ad_group_id = d.ad_group_id
        and r.metric_date = d.metric_date
       where d.metric_date between $2 and $3
       group by d.kind, d.value_key
     ),
     before_agg as (
       select d.kind, d.value_key,
              sum(d.impressions)::text as impressions,
              sum(d.clicks)::text as clicks,
              sum(d.cost)::text as cost,
              sum(d.sales14d)::text as sales,
              sum(d.purchases14d)::text as orders,
              sum(d.units_sold_clicks14d)::text as units,
              min(d.currency)::text as currency,
              bool_or(d.mixed_currency) as mixed_currency,
              bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
              case
                when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
                else coalesce(sum(r.estimated_royalty), 0)::text
              end as estimated_royalty
       from st_daily d
       join grouped g on g.kind = d.kind and g.value_key = d.value_key
       left join royalty_daily r
         on r.kind = d.kind and r.value_key = d.value_key
        and r.profile_id = d.profile_id
        and r.search_term = d.search_term
        and r.campaign_id = d.campaign_id
        and r.ad_group_id = d.ad_group_id
        and r.metric_date = d.metric_date
       where d.metric_date < (g.first_seen_at at time zone 'UTC')::date
       group by d.kind, d.value_key
     ),
     last_served as (
       select kind, value_key, max(metric_date)::text as last_served_at
       from st_daily
       group by kind, value_key
     )
     select g.kind, g.value_key, g.value, g.match_types, g.country_codes,
            g.structure_currency, g.structure_mixed_currency, g.first_seen_at,
            g.blocking_campaign_count, g.paused_campaign_count,
            coalesce(tb.book_ids, '{}'::text[]) as book_ids,
            case when g.kind = 'product' then cat.catalog_book_id else null end
              as catalog_book_id,
            exists (
              select 1 from search_term_exclusions e
              where e.workspace_id = $1 and e.search_term = g.value_key
            ) as excluded_everywhere,
            ls.last_served_at,
            coalesce(w.data_current_through, ls.last_served_at) as data_current_through,
            w.impressions as window_impressions,
            w.clicks as window_clicks,
            w.cost as window_cost,
            w.sales as window_sales,
            w.orders as window_orders,
            w.units as window_units,
            w.currency as window_currency,
            w.mixed_currency as window_mixed_currency,
            w.estimated_royalty as window_estimated_royalty,
            w.economics_missing as window_economics_missing,
            b.impressions as before_impressions,
            b.clicks as before_clicks,
            b.cost as before_cost,
            b.sales as before_sales,
            b.orders as before_orders,
            b.units as before_units,
            b.currency as before_currency,
            b.mixed_currency as before_mixed_currency,
            b.estimated_royalty as before_estimated_royalty,
            b.economics_missing as before_economics_missing
     from grouped g
     left join term_books tb
       on tb.kind = g.kind and tb.value_key = g.value_key
     left join catalog cat on cat.value_key = g.value_key
     left join window_agg w
       on w.kind = g.kind and w.value_key = g.value_key
     left join before_agg b
       on b.kind = g.kind and b.value_key = g.value_key
     left join last_served ls
       on ls.kind = g.kind and ls.value_key = g.value_key
     order by g.value`,
    [workspaceId, dateStart, dateEnd, bookIds, countryCode, kind, valueKey],
  );
  return result.rows.map((row) => {
    const structureCurrency = row.structure_currency;
    return {
      kind: row.kind,
      value: row.value,
      valueKey: row.value_key,
      matchTypes: row.match_types ?? [],
      countryCodes: row.country_codes ?? [],
      structureCurrency,
      structureMixedCurrency: row.structure_mixed_currency,
      bookIds: row.book_ids ?? [],
      catalogBookId: row.catalog_book_id,
      excludedEverywhere: row.excluded_everywhere,
      firstSeenAt: row.first_seen_at,
      lastServedAt: row.last_served_at,
      blockingCampaignCount: Number(row.blocking_campaign_count),
      pausedCampaignCount: Number(row.paused_campaign_count),
      window: periodFromAgg(
        {
          impressions: row.window_impressions,
          clicks: row.window_clicks,
          cost: row.window_cost,
          sales: row.window_sales,
          orders: row.window_orders,
          units: row.window_units,
          estimated_royalty: row.window_estimated_royalty,
          economics_missing: row.window_economics_missing,
          mixed_currency: row.window_mixed_currency,
          currency: row.window_currency,
        },
        structureCurrency,
      ),
      before: periodFromAgg(
        {
          impressions: row.before_impressions,
          clicks: row.before_clicks,
          cost: row.before_cost,
          sales: row.before_sales,
          orders: row.before_orders,
          units: row.before_units,
          estimated_royalty: row.before_estimated_royalty,
          economics_missing: row.before_economics_missing,
          mixed_currency: row.before_mixed_currency,
          currency: row.before_currency,
        },
        structureCurrency,
      ),
      dataCurrentThrough: row.data_current_through,
    };
  });
}

export interface NegativeSpecRowData {
  kind: "keyword" | "product";
  valueKey: string;
  amazonNegativeId: string;
  matchType: string;
  level: "campaign" | "ad_group";
  amazonAdGroupId: string | null;
  adGroupName: string | null;
  negativeState: string;
  firstSeenAt: string | Date;
  amazonProfileId: string;
  amazonCampaignId: string;
  campaignName: string;
  campaignState: string;
  countryCode: string;
  currency: string;
}

/** Every synced negative attachment matching the optional kind/value pin. */
export async function listNegativeSpecRows(
  db: Db,
  workspaceId: string,
  bookIds: bigint[] | null = null,
  countryCode: string | null = null,
  kind: "keyword" | "product" | null = null,
  valueKey: string | null = null,
): Promise<NegativeSpecRowData[]> {
  const result = await db.query<{
    kind: "keyword" | "product";
    value_key: string;
    amazon_negative_id: string;
    match_type: string;
    amazon_ad_group_id: string | null;
    ad_group_name: string | null;
    negative_state: string;
    created_at: string | Date;
    amazon_profile_id: string;
    amazon_campaign_id: string;
    campaign_name: string;
    campaign_state: string;
    country_code: string;
    currency_code: string;
  }>(
    `with ${NEGATIVE_STRUCTURE_CTE}
     select kind, value_key, amazon_negative_id, match_type,
            amazon_ad_group_id, ad_group_name, negative_state, created_at,
            amazon_profile_id, amazon_campaign_id, campaign_name, campaign_state,
            country_code, currency_code
     from negatives
     where ($2::date is null or $3::date is null or true)
     order by campaign_name, amazon_negative_id`,
    [workspaceId, null, null, bookIds, countryCode, kind, valueKey],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    valueKey: row.value_key,
    amazonNegativeId: row.amazon_negative_id,
    matchType: row.match_type,
    level: row.amazon_ad_group_id === null ? "campaign" : "ad_group",
    amazonAdGroupId: row.amazon_ad_group_id,
    adGroupName: row.ad_group_name,
    negativeState: row.negative_state,
    firstSeenAt: row.created_at,
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id,
    campaignName: row.campaign_name,
    campaignState: row.campaign_state,
    countryCode: row.country_code,
    currency: row.currency_code,
  }));
}

export interface NegativeServingRowData {
  kind: "keyword" | "product";
  valueKey: string;
  amazonProfileId: string;
  amazonCampaignId: string;
  amazonAdGroupId: string;
  campaignName: string;
  campaignState: string;
  countryCode: string;
  currency: string;
}

/**
 * Search-term facts in the window whose normalized term matches a synced
 * negative. Used with blockedCampaignIds to find coverage gaps.
 */
export async function listNegativeServingRows(
  db: Db,
  workspaceId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
  countryCode: string | null = null,
  kind: "keyword" | "product" | null = null,
  valueKey: string | null = null,
): Promise<NegativeServingRowData[]> {
  const result = await db.query<{
    kind: "keyword" | "product";
    value_key: string;
    amazon_profile_id: string;
    amazon_campaign_id: string;
    amazon_ad_group_id: string;
    campaign_name: string;
    campaign_state: string;
    country_code: string;
    currency: string;
  }>(
    `with ${NEGATIVE_STRUCTURE_CTE},
     keys as (select distinct kind, value_key from negatives)
     select distinct k.kind, k.value_key,
            p.profile_id as amazon_profile_id,
            m.campaign_id as amazon_campaign_id,
            m.ad_group_id as amazon_ad_group_id,
            c.name as campaign_name,
            c.state as campaign_state,
            p.country_code,
            m.currency
     from search_term_metrics_daily m
     join amazon_profiles p on p.id = m.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     join campaigns c
       on c.profile_id = m.profile_id and c.amazon_campaign_id = m.campaign_id
     join keys k on k.value_key = ${NEGATIVE_VALUE_KEY("m.search_term")}
     where conn.workspace_id = $1
       and m.metric_date between $2 and $3
       and ($5::text is null or p.country_code = $5)
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
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
           and fb.book_id = any($4)
       ))
     order by k.value_key, c.name, m.ad_group_id`,
    [workspaceId, dateStart, dateEnd, bookIds, countryCode, kind, valueKey],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    valueKey: row.value_key,
    amazonProfileId: row.amazon_profile_id,
    amazonCampaignId: row.amazon_campaign_id,
    amazonAdGroupId: row.amazon_ad_group_id,
    campaignName: row.campaign_name,
    campaignState: row.campaign_state,
    countryCode: row.country_code,
    currency: row.currency,
  }));
}

/**
 * Like SEARCH_TERM_CTES, but $4 is a normalized value key (lowercase, collapsed
 * whitespace) rather than a case-sensitive shopper-term string.
 */
const NEGATIVE_TERM_CTES = `with st_daily as (
       select m.profile_id, m.search_term, m.campaign_id, m.ad_group_id,
              m.metric_date,
              sum(m.impressions) as impressions,
              sum(m.clicks) as clicks,
              sum(m.cost) as cost,
              sum(m.sales14d) as sales14d,
              sum(m.purchases14d) as purchases14d,
              sum(m.units_sold_clicks14d) as units_sold_clicks14d,
              min(m.currency)::text as currency,
              count(distinct m.currency) > 1 as mixed_currency
       from search_term_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections conn on conn.id = p.connection_id
       where conn.workspace_id = $1
         and m.metric_date between $2 and $3
         and ${NEGATIVE_VALUE_KEY("m.search_term")} = $4
         and ($6::text is null or p.country_code = $6)
         and (coalesce(cardinality($5::bigint[]), 0) = 0 or exists (
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
             and fb.book_id = any($5)
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
              ${royaltyCopies("d")} * economics.estimated_royalty_per_sale
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
       where d.purchases14d > 0
     )`;

/** Per-campaign window metrics for one normalized negative value. */
export async function listNegativeTermCampaignRows(
  db: Db,
  workspaceId: string,
  valueKey: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<SearchTermCampaignRowData[]> {
  const result = await db.query<
    RawTotals & {
      amazon_profile_id: string;
      country_code: string;
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
    `${NEGATIVE_TERM_CTES}
     select p.profile_id as amazon_profile_id,
            p.country_code,
            d.campaign_id as amazon_campaign_id,
            c.name, c.state,
            sum(d.impressions)::text as impressions,
            sum(d.clicks)::text as clicks,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            sum(d.units_sold_clicks14d)::text as units,
            min(d.currency)::text as currency,
            bool_or(d.mixed_currency) as mixed_currency,
            max(d.metric_date)::text as data_current_through,
            bool_or(d.purchases14d > 0 and r.ad_group_id is null) as economics_missing,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
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
     group by p.profile_id, p.country_code, d.campaign_id, c.name, c.state
     order by sum(d.cost) desc, d.campaign_id`,
    [workspaceId, dateStart, dateEnd, valueKey, bookIds, null],
  );
  return result.rows.map((row) => ({
    amazonProfileId: row.amazon_profile_id,
    countryCode: row.country_code,
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

/** Daily series for one normalized negative value in one marketplace. */
export async function listNegativeDailySeries(
  db: Db,
  workspaceId: string,
  valueKey: string,
  countryCode: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<SearchTermDailyPoint[]> {
  const result = await db.query<{
    metric_date: string;
    cost: string;
    sales: string;
    orders: string;
    currency: string;
    estimated_royalty: string | null;
  }>(
    `${NEGATIVE_TERM_CTES}
     select d.metric_date::text as metric_date,
            sum(d.cost)::text as cost,
            sum(d.sales14d)::text as sales,
            sum(d.purchases14d)::text as orders,
            min(d.currency)::text as currency,
            case
              when bool_or(d.purchases14d > 0 and r.ad_group_id is null) then null
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
     where ap.country_code = $6
     group by d.metric_date
     order by d.metric_date`,
    [workspaceId, dateStart, dateEnd, valueKey, bookIds, countryCode],
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

/** Distinct shopper terms in the window whose normalized form contains `valueKey`. */
export async function listNegativeCandidateTerms(
  db: Db,
  workspaceId: string,
  valueKey: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
  countryCode: string | null = null,
  limit = 100,
): Promise<string[]> {
  const result = await db.query<{ search_term: string }>(
    `select distinct m.search_term
     from search_term_metrics_daily m
     join amazon_profiles p on p.id = m.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1
       and m.metric_date between $2 and $3
       and ${NEGATIVE_VALUE_KEY("m.search_term")} <> $4
       and ${NEGATIVE_VALUE_KEY("m.search_term")} like '%' || $4 || '%'
       and ($6::text is null or p.country_code = $6)
       and (coalesce(cardinality($5::bigint[]), 0) = 0 or exists (
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
           and fb.book_id = any($5)
       ))
     order by m.search_term
     limit $7`,
    [workspaceId, dateStart, dateEnd, valueKey, bookIds, countryCode, limit],
  );
  return result.rows.map((row) => row.search_term);
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
 * `bookIds` (null or empty = no filter) drops the campaign entirely unless at
 * least one of its ad groups advertises any of the selected books.
 */
export async function campaignDailySeries(
  db: Db,
  profilePk: string,
  amazonCampaignId: string,
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
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
       select metric_date, sum(cost)::text as cost,
              sum(sales14d)::text as sales,
              sum(purchases14d) as purchases14d,
              sum(units_sold_clicks14d) as units_sold_clicks14d, currency
       from campaign_metrics_daily
       where profile_id = $1 and campaign_id = $2
         and metric_date between $3 and $4
         and (coalesce(cardinality($5::bigint[]), 0) = 0 or exists (
           select 1
           from campaigns fc
           join ad_groups fg on fg.campaign_id = fc.id
           join ads fa
             on fa.profile_id = fg.profile_id and fa.ad_group_id = fg.id
           join book_profile_links fb
             on fb.profile_id = fg.profile_id
            and fb.marketplace_asin = fa.asin
            and fb.enabled = true
           where fc.profile_id = $1
             and fc.amazon_campaign_id = $2
             and fb.book_id = any($5)
         ))
       group by metric_date, currency
     ),
     royalty_daily as (
       select m.metric_date,
              sum(${royaltyCopies("m")} * economics.estimated_royalty_per_sale)::text
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
            c.purchases14d::text as orders,
            c.currency,
            case
              when c.purchases14d = 0 then '0'
              when r.metric_date is not null and not r.economics_missing
                then coalesce(r.estimated_royalty, '0')
              when r.metric_date is null and fallback.royalty is not null
                then (${royaltyCopies("c")} * fallback.royalty)::text
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
    [profilePk, amazonCampaignId, dateStart, dateEnd, bookIds],
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

export interface OverviewRoyaltyPoint {
  date: string;
  profilePk: string;
  currency: string;
  /** Null when any advertised order that day lacks in-effect book+market economics. */
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
}

/**
 * Estimated KDP royalty for the overview KPIs and trend chart. Each advertised
 * product's copies sold are valued with that book's economics for that
 * marketplace (profile) on that metric date — never one royalty for the whole
 * profile, and never a book's US royalty on a UK order. `bookIds` (null or
 * empty = no filter) keeps only facts whose ASIN is linked to one of the
 * selected books.
 * Callers must hide profit when `economicsMissing` is true rather than guess.
 */
export async function overviewRoyaltySeries(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
): Promise<OverviewRoyaltyPoint[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    metric_date: string;
    profile_id: string;
    currency: string;
    estimated_royalty: string | null;
    economics_missing: boolean;
  }>(
    `select m.metric_date::text as metric_date,
            m.profile_id::text as profile_id,
            m.currency,
            bool_or(m.purchases14d > 0 and economics.estimated_royalty_per_sale is null)
              as economics_missing,
            case
              when bool_or(
                m.purchases14d > 0 and economics.estimated_royalty_per_sale is null
              )
                then null
              else coalesce(
                sum(${royaltyCopies("m")} * economics.estimated_royalty_per_sale), 0
              )::text
            end as estimated_royalty
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
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from ads fa
         join book_profile_links fb
           on fb.profile_id = fa.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fa.profile_id = m.profile_id
           and fa.amazon_ad_id = m.ad_id
           and fb.book_id = any($4)
       ))
     group by m.metric_date, m.profile_id, m.currency
     order by m.metric_date, m.profile_id`,
    [profilePks.map(String), dateStart, dateEnd, bookIds],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    profilePk: row.profile_id,
    currency: row.currency,
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
  }));
}

/**
 * Per-day cost/sales/orders for each given profile (trend chart). Rows remain
 * separate by profile so the caller can merge them after checking currencies.
 * The caller must refuse to merge differing currencies. `bookIds` (null or
 * empty = no filter) keeps only facts of campaigns with at least one ad group
 * advertising any of the selected books.
 */
export async function dailySeries(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  bookIds: bigint[] | null = null,
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
            sum(sales14d)::text as sales,
            sum(purchases14d)::text as orders,
            currency
     from campaign_metrics_daily m
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
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
     group by metric_date, profile_id, currency
     order by metric_date, profile_id`,
    [profilePks.map(String), dateStart, dateEnd, bookIds],
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

/* ---------------------------------------------------------------------------
 * All-market converting queries (docs/fx-rates-all-market-plan.md §4).
 *
 * Used only for the dashboard's `country=all` view. Every monetary fact is
 * converted at the fixing of its own metric date (decision 2), cross-rated
 * through the USD pivot in SQL on `numeric` — never in floating point:
 * converted = amount * (pivot(display, D) / pivot(native, D)), where
 * pivot(X, D) is the fx_rates rate for base USD, quote X, at the latest
 * rate_date <= D (last-business-day fallback), and pivot('USD', D) = 1.
 * A fact whose currency has no covering fixing contributes NULL and raises
 * `rates_missing` — converted numbers are never silently left unconverted
 * (decision 8). Sums are rounded to 4 decimal places so results fit the
 * string-encoded decimal contract. Read-only: stored facts are never
 * rewritten (decision 4).
 * ------------------------------------------------------------------------- */

/**
 * Lateral joins resolving the pivot rates for one fact row: `dr` for the
 * display currency (parameter $N), `nr` for the row's native currency. USD's
 * pivot rate is 1 by definition; any other currency resolves the latest
 * fixing at or before the fact's metric date and stays NULL when fx_rates
 * does not cover that date.
 */
function fxRateJoins(displayParamIndex: number): string {
  return `cross join lateral (
       select case
                when $${displayParamIndex} = 'USD' then 1::numeric
                else (
                  select f.rate
                  from fx_rates f
                  where f.base_currency = 'USD'
                    and f.quote_currency = $${displayParamIndex}
                    and f.rate_date <= m.metric_date
                  order by f.rate_date desc
                  limit 1
                )
              end as rate
     ) dr
     cross join lateral (
       select case
                when m.currency = 'USD' then 1::numeric
                else (
                  select f.rate
                  from fx_rates f
                  where f.base_currency = 'USD'
                    and f.quote_currency = m.currency
                    and f.rate_date <= m.metric_date
                  order by f.rate_date desc
                  limit 1
                )
              end as rate
     ) nr`;
}

export interface ConvertedTotals {
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  orders: number;
  units: number;
  /** True when a non-zero fact lacked a covering fixing for its date. */
  ratesMissing: boolean;
}

/**
 * Cost/sales totals of the given profiles over a window, converted into one
 * display currency per fact date. Counts (impressions/clicks/orders/units)
 * have no currency and are plain sums. `bookIds` (null or empty = no filter)
 * applies the same ad-group-grain book filter as `dailySeries`.
 */
export async function convertedDailyTotals(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  displayCurrency: string,
  bookIds: bigint[] | null = null,
): Promise<ConvertedTotals> {
  if (profilePks.length === 0) {
    return {
      impressions: 0,
      clicks: 0,
      cost: "0",
      sales: "0",
      orders: 0,
      units: 0,
      ratesMissing: false,
    };
  }
  const result = await db.query<{
    impressions: string;
    clicks: string;
    cost: string;
    sales: string;
    orders: string;
    units: string;
    rates_missing: boolean;
  }>(
    `select coalesce(sum(m.impressions), 0)::text as impressions,
            coalesce(sum(m.clicks), 0)::text as clicks,
            coalesce(round(sum(m.cost * dr.rate / nr.rate), 4), 0)::text as cost,
            coalesce(round(sum(m.sales14d * dr.rate / nr.rate), 4), 0)::text as sales,
            coalesce(sum(m.purchases14d), 0)::text as orders,
            coalesce(sum(m.units_sold_clicks14d), 0)::text as units,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null)
              and (m.cost <> 0 or m.sales <> 0)
            ), false) as rates_missing
     from campaign_metrics_daily m
     ${fxRateJoins(5)}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
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
       ))`,
    [profilePks.map(String), dateStart, dateEnd, bookIds, displayCurrency],
  );
  const row = result.rows[0]!;
  return {
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    cost: row.cost,
    sales: row.sales,
    orders: Number(row.orders),
    units: Number(row.units),
    ratesMissing: row.rates_missing,
  };
}

export interface ConvertedDailyPoint {
  date: string;
  cost: string;
  sales: string;
  orders: number;
  /** True when a non-zero fact on this date lacked a covering fixing. */
  ratesMissing: boolean;
}

/**
 * Per-day cost/sales/orders across all given profiles, converted into one
 * display currency per fact date (trend chart of the all-market view). Rows
 * are grouped by metric date only — every value already shares the display
 * currency, so there is nothing left for the caller to merge.
 */
export async function convertedDailySeries(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  displayCurrency: string,
  bookIds: bigint[] | null = null,
): Promise<ConvertedDailyPoint[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    metric_date: string;
    cost: string;
    sales: string;
    orders: string;
    rates_missing: boolean;
  }>(
    `select m.metric_date::text as metric_date,
            round(sum(m.cost * dr.rate / nr.rate), 4)::text as cost,
            round(sum(m.sales14d * dr.rate / nr.rate), 4)::text as sales,
            sum(m.purchases14d)::text as orders,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null)
              and (m.cost <> 0 or m.sales <> 0)
            ), false) as rates_missing
     from campaign_metrics_daily m
     ${fxRateJoins(5)}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
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
     group by m.metric_date
     order by m.metric_date`,
    [profilePks.map(String), dateStart, dateEnd, bookIds, displayCurrency],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    cost: row.cost,
    sales: row.sales,
    orders: Number(row.orders),
    ratesMissing: row.rates_missing,
  }));
}

export interface ConvertedRoyaltyPoint {
  date: string;
  /** Null when any advertised order that day lacks in-effect economics. */
  estimatedRoyalty: string | null;
  economicsMissing: boolean;
  /** True when an earned royalty on this date lacked a covering fixing. */
  ratesMissing: boolean;
}

/**
 * All-market variant of `overviewRoyaltySeries`: the same per-book,
 * per-marketplace economics and the same `greatest(units_sold_clicks14d,
 * purchases14d)` per-copy
 * valuation, with each fact date's royalty converted into the display
 * currency at that date's fixing. Grouped by metric date only. Missing
 * economics still hide the day's royalty instead of guessing (plan §9).
 */
export async function convertedRoyaltySeries(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  displayCurrency: string,
  bookIds: bigint[] | null = null,
): Promise<ConvertedRoyaltyPoint[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    metric_date: string;
    economics_missing: boolean;
    estimated_royalty: string | null;
    rates_missing: boolean;
  }>(
    `select m.metric_date::text as metric_date,
            bool_or(m.purchases14d > 0 and economics.estimated_royalty_per_sale is null)
              as economics_missing,
            case
              when bool_or(
                m.purchases14d > 0 and economics.estimated_royalty_per_sale is null
              )
                then null
              else round(coalesce(
                sum(${royaltyCopies("m")} * economics.estimated_royalty_per_sale
                    * dr.rate / nr.rate),
                0
              ), 4)::text
            end as estimated_royalty,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null)
              and ${royaltyCopies("m")} > 0
              and economics.estimated_royalty_per_sale is not null
            ), false) as rates_missing
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
     ${fxRateJoins(5)}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
       and (coalesce(cardinality($4::bigint[]), 0) = 0 or exists (
         select 1
         from ads fa
         join book_profile_links fb
           on fb.profile_id = fa.profile_id
          and fb.marketplace_asin = fa.asin
          and fb.enabled = true
         where fa.profile_id = m.profile_id
           and fa.amazon_ad_id = m.ad_id
           and fb.book_id = any($4)
       ))
     group by m.metric_date
     order by m.metric_date`,
    [profilePks.map(String), dateStart, dateEnd, bookIds, displayCurrency],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    estimatedRoyalty: row.estimated_royalty,
    economicsMissing: row.economics_missing,
    ratesMissing: row.rates_missing,
  }));
}

export interface ConvertedCountrySpendRow {
  countryCode: string;
  /** Total spend in the display currency over the window. */
  convertedSpend: string;
  /** True when a non-zero spend fact lacked a covering fixing. */
  ratesMissing: boolean;
}

/**
 * Per-market spend totals converted into one display currency (per fact
 * date), backing the converted figures on the country-spend cards.
 */
export async function convertedCountrySpend(
  db: Db,
  profilePks: readonly string[],
  dateStart: string,
  dateEnd: string,
  displayCurrency: string,
  bookIds: bigint[] | null = null,
): Promise<ConvertedCountrySpendRow[]> {
  if (profilePks.length === 0) {
    return [];
  }
  const result = await db.query<{
    country_code: string;
    converted_spend: string;
    rates_missing: boolean;
  }>(
    `select p.country_code as country_code,
            round(coalesce(sum(m.cost * dr.rate / nr.rate), 0), 4)::text
              as converted_spend,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null) and m.cost <> 0
            ), false) as rates_missing
     from campaign_metrics_daily m
     join amazon_profiles p on p.id = m.profile_id
     ${fxRateJoins(5)}
     where m.profile_id = any($1::bigint[])
       and m.metric_date between $2 and $3
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
     group by p.country_code`,
    [profilePks.map(String), dateStart, dateEnd, bookIds, displayCurrency],
  );
  return result.rows.map((row) => ({
    countryCode: row.country_code,
    convertedSpend: row.converted_spend,
    ratesMissing: row.rates_missing,
  }));
}

export interface DataFreshnessRow {
  profilePk: string;
  amazonProfileId: string;
  countryCode: string;
  dataset: string;
  lastSuccessAt: string | null;
  completeThrough: string | null;
  /** False when structure sync has never imported a campaign for the profile. */
  hasCampaigns: boolean;
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
    country_code: string;
    dataset: string;
    last_success_at: string | null;
    complete_through: string | null;
    has_campaigns: boolean;
  }>(
    `select p.id as profile_pk, p.profile_id as amazon_profile_id,
            p.country_code,
            d.dataset,
            s.last_success_at,
            case when d.dataset = 'metrics' then m.complete_through end as complete_through,
            exists(select 1 from campaigns c where c.profile_id = p.id) as has_campaigns
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
    countryCode: row.country_code,
    dataset: row.dataset,
    lastSuccessAt: row.last_success_at,
    completeThrough: row.complete_through,
    hasCampaigns: row.has_campaigns,
  }));
}
