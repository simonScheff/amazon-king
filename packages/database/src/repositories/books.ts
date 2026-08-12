import type { GoalMode } from "@amazon-king/contracts";
import type { Db } from "../db.js";

/** KDP books and user-entered royalty economics (plan §7). */

export interface Book {
  id: string;
  workspaceId: string;
  asin: string;
  title: string;
  format: string;
  status: string;
  coverJson: unknown | null;
  createdAt: string;
}

interface BookRow {
  id: string;
  workspace_id: string;
  asin: string;
  title: string;
  format: string;
  status: string;
  cover_json: unknown | null;
  created_at: string;
}

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    asin: row.asin,
    title: row.title,
    format: row.format,
    status: row.status,
    coverJson: row.cover_json,
    createdAt: row.created_at,
  };
}

export async function createBook(
  db: Db,
  input: {
    workspaceId: string;
    asin: string;
    title: string;
    format: string;
    status?: string;
    coverJson?: unknown | null;
  },
): Promise<Book> {
  const result = await db.query<BookRow>(
    `insert into books (workspace_id, asin, title, format, status, cover_json)
     values ($1, $2, $3, $4, coalesce($5, 'active'), $6::jsonb)
     returning *`,
    [
      input.workspaceId,
      input.asin,
      input.title,
      input.format,
      input.status ?? null,
      input.coverJson == null ? null : JSON.stringify(input.coverJson),
    ],
  );
  return toBook(result.rows[0]!);
}

export async function getBook(db: Db, bookId: string): Promise<Book | null> {
  const result = await db.query<BookRow>(`select * from books where id = $1`, [
    bookId,
  ]);
  return result.rows[0] ? toBook(result.rows[0]) : null;
}

export async function listBooks(db: Db, workspaceId: string): Promise<Book[]> {
  const result = await db.query<BookRow>(
    `select * from books where workspace_id = $1 order by id`,
    [workspaceId],
  );
  return result.rows.map(toBook);
}

/** Update mutable book fields; only provided fields are changed. */
export async function updateBook(
  db: Db,
  bookId: string,
  input: {
    title?: string;
    format?: string;
    status?: string;
    coverJson?: unknown;
  },
): Promise<Book | null> {
  const result = await db.query<BookRow>(
    `update books set
       title = coalesce($2, title),
       format = coalesce($3, format),
       status = coalesce($4, status),
       cover_json = coalesce($5::jsonb, cover_json)
     where id = $1
     returning *`,
    [
      bookId,
      input.title ?? null,
      input.format ?? null,
      input.status ?? null,
      input.coverJson == null ? null : JSON.stringify(input.coverJson),
    ],
  );
  return result.rows[0] ? toBook(result.rows[0]) : null;
}

export async function deleteBook(db: Db, bookId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `delete from books where id = $1 returning id`,
    [bookId],
  );
  return result.rowCount === 1;
}

export interface BookEconomics {
  id: string;
  bookId: string;
  profileId: string;
  effectiveFrom: string;
  currency: string;
  listPrice: string;
  estimatedRoyaltyPerSale: string;
  targetAcos: string | null;
  goalMode: GoalMode;
  maxSpendWithoutSale: string | null;
  maxBid: string | null;
  maxDailyBudget: string | null;
  notes: string | null;
  createdAt: string;
}

interface BookEconomicsRow {
  id: string;
  book_id: string;
  profile_id: string;
  effective_from: string;
  currency: string;
  list_price: string;
  estimated_royalty_per_sale: string;
  target_acos: string | null;
  goal_mode: GoalMode;
  max_spend_without_sale: string | null;
  max_bid: string | null;
  max_daily_budget: string | null;
  notes: string | null;
  created_at: string;
}

function toEconomics(row: BookEconomicsRow): BookEconomics {
  return {
    id: row.id,
    bookId: row.book_id,
    profileId: row.profile_id,
    effectiveFrom: row.effective_from,
    currency: row.currency,
    listPrice: row.list_price,
    estimatedRoyaltyPerSale: row.estimated_royalty_per_sale,
    targetAcos: row.target_acos,
    goalMode: row.goal_mode,
    maxSpendWithoutSale: row.max_spend_without_sale,
    maxBid: row.max_bid,
    maxDailyBudget: row.max_daily_budget,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export interface BookEconomicsInput {
  bookId: string;
  profileId: string;
  effectiveFrom: string; // ISO date
  currency: string;
  listPrice: string;
  estimatedRoyaltyPerSale: string;
  targetAcos?: string | null;
  goalMode: GoalMode;
  maxSpendWithoutSale?: string | null;
  maxBid?: string | null;
  maxDailyBudget?: string | null;
  notes?: string | null;
}

/** Upsert economics for (book, profile, effective_from). */
export async function upsertBookEconomics(
  db: Db,
  input: BookEconomicsInput,
): Promise<BookEconomics> {
  const result = await db.query<BookEconomicsRow>(
    `insert into book_economics
       (book_id, profile_id, effective_from, currency, list_price,
        estimated_royalty_per_sale, target_acos, goal_mode,
        max_spend_without_sale, max_bid, max_daily_budget, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (book_id, profile_id, effective_from) do update set
       currency = excluded.currency,
       list_price = excluded.list_price,
       estimated_royalty_per_sale = excluded.estimated_royalty_per_sale,
       target_acos = excluded.target_acos,
       goal_mode = excluded.goal_mode,
       max_spend_without_sale = excluded.max_spend_without_sale,
       max_bid = excluded.max_bid,
       max_daily_budget = excluded.max_daily_budget,
       notes = excluded.notes
     returning *`,
    [
      input.bookId,
      input.profileId,
      input.effectiveFrom,
      input.currency,
      input.listPrice,
      input.estimatedRoyaltyPerSale,
      input.targetAcos ?? null,
      input.goalMode,
      input.maxSpendWithoutSale ?? null,
      input.maxBid ?? null,
      input.maxDailyBudget ?? null,
      input.notes ?? null,
    ],
  );
  return toEconomics(result.rows[0]!);
}

/**
 * Latest economics in effect for a book/profile on a date (defaults to
 * today). Returns null when the user has not entered economics — callers
 * must disable profit recommendations rather than guess (plan §7).
 */
export async function getLatestBookEconomics(
  db: Db,
  bookId: string,
  profileId: string,
  onDate?: string,
): Promise<BookEconomics | null> {
  const result = await db.query<BookEconomicsRow>(
    `select * from book_economics
     where book_id = $1 and profile_id = $2
       and effective_from <= coalesce($3::date, current_date)
     order by effective_from desc
     limit 1`,
    [bookId, profileId, onDate ?? null],
  );
  return result.rows[0] ? toEconomics(result.rows[0]) : null;
}
