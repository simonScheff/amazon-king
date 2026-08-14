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
  profileIds: string[];
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
  profile_ids?: string[];
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
    profileIds: row.profile_ids ?? [],
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
    `select b.*,
            coalesce(
              array_agg(p.profile_id order by p.profile_id)
                filter (where bpl.enabled = true),
              '{}'::text[]
            ) as profile_ids
     from books b
     left join book_profile_links bpl on bpl.book_id = b.id
     left join amazon_profiles p on p.id = bpl.profile_id
     where b.workspace_id = $1
     group by b.id
     order by b.id`,
    [workspaceId],
  );
  return result.rows.map(toBook);
}

export async function isBookLinkedToProfile(
  db: Db,
  bookId: string,
  profileId: string,
): Promise<boolean> {
  const result = await db.query<{ linked: boolean }>(
    `select exists (
       select 1 from book_profile_links
       where book_id = $1 and profile_id = $2 and enabled = true
     ) as linked`,
    [bookId, profileId],
  );
  return result.rows[0]?.linked ?? false;
}

export interface UnmappedAdvertisedProduct {
  profileId: string;
  asin: string;
  countryCode: string;
  currencyCode: string;
  adCount: number;
}

interface UnmappedAdvertisedProductRow {
  profile_id: string;
  asin: string;
  country_code: string;
  currency_code: string;
  ad_count: number;
}

/**
 * Distinct advertised ASINs that still need a workspace book/profile link.
 * Amazon Ads supplies the ASIN but not authoritative KDP title/format data,
 * so callers must ask the owner to confirm those fields before mapping.
 */
export async function listUnmappedAdvertisedProducts(
  db: Db,
  workspaceId: string,
): Promise<UnmappedAdvertisedProduct[]> {
  const result = await db.query<UnmappedAdvertisedProductRow>(
    `select p.profile_id, a.asin, p.country_code, p.currency_code,
            count(distinct a.id)::int as ad_count
     from ads a
     join amazon_profiles p on p.id = a.profile_id
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1
       and a.asin <> ''
       and not exists (
         select 1 from book_profile_links bpl
         where bpl.profile_id = p.id
           and bpl.marketplace_asin = a.asin
           and bpl.enabled = true
       )
     group by p.id, p.profile_id, a.asin, p.country_code, p.currency_code
     order by a.asin, p.country_code, p.profile_id`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    profileId: row.profile_id,
    asin: row.asin,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    adCount: row.ad_count,
  }));
}

/**
 * Idempotently create/update the catalog book and link it to every selected
 * profile, but only when each profile really advertises the supplied ASIN in
 * this workspace. One statement keeps book creation and all links atomic.
 */
export async function mapAdvertisedProductToBook(
  db: Db,
  input: {
    workspaceId: string;
    profileIds: string[];
    asin: string;
    title: string;
    format: string;
    coverJson?: unknown;
  },
): Promise<Book | null> {
  const result = await db.query<BookRow>(
    `with candidate_profiles as (
       select p.id
       from amazon_profiles p
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
         and p.id = any($2::bigint[])
         and exists (
           select 1 from ads a
           where a.profile_id = p.id and a.asin = $3
         )
     ),
     upserted_book as (
       insert into books (workspace_id, asin, title, format, status, cover_json)
       select $1, $3, $4, $5, 'active', $6::jsonb
       where (select count(*) from candidate_profiles) = cardinality($2::bigint[])
       on conflict (workspace_id, asin, format) do update set
         title = excluded.title,
         status = 'active',
         cover_json = coalesce(excluded.cover_json, books.cover_json)
       returning *
     ),
     linked_profiles as (
       insert into book_profile_links (book_id, profile_id, marketplace_asin, enabled)
       select b.id, p.id, $3, true
       from upserted_book b cross join candidate_profiles p
       on conflict (book_id, profile_id) do update set
         marketplace_asin = excluded.marketplace_asin,
         enabled = true
       returning profile_id
     )
     select b.* from upserted_book b
     where (select count(*) from linked_profiles) = cardinality($2::bigint[])`,
    [
      input.workspaceId,
      input.profileIds,
      input.asin,
      input.title,
      input.format,
      input.coverJson == null ? null : JSON.stringify(input.coverJson),
    ],
  );
  return result.rows[0] ? toBook(result.rows[0]) : null;
}

/** Update mutable book fields; only provided fields are changed. An explicit
 * `coverJson: null` clears the cover; `undefined` leaves it untouched. */
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
       cover_json = case when $6 then $5::jsonb else cover_json end
     where id = $1
     returning *`,
    [
      bookId,
      input.title ?? null,
      input.format ?? null,
      input.status ?? null,
      input.coverJson == null ? null : JSON.stringify(input.coverJson),
      input.coverJson !== undefined,
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

export interface WorkspaceBookEconomics extends BookEconomics {
  amazonProfileId: string;
}

interface WorkspaceBookEconomicsRow extends BookEconomicsRow {
  amazon_profile_id: string;
}

/** Latest in-effect economics for every book/profile in a workspace. */
export async function listLatestBookEconomicsByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceBookEconomics[]> {
  const result = await db.query<WorkspaceBookEconomicsRow>(
    `select distinct on (be.book_id, be.profile_id)
            be.*, p.profile_id as amazon_profile_id
     from book_economics be
     join books b on b.id = be.book_id
     join amazon_profiles p on p.id = be.profile_id
     where b.workspace_id = $1 and be.effective_from <= current_date
     order by be.book_id, be.profile_id, be.effective_from desc, be.id desc`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    ...toEconomics(row),
    amazonProfileId: row.amazon_profile_id,
  }));
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
