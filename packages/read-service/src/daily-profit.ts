import type {
  KdpDailyProfit,
  KdpDailyProfitDay,
  KdpDailyProfitQuery,
} from "@amazon-king/contracts";
import {
  microsFromDecimalString,
  microsToDecimalString,
} from "@amazon-king/optimizer";
import {
  books,
  dashboard,
  fx,
  identity,
  kdpSales,
  profiles,
  type Db,
} from "@amazon-king/database";
import { conflict, notFound } from "./errors.js";

/**
 * KDP daily-profit read (GET /api/kdp/daily-profit): one calendar month of
 * per-day profitability for the /kdp-history organic tab. Per day, all
 * markets converted into the workspace display currency at each date's own
 * fixing (the country=all convention): the ad spend and estimated
 * ad-attributed royalty come from the same converting dashboard queries the
 * overview uses; the real KDP royalty (organic included) is summed from the
 * imported sale transactions by order date. The split avoids double counting
 * with organic = max(0, total − ad) — ad click-attribution dates and KDP
 * order dates never align perfectly, the same clamp the sales-mix chart uses.
 * profit = total − spend is real money and needs no book economics; only the
 * ad/organic split does.
 */

const DAY_MS = 86_400_000;

function utcToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Last day of a first-of-month ISO date ("2026-08-01" → "2026-08-31"). */
function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return isoDay(new Date(Date.UTC(year!, mon!, 0)));
}

/** Every ISO day in [start, end], ascending. */
function dayList(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(isoDay(cursor));
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return days;
}

/**
 * Resolve the optional book filter to a workspace-owned internal PK, like the
 * read service's requireBookPks: undefined = no filter, an unknown or foreign
 * book id is a 404.
 */
async function requireBookPk(
  db: Db,
  workspaceId: string,
  bookId: string | undefined,
): Promise<bigint | null> {
  if (bookId === undefined) return null;
  const book = await books.getBook(db, bookId);
  if (!book || book.workspaceId !== workspaceId) {
    throw notFound("Unknown book");
  }
  return BigInt(book.id);
}

export async function getKdpDailyProfit(
  db: Db,
  workspaceId: string,
  query: KdpDailyProfitQuery,
  now: () => Date,
): Promise<KdpDailyProfit> {
  const start = query.month;
  // The current month is still accumulating; future days have no facts.
  const end = [monthEnd(query.month), isoDay(utcToday(now()))].sort()[0]!;
  const bookPk = await requireBookPk(db, workspaceId, query.book);
  const bookPks = bookPk === null ? null : [bookPk];
  const all = await profiles.listProfilesByWorkspace(db, workspaceId);
  const enabled = all.filter((p) => p.enabled);
  const [storedDisplay, latestRateDate] = await Promise.all([
    identity.getWorkspaceDisplayCurrency(db, workspaceId),
    fx.getLatestRateDate(db),
  ]);
  const displayCurrency = storedDisplay ?? "USD";

  if (latestRateDate === null) {
    // Same posture as the all-market summary: never unconverted numbers.
    return {
      month: query.month,
      currency: displayCurrency,
      ratesAvailable: false,
      economicsMissing: false,
      kdpImported: false,
      daily: [],
    };
  }

  const profilePks = enabled.map((p) => p.id);
  const [dailyRows, royaltyRows, kdpRows] = await Promise.all([
    dashboard.convertedDailySeries(
      db,
      profilePks,
      start,
      end,
      displayCurrency,
      bookPks,
    ),
    dashboard.convertedRoyaltySeries(
      db,
      profilePks,
      start,
      end,
      displayCurrency,
      bookPks,
    ),
    kdpSales.listKdpDailyRoyalty(db, workspaceId, {
      start,
      end,
      bookPk,
      displayCurrency,
    }),
  ]);
  if (
    dailyRows.some((row) => row.ratesMissing) ||
    royaltyRows.some((row) => row.ratesMissing) ||
    kdpRows.some((row) => row.ratesMissing)
  ) {
    throw conflict(
      "FX_RATES_INCOMPLETE",
      "Stored exchange rates do not cover every fact in this month yet; the next fx_sync run closes the gap",
    );
  }

  const spendByDate = new Map(
    dailyRows.map((row) => [row.date, microsFromDecimalString(row.cost)]),
  );
  const adRoyaltyByDate = new Map(
    royaltyRows.map((row) => [
      row.date,
      row.economicsMissing || row.estimatedRoyalty === null
        ? null
        : microsFromDecimalString(row.estimatedRoyalty),
    ]),
  );
  // Imports replace whole months, so the presence of any transaction dates
  // the month as imported; days without sales are real zeros, not gaps.
  const kdpByDate = new Map(
    kdpRows.map((row) => [row.date, microsFromDecimalString(row.royalty)]),
  );
  const kdpImported = kdpRows.length > 0;
  const economicsMissing = royaltyRows.some((row) => row.economicsMissing);

  const daily: KdpDailyProfitDay[] = dayList(start, end).map((date) => {
    const adSpend = spendByDate.get(date) ?? 0;
    // A day without advertised-product facts had no ad sales — a real zero,
    // not missing data. Only a fact day with missing economics is null.
    const adRoyaltyValue = adRoyaltyByDate.get(date);
    const adRoyalty = adRoyaltyValue === undefined ? 0 : adRoyaltyValue;
    const totalRoyalty = kdpImported ? (kdpByDate.get(date) ?? 0) : null;
    const organicRoyalty =
      totalRoyalty === null || adRoyalty === null
        ? null
        : Math.max(0, totalRoyalty - adRoyalty);
    const profit = totalRoyalty === null ? null : totalRoyalty - adSpend;
    return {
      date,
      adSpend: microsToDecimalString(adSpend),
      adRoyalty: adRoyalty === null ? null : microsToDecimalString(adRoyalty),
      organicRoyalty:
        organicRoyalty === null ? null : microsToDecimalString(organicRoyalty),
      totalRoyalty:
        totalRoyalty === null ? null : microsToDecimalString(totalRoyalty),
      profit: profit === null ? null : microsToDecimalString(profit),
    };
  });

  return {
    month: query.month,
    currency: displayCurrency,
    ratesAvailable: true,
    economicsMissing,
    kdpImported,
    daily,
  };
}
