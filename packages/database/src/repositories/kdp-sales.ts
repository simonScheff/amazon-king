import type { Db } from "../db.js";

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
          format, royalty_type, order_date, royalty_date, net_units, royalty,
          currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.workspaceId,
        row.importId,
        row.bookId,
        row.profileId,
        row.asin,
        row.marketplace,
        row.format,
        row.royaltyType,
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
}

/** Transactions for the per-sale browser, newest order date first. */
export async function listKdpSaleTransactions(
  db: Db,
  workspaceId: string,
  filter: KdpSaleTransactionFilter = {},
): Promise<KdpSaleTransaction[]> {
  const result = await db.query<KdpSaleTransactionRow>(
    `select id, workspace_id, import_id, book_id, profile_id, asin,
            marketplace, format, royalty_type, order_date::text as order_date,
            royalty_date::text as royalty_date, net_units, royalty, currency
     from kdp_sale_transactions
     where workspace_id = $1
       and ($2::bigint is null or book_id = $2)
       and ($3::bigint is null or profile_id = $3)
       and ($4::date is null
            or date_trunc('month', order_date)::date = $4)
     order by order_date desc, id desc
     limit $5`,
    [
      workspaceId,
      filter.bookId ?? null,
      filter.profileId ?? null,
      filter.month ?? null,
      filter.limit ?? 500,
    ],
  );
  return result.rows.map(toTransaction);
}
