import type { Db } from "../db.js";
import { fxRateJoins, royaltyCopies } from "./dashboard.js";

/**
 * KDP sales history: verbatim per-transaction rows populated from KDP royalty
 * imports, plus read-time derivations over them. Imports are additive
 * (migration 0022): a KDP report is royalty-month scoped and every file
 * carries a tail of previous-month orders, so no import ever deletes another
 * file's data — mergeKdpSaleTransactions replaces only rows identical to the
 * incoming ones. The monthly aggregates feeding /kdp-history are derived at
 * read time from the transactions (single-owner scale: ~50 rows/month), so
 * there is no stored copy that can diverge. Months are KDP report months —
 * grouped by royalty_date, matching the KDP dashboard's own display.
 */

/** Row classification shared by the monthly derivation and fulfillment
 * stats: standard-rate rows are royalty types other than 40%/50% whose
 * transaction type is not "Expanded Distribution*" (same rule the import
 * flow's isStandardRow applies in TypeScript). */
const STANDARD_ROW_SQL = `royalty_type not in ('40%', '50%')
  and lower(transaction_type) not like 'expanded distribution%'`;

export interface KdpMonthlyBookSale {
  bookId: string;
  profileId: string;
  /** First-of-month ISO date of the KDP report month (royalty_date). */
  month: string;
  standardUnits: number;
  expandedUnits: number;
  /** Summed royalty over standard-rate rows, native currency. */
  royalty: string;
  currency: string;
}

/**
 * Monthly per-book × per-marketplace aggregates derived from the stored
 * transactions, oldest month first. A month whose rows are all
 * expanded-distribution still appears (0 standard units, "0" royalty).
 * Unlinked-ASIN rows (null book_id/profile_id) are excluded — they show in
 * the transaction browser but have no book series to join.
 */
export async function listKdpMonthlyBookSales(
  db: Db,
  workspaceId: string,
): Promise<KdpMonthlyBookSale[]> {
  const result = await db.query<{
    book_id: string;
    profile_id: string;
    month: string;
    standard_units: number;
    expanded_units: number;
    royalty: string;
    currency: string;
  }>(
    `select book_id, profile_id,
            date_trunc('month', royalty_date)::date::text as month,
            coalesce(sum(net_units) filter (where ${STANDARD_ROW_SQL}), 0)::int
              as standard_units,
            coalesce(sum(net_units) filter (where not (${STANDARD_ROW_SQL})), 0)::int
              as expanded_units,
            coalesce(sum(royalty) filter (where ${STANDARD_ROW_SQL}), 0)::text
              as royalty,
            min(currency) as currency
     from kdp_sale_transactions
     where workspace_id = $1
       and book_id is not null
       and profile_id is not null
     group by book_id, profile_id, date_trunc('month', royalty_date)::date
     order by month asc, book_id asc, profile_id asc`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    bookId: row.book_id,
    profileId: row.profile_id,
    month: row.month,
    standardUnits: row.standard_units,
    expandedUnits: row.expanded_units,
    royalty: row.royalty,
    currency: row.currency,
  }));
}

export interface KdpSaleTransaction {
  id: string;
  workspaceId: string;
  importId: string;
  bookId: string | null;
  profileId: string | null;
  asin: string;
  marketplace: string;
  format: string;
  royaltyType: string;
  transactionType: string;
  orderDate: string;
  royaltyDate: string;
  netUnits: number;
  royalty: string;
  currency: string;
}

interface KdpSaleTransactionRow {
  id: string;
  workspace_id: string;
  import_id: string;
  book_id: string | null;
  profile_id: string | null;
  asin: string;
  marketplace: string;
  format: string;
  royalty_type: string;
  transaction_type: string;
  order_date: string;
  royalty_date: string;
  net_units: number;
  royalty: string;
  currency: string;
}

function toTransaction(row: KdpSaleTransactionRow): KdpSaleTransaction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    importId: row.import_id,
    bookId: row.book_id,
    profileId: row.profile_id,
    asin: row.asin,
    marketplace: row.marketplace,
    format: row.format,
    royaltyType: row.royalty_type,
    transactionType: row.transaction_type,
    orderDate: row.order_date,
    royaltyDate: row.royalty_date,
    netUnits: row.net_units,
    royalty: row.royalty,
    currency: row.currency,
  };
}

export interface KdpSaleTransactionInput {
  workspaceId: string;
  importId: string;
  /** Null when the row's ASIN is not linked to a catalog book/profile. */
  bookId: string | null;
  profileId: string | null;
  asin: string;
  marketplace: string;
  format: string;
  royaltyType: string;
  transactionType: string;
  orderDate: string;
  royaltyDate: string;
  netUnits: number;
  royalty: string;
  currency: string;
}

