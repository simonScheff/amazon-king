import type {
  KdpFulfillmentSeries,
  KdpHistory,
  KdpHistorySeries,
  KdpSaleTransaction,
  KdpTransactionsPage,
  KdpTransactionsQuery,
} from "@amazon-king/contracts";
import { books, kdpSales, profiles, type Db } from "@amazon-king/database";
import { coverImageUrlOf, isoDate } from "./serialize.js";

/**
 * KDP sales history reads (docs/kdp-royalty-import-plan.md §6) behind
 * GET /api/kdp/history and GET /api/kdp/transactions. The KDP side derives at
 * read time from the verbatim transactions, grouped by KDP report month
 * (royalty_date — matching the KDP dashboard's display); the ad side of the
 * sales mix is computed at query time from the fact tables (decision 11) and
 * royalty-per-sale reads the effective-dated book_economics history
 * (decision 10 — never duplicated).
 */

/** Last day of a first-of-month ISO date ("2026-08-01" → "2026-08-31"). */
function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return isoDate(new Date(Date.UTC(year!, mon!, 0)));
}

/**
 * The estimated_royalty_per_sale in effect at the end of a month, from the
 * book's effective-dated economics (ascending). Null when no economics row
 * covered the month.
 */
function royaltyPerSaleFor(
  history: books.WorkspaceBookEconomics[],
  monthEndDate: string,
): string | null {
  let value: string | null = null;
  for (const row of history) {
    if (isoDate(row.effectiveFrom) > monthEndDate) break;
    value = row.estimatedRoyaltyPerSale;
  }
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function getKdpHistory(
  db: Db,
  workspaceId: string,
): Promise<KdpHistory> {
  const [
    monthly,
    adUnits,
    fulfillmentStats,
    economicsHistory,
    bookList,
    profileList,
  ] = await Promise.all([
    kdpSales.listKdpMonthlyBookSales(db, workspaceId),
    kdpSales.listKdpAdUnitsByBookMonth(db, workspaceId),
    kdpSales.listKdpFulfillmentStats(db, workspaceId),
    books.listBookEconomicsHistoryByWorkspace(db, workspaceId),
    books.listBooks(db, workspaceId),
    profiles.listProfilesByWorkspace(db, workspaceId),
  ]);

  const bookById = new Map(bookList.map((book) => [book.id, book]));
  const profileByPk = new Map(
    profileList.map((profile) => [profile.id, profile]),
  );
  const adUnitsByKey = new Map<string, number>();
  for (const row of adUnits) {
    adUnitsByKey.set(
      `${row.bookId} ${row.profileId} ${isoDate(row.month)}`,
      row.adUnits,
    );
  }
  const economicsByKey = new Map<string, books.WorkspaceBookEconomics[]>();
  for (const row of economicsHistory) {
    const key = `${row.bookId} ${row.profileId}`;
    const list = economicsByKey.get(key);
    if (list) {
      list.push(row);
    } else {
      economicsByKey.set(key, [row]);
    }
  }

  // One series per book × profile; its months are the union of the KDP
  // aggregate months and the months with ad-attributed units (a month with
  // ads data but no KDP import still shows on the sales-mix chart).
  interface MonthEntry {
    kdpStandardUnits: number;
    kdpExpandedUnits: number;
  }
  const monthsBySeries = new Map<string, Map<string, MonthEntry>>();
  const noteMonth = (bookId: string, profilePk: string, month: string) => {
    const key = `${bookId} ${profilePk}`;
    let months = monthsBySeries.get(key);
    if (!months) {
      months = new Map();
      monthsBySeries.set(key, months);
    }
    let entry = months.get(month);
    if (!entry) {
      entry = { kdpStandardUnits: 0, kdpExpandedUnits: 0 };
      months.set(month, entry);
    }
    return entry;
  };
  for (const row of monthly) {
    const entry = noteMonth(row.bookId, row.profileId, isoDate(row.month));
    entry.kdpStandardUnits = row.standardUnits;
    entry.kdpExpandedUnits = row.expandedUnits;
  }
  for (const row of adUnits) {
    noteMonth(row.bookId, row.profileId, isoDate(row.month));
  }

  const series: KdpHistorySeries[] = [];
  for (const [key, months] of monthsBySeries) {
    const [bookId, profilePk] = key.split(" ") as [string, string];
    const book = bookById.get(bookId);
    const profile = profileByPk.get(profilePk);
    if (!book || !profile) continue;
    series.push({
      bookId,
      title: book.title,
      profileId: profile.profileId,
      countryCode: profile.countryCode,
      currency: profile.currencyCode,
      coverImageUrl: coverImageUrlOf(book.coverJson),
      months: [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, entry]) => ({
          month,
          kdpStandardUnits: entry.kdpStandardUnits,
          kdpExpandedUnits: entry.kdpExpandedUnits,
          adUnits: adUnitsByKey.get(`${bookId} ${profilePk} ${month}`) ?? 0,
          royaltyPerSale: royaltyPerSaleFor(
            economicsByKey.get(key) ?? [],
            monthEnd(month),
          ),
        })),
    });
  }
  series.sort(
    (a, b) =>
      Number(a.bookId) - Number(b.bookId) ||
      a.profileId.localeCompare(b.profileId),
  );

  const fulfillmentByProfile = new Map<string, KdpFulfillmentSeries>();
  for (const row of fulfillmentStats) {
    const profile = profileByPk.get(row.profileId);
    if (!profile) continue;
    let entry = fulfillmentByProfile.get(row.profileId);
    if (!entry) {
      entry = {
        profileId: profile.profileId,
        countryCode: profile.countryCode,
        months: [],
      };
      fulfillmentByProfile.set(row.profileId, entry);
    }
    entry.months.push({
      month: isoDate(row.month),
      medianDays: round2(row.medianDays),
      averageDays: round2(row.averageDays),
      standardUnits: row.standardUnits,
    });
  }
  const fulfillment = [...fulfillmentByProfile.values()].sort((a, b) =>
    a.profileId.localeCompare(b.profileId),
  );

  return { series, fulfillment };
}

