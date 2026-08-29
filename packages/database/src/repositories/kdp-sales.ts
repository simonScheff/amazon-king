import type { Db } from "../db.js";
import { royaltyCopies } from "./dashboard.js";

/**
 * KDP sales history (migration 0020): monthly per-book × per-marketplace
 * aggregates and verbatim per-transaction rows, both populated from a KDP
 * royalty import. Re-importing a month replaces its data — the monthly rows
 * upsert on (book_id, profile_id, month), and the caller deletes the covered
 * months' transactions before inserting the new file's rows.
 */

export interface KdpMonthlyBookSale {
  id: string;
  workspaceId: string;
  importId: string;
  bookId: string;
  profileId: string;
  month: string;
  standardUnits: number;
  expandedUnits: number;
  royalty: string;
  currency: string;
}

interface KdpMonthlyBookSaleRow {
  id: string;
  workspace_id: string;
  import_id: string;
  book_id: string;
  profile_id: string;
  month: string;
  standard_units: number;
  expanded_units: number;
  royalty: string;
  currency: string;
}

function toMonthlySale(row: KdpMonthlyBookSaleRow): KdpMonthlyBookSale {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    importId: row.import_id,
    bookId: row.book_id,
    profileId: row.profile_id,
    month: row.month,
    standardUnits: row.standard_units,
    expandedUnits: row.expanded_units,
    royalty: row.royalty,
    currency: row.currency,
  };
}

export interface KdpMonthlyBookSaleInput {
  workspaceId: string;
  importId: string;
  bookId: string;
  profileId: string;
  /** First day of the month, ISO date. */
  month: string;
  standardUnits: number;
  expandedUnits: number;
  royalty: string;
  currency: string;
}

/**
 * Insert or replace monthly aggregates. A re-imported month overwrites the
 * prior row (and points it at the newer import), so the latest file wins.
 */
export async function upsertKdpMonthlyBookSales(
  db: Db,
  rows: KdpMonthlyBookSaleInput[],
): Promise<void> {
  for (const row of rows) {
    await db.query(
      `insert into kdp_monthly_book_sales
         (workspace_id, import_id, book_id, profile_id, month,
          standard_units, expanded_units, royalty, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (book_id, profile_id, month) do update set
         import_id = excluded.import_id,
         standard_units = excluded.standard_units,
         expanded_units = excluded.expanded_units,
         royalty = excluded.royalty,
         currency = excluded.currency`,
      [
        row.workspaceId,
        row.importId,
        row.bookId,
        row.profileId,
        row.month,
        row.standardUnits,
        row.expandedUnits,
        row.royalty,
        row.currency,
      ],
    );
  }
}

/** Monthly aggregates for the history endpoint, oldest month first. */
export async function listKdpMonthlyBookSales(
  db: Db,
  workspaceId: string,
): Promise<KdpMonthlyBookSale[]> {
  const result = await db.query<KdpMonthlyBookSaleRow>(
    `select id, workspace_id, import_id, book_id, profile_id,
            month::text as month, standard_units, expanded_units,
            royalty, currency
     from kdp_monthly_book_sales
     where workspace_id = $1
     order by month asc, book_id asc, profile_id asc`,
    [workspaceId],
  );
  return result.rows.map(toMonthlySale);
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
 * Delete the transactions of the given months (first-of-month ISO dates)
 * ahead of a re-import, so an overlapping later file replaces rather than
 * duplicates them. Call with the months the new file covers, then insert.
 */
export async function deleteKdpSaleTransactionsForMonths(
  db: Db,
  workspaceId: string,
  months: string[],
): Promise<void> {
  await db.query(
    `delete from kdp_sale_transactions
     where workspace_id = $1
       and date_trunc('month', order_date)::date = any($2::date[])`,
    [workspaceId, months],
  );
}

/** Insert verbatim report transactions (single-owner scale: ~50/month). */
export async function insertKdpSaleTransactions(
  db: Db,
  rows: KdpSaleTransactionInput[],
): Promise<void> {
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
  /** First-of-month ISO date; matches on order_date's month. */
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
            or date_trunc('month', order_date)::date = $4)`,
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
            or date_trunc('month', order_date)::date = $4)
     order by order_date desc, id desc
     limit $5 offset $6`,
    [...filterParams, filter.limit ?? 500, filter.offset ?? 0],
  );
  return {
    transactions: result.rows.map(toTransaction),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
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
 * measure Amazon fulfillment (same classification as the import flow:
 * royalty types 40%/50% and "Expanded Distribution*" transaction types).
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
       and royalty_type not in ('40%', '50%')
       and lower(transaction_type) not like 'expanded distribution%'
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