/**
 * Merge a report's transactions into the stored set: rows identical to an
 * incoming row (on every report field — asin, marketplace, both dates,
 * royalty/transaction type, units, royalty, currency, format) are deleted
 * first, then the incoming rows are inserted. True duplicates inside one
 * file (two identical one-copy sales) survive with their multiplicity, and
 * rows no other file reported are never touched — so overlapping files merge
 * instead of destroying each other's previous-month tails, and re-importing
 * a file is always a no-op.
 */
export async function mergeKdpSaleTransactions(
  db: Db,
  rows: KdpSaleTransactionInput[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const workspaceId = rows[0]!.workspaceId;
  await db.query(
    `delete from kdp_sale_transactions t
     using unnest(
       $2::text[], $3::text[], $4::date[], $5::date[], $6::text[],
       $7::text[], $8::integer[], $9::numeric[], $10::text[], $11::text[]
     ) as m(asin, marketplace, order_date, royalty_date, royalty_type,
            transaction_type, net_units, royalty, currency, format)
     where t.workspace_id = $1
       and t.asin = m.asin
       and t.marketplace = m.marketplace
       and t.order_date = m.order_date
       and t.royalty_date = m.royalty_date
       and t.royalty_type = m.royalty_type
       and t.transaction_type = m.transaction_type
       and t.net_units = m.net_units
       and t.royalty = m.royalty
       and t.currency = m.currency
       and t.format = m.format`,
    [
      workspaceId,
      rows.map((row) => row.asin),
      rows.map((row) => row.marketplace),
      rows.map((row) => row.orderDate),
      rows.map((row) => row.royaltyDate),
      rows.map((row) => row.royaltyType),
      rows.map((row) => row.transactionType),
      rows.map((row) => row.netUnits),
      rows.map((row) => row.royalty),
      rows.map((row) => row.currency),
      rows.map((row) => row.format),
    ],
  );
  for (const row of rows) {
    await db.query(
      `insert into kdp_sale_transactions
         (workspace_id, import_id, book_id, profile_id, asin, marketplace,
          format, royalty_type, transaction_type, order_date, royalty_date,
          net_units, royalty, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.workspaceId,
        row.importId,
        row.bookId,
        row.profileId,
        row.asin,
        row.marketplace,
        row.format,
        row.royaltyType,
        row.transactionType,
        row.orderDate,
        row.royaltyDate,
        row.netUnits,
        row.royalty,
        row.currency,
      ],
    );
  }
}

export interface KdpSaleTransactionFilter {
  bookId?: string;
  profileId?: string;
  /** First-of-month ISO date; matches the KDP report month (royalty_date). */
  month?: string;
  limit?: number;
  offset?: number;
}

export interface KdpSaleTransactionPage {
  transactions: KdpSaleTransaction[];
  /** Total rows matching the filters, across all pages. */
  total: number;
}

/** Transactions for the per-sale browser, newest order date first. */
export async function listKdpSaleTransactions(
  db: Db,
  workspaceId: string,
  filter: KdpSaleTransactionFilter = {},
): Promise<KdpSaleTransactionPage> {
  const filterParams = [
    workspaceId,
    filter.bookId ?? null,
    filter.profileId ?? null,
    filter.month ?? null,
  ];
  const countResult = await db.query<{ total: string }>(
    `select count(*)::int as total
     from kdp_sale_transactions
     where workspace_id = $1
       and ($2::bigint is null or book_id = $2)
       and ($3::bigint is null or profile_id = $3)
       and ($4::date is null
            or date_trunc('month', royalty_date)::date = $4)`,
    filterParams,
  );
  const result = await db.query<KdpSaleTransactionRow>(
    `select id, workspace_id, import_id, book_id, profile_id, asin,
            marketplace, format, royalty_type, transaction_type,
            order_date::text as order_date,
            royalty_date::text as royalty_date, net_units, royalty, currency
     from kdp_sale_transactions
     where workspace_id = $1
       and ($2::bigint is null or book_id = $2)
       and ($3::bigint is null or profile_id = $3)
       and ($4::date is null
            or date_trunc('month', royalty_date)::date = $4)
     order by order_date desc, id desc
     limit $5 offset $6`,
    [...filterParams, filter.limit ?? 500, filter.offset ?? 0],
  );
  return {
    transactions: result.rows.map(toTransaction),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

export interface KdpDailyRoyaltyPoint {
  /** Royalty posting date (ISO day). */
  date: string;
  /** Summed royalty converted into the display currency at each day's fixing. */
  royalty: string;
  /** True when a non-zero royalty on this date lacked a covering fixing. */
  ratesMissing: boolean;
}

/**
 * Real KDP royalty summed per royalty date, converted into one display
 * currency at each date's own fixing — the organic side of the /kdp-history
 * daily profit chart. Royalty date (the day KDP posted the royalty) matches
 * how the KDP dashboard itself scopes and displays the data, the monthly
 * aggregates above, and the royalty-date-based import periods. The subselect
 * aliases royalty_date/currency to the shape the shared fxRateJoins expects;
 * the conversion convention (USD pivot, last fixing at or before the date,
 * never a silent 1:1) matches the converting dashboard queries.
 * Unlinked-ASIN rows (null book_id) are real money and included unless a
 * book filter is given.
 */
export async function listKdpDailyRoyalty(
  db: Db,
  workspaceId: string,
  filter: {
    start: string;
    end: string;
    /** Internal book PK; null sums every book including unlinked sales. */
    bookPk: bigint | null;
    displayCurrency: string;
  },
): Promise<KdpDailyRoyaltyPoint[]> {
  const result = await db.query<{
    metric_date: string;
    royalty: string;
    rates_missing: boolean;
  }>(
    `select m.metric_date::text as metric_date,
            round(sum(m.royalty * dr.rate / nr.rate), 4)::text as royalty,
            coalesce(bool_or(
              (dr.rate is null or nr.rate is null) and m.royalty <> 0
            ), false) as rates_missing
     from (
       select royalty_date as metric_date, royalty, currency
       from kdp_sale_transactions
       where workspace_id = $1
         and royalty_date between $2 and $3
         and ($4::bigint is null or book_id = $4)
     ) m
     ${fxRateJoins(5)}
     group by m.metric_date
     order by m.metric_date`,
    [
      workspaceId,
      filter.start,
      filter.end,
      filter.bookPk === null ? null : String(filter.bookPk),
      filter.displayCurrency,
    ],
  );
  return result.rows.map((row) => ({
    date: row.metric_date,
    royalty: row.royalty,
    ratesMissing: row.rates_missing,
  }));
}

export interface KdpBookMonthAdUnits {
  bookId: string;
  profileId: string;
  /** First-of-month ISO date. */
  month: string;
  adUnits: number;
}

/**
 * Ad-attributed copies per linked book × profile × month, computed at query
 * time from the advertised-product facts (plan decision 11 — never
 * snapshotted, so re-synced ads data is reflected in history automatically).
 * Copies follow the browser-facing royalty convention
 * (`greatest(units_sold_clicks14d, purchases14d)`); the join mirrors the
 * dashboard royalty queries: fact ad_id → ads.asin → book_profile_links.
 */
export async function listKdpAdUnitsByBookMonth(
  db: Db,
  workspaceId: string,
): Promise<KdpBookMonthAdUnits[]> {
  const result = await db.query<{
    book_id: string;
    profile_id: string;
    month: string;
    ad_units: string;
  }>(
    `select bpl.book_id, bpl.profile_id,
            date_trunc('month', m.metric_date)::date::text as month,
            sum(${royaltyCopies("m")})::text as ad_units
     from advertised_product_metrics_daily m
     join ads a on a.profile_id = m.profile_id and a.amazon_ad_id = m.ad_id
     join book_profile_links bpl
       on bpl.profile_id = m.profile_id
      and bpl.marketplace_asin = a.asin
      and bpl.enabled = true
     join amazon_profiles p on p.id = m.profile_id
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1
     group by bpl.book_id, bpl.profile_id,
              date_trunc('month', m.metric_date)::date
     order by month asc, bpl.book_id asc, bpl.profile_id asc`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    bookId: row.book_id,
    profileId: row.profile_id,
    month: row.month,
    adUnits: Number(row.ad_units),
  }));
}

export interface KdpFulfillmentMonthStats {
  profileId: string;
  /** First-of-month ISO date (of order_date). */
  month: string;
  /** Median order→ship days (percentile_cont; fractional, e.g. 2.5). */
  medianDays: number;
  averageDays: number;
  standardUnits: number;
}

/**
 * Fulfillment time per profile × month of order_date: KDP marks a print sale
 * processed (royalty_date) only after the book ships, so the lag is the
 * print-and-ship time for that copy. Standard-rate rows only — Expanded
 * Distribution sales are printed by a third party, so their lag does not
 * measure Amazon fulfillment (same STANDARD_ROW_SQL classification the
 * monthly derivation uses).
 */
export async function listKdpFulfillmentStats(
  db: Db,
  workspaceId: string,
): Promise<KdpFulfillmentMonthStats[]> {
  const result = await db.query<{
    profile_id: string;
    month: string;
    median_days: number;
    average_days: number;
    standard_units: string;
  }>(
    `select profile_id,
            date_trunc('month', order_date)::date::text as month,
            percentile_cont(0.5) within group (
              order by royalty_date - order_date
            ) as median_days,
            avg(royalty_date - order_date)::float8 as average_days,
            sum(net_units)::text as standard_units
     from kdp_sale_transactions
     where workspace_id = $1
       and profile_id is not null
       and ${STANDARD_ROW_SQL}
     group by profile_id, date_trunc('month', order_date)::date
     order by month asc, profile_id asc`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    profileId: row.profile_id,
    month: row.month,
    medianDays: Number(row.median_days),
    averageDays: Number(row.average_days),
    standardUnits: Number(row.standard_units),
  }));
}