/**
 * Verbatim sale transactions for the per-sale browser, newest order date
 * first. `profileId` in the query is the Amazon Ads profile id (it is
 * resolved to the internal PK here); an unknown profile yields no rows.
 */
export async function listKdpTransactions(
  db: Db,
  workspaceId: string,
  query: KdpTransactionsQuery,
): Promise<KdpTransactionsPage> {
  let profilePk: string | undefined;
  if (query.profileId !== undefined) {
    const profile = await profiles.findProfileByAmazonId(
      db,
      workspaceId,
      query.profileId,
    );
    if (!profile) return { transactions: [], total: 0 };
    profilePk = profile.id;
  }

  const [page, bookList, profileList] = await Promise.all([
    kdpSales.listKdpSaleTransactions(db, workspaceId, {
      bookId: query.bookId,
      profileId: profilePk,
      month: query.month,
      limit: query.limit,
      offset: query.offset,
    }),
    books.listBooks(db, workspaceId),
    profiles.listProfilesByWorkspace(db, workspaceId),
  ]);
  const titleByBookId = new Map(bookList.map((book) => [book.id, book.title]));
  const profileByPk = new Map(
    profileList.map((profile) => [profile.id, profile]),
  );

  return {
    transactions: page.transactions.map((row) => ({
      id: row.id,
      bookId: row.bookId,
      title:
        row.bookId === null ? null : (titleByBookId.get(row.bookId) ?? null),
      profileId:
        row.profileId === null
          ? null
          : (profileByPk.get(row.profileId)?.profileId ?? null),
      asin: row.asin,
      marketplace: row.marketplace,
      format: row.format as KdpSaleTransaction["format"],
      royaltyType: row.royaltyType,
      transactionType: row.transactionType,
      orderDate: isoDate(row.orderDate),
      royaltyDate: isoDate(row.royaltyDate),
      netUnits: row.netUnits,
      royalty: row.royalty,
      currency: row.currency,
    })),
    total: page.total,
  };
}
