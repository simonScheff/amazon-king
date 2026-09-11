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
import { kdpMarketplacesForCountry } from "./kdp-royalty.js";

/**
 * KDP daily-profit read (GET /api/kdp/daily-profit): per-day profitability
 * over a calendar month (the /kdp-history organic tab) or an explicit day
 * range (the overview card, fed by the page's shared timeframe window). The
 * `books` product filter scopes both the ad side and the KDP side; an
 * optional `country` scopes both to one market, answered in that market's
 * native currency with no conversion (the single-country summary's
 * posture). The all-market view converts every market
 * into the workspace display currency at each date's own
 * fixing (the country=all convention): the ad spend and estimated
 * ad-attributed royalty come from the same converting dashboard queries the
 * overview uses; the real KDP royalty (organic included) is summed from the
 * imported sale transactions by royalty date — the day KDP posted the
 * royalty, matching the KDP dashboard's own display and the royalty-month
 * import periods. The split avoids double counting with
 * organic = max(0, total − ad) — ad click-attribution dates and KDP royalty
 * posting dates never align perfectly, the same clamp the sales-mix chart
 * uses.
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
 * Resolve the optional product filter to workspace-owned internal PKs, like
 * the read service's requireBookPks: undefined/empty = no filter, an unknown
 * or foreign book id is a 404.
 */
async function requireBookPks(
  db: Db,
  workspaceId: string,
  bookIds: string[] | undefined,
): Promise<bigint[] | null> {
  if (!bookIds || bookIds.length === 0) return null;
  const pks: bigint[] = [];
  for (const bookId of bookIds) {
    const book = await books.getBook(db, bookId);
    if (!book || book.workspaceId !== workspaceId) {
      throw notFound("Unknown book");
    }
    pks.push(BigInt(book.id));
  }
  return pks;
}

export async function getKdpDailyProfit(
  db: Db,
  workspaceId: string,
  query: KdpDailyProfitQuery,
  now: () => Date,
): Promise<KdpDailyProfit> {
  const today = isoDay(utcToday(now()));
  // Month mode observes the whole calendar month; range mode the explicit
  // window. Either way the end caps at today — future days have no facts.
  const start = query.month ?? query.start!;
  const rangeEnd = query.month ? monthEnd(query.month) : query.end!;
  const end = rangeEnd < today ? rangeEnd : today;
  const bookPks = await requireBookPks(db, workspaceId, query.books);
  // Absent (or "all") is the all-market converted view; a two-letter market
  // answers in that market's native currency.
  const country = query.country ?? "all";
  const all = await profiles.listProfilesByWorkspace(db, workspaceId);
  const enabled = all.filter(
    (p) => p.enabled && (country === "all" || p.countryCode === country),
  );
  const [storedDisplay, latestRateDate] = await Promise.all([
    identity.getWorkspaceDisplayCurrency(db, workspaceId),
    fx.getLatestRateDate(db),
  ]);
  const displayCurrency = storedDisplay ?? "USD";

  if (country === "all" && latestRateDate === null) {
    // Same posture as the all-market summary: never unconverted numbers.
    return {
      start,
      end,
      currency: displayCurrency,
      ratesAvailable: false,
      economicsMissing: false,
      kdpImported: false,
      daily: [],
    };
  }

  const profilePks = enabled.map((p) => p.id);

  let currency = displayCurrency;
  let spendByDate: Map<string, number>;
  let adRoyaltyByDate: Map<string, number | null>;
  let kdpByDate: Map<string, number>;
  let kdpImported: boolean;
  let economicsMissing: boolean;

  if (country === "all") {
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
        bookPks,
        marketplaces: null,
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
        "Stored exchange rates do not cover every fact in this range yet; the next fx_sync run closes the gap",
      );
    }
    spendByDate = new Map(
      dailyRows.map((row) => [row.date, microsFromDecimalString(row.cost)]),
    );
    adRoyaltyByDate = new Map(
      royaltyRows.map((row) => [
        row.date,
        row.economicsMissing || row.estimatedRoyalty === null
          ? null
          : microsFromDecimalString(row.estimatedRoyalty),
      ]),
    );
    kdpByDate = new Map(
      kdpRows.map((row) => [row.date, microsFromDecimalString(row.royalty)]),
    );
    kdpImported = kdpRows.length > 0;
    economicsMissing = royaltyRows.some((row) => row.economicsMissing);
  } else {
    // Single market: native currency, no conversion — the same posture as
    // the single-country dashboard summary. Rows stay per profile × date,
    // merged here after the currency check.
    const [dailyRows, royaltyRows, kdpRows] = await Promise.all([
      dashboard.dailySeries(db, profilePks, start, end, bookPks),
      dashboard.overviewRoyaltySeries(db, profilePks, start, end, bookPks),
      kdpSales.listKdpDailyRoyaltyNative(db, workspaceId, {
        start,
        end,
        bookPks,
        marketplaces: kdpMarketplacesForCountry(country),
      }),
    ]);
    const currencies = new Set(
      [...dailyRows, ...royaltyRows, ...kdpRows].map((row) => row.currency),
    );
    if (currencies.size > 1) {
      throw conflict(
        "MIXED_CURRENCY",
        "Profiles use different currencies; refusing to aggregate (plan §9)",
      );
    }
    currency = currencies.values().next().value ?? displayCurrency;
    spendByDate = new Map();
    for (const row of dailyRows) {
      spendByDate.set(
        row.date,
        (spendByDate.get(row.date) ?? 0) + microsFromDecimalString(row.cost),
      );
    }
    adRoyaltyByDate = new Map();
    for (const row of royaltyRows) {
      const existing = adRoyaltyByDate.get(row.date);
      if (row.economicsMissing || row.estimatedRoyalty === null) {
        adRoyaltyByDate.set(row.date, null);
      } else if (existing !== null) {
        adRoyaltyByDate.set(
          row.date,
          (existing ?? 0) + microsFromDecimalString(row.estimatedRoyalty),
        );
      }
    }
    kdpByDate = new Map();
    for (const row of kdpRows) {
      kdpByDate.set(
        row.date,
        (kdpByDate.get(row.date) ?? 0) + microsFromDecimalString(row.royalty),
      );
    }
    kdpImported = kdpRows.length > 0;
    economicsMissing = royaltyRows.some((row) => row.economicsMissing);
  }

  // The presence of any transaction dates the range as imported; days
  // without sales are real zeros, not gaps.
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
    start,
    end,
    currency,
    ratesAvailable: true,
    economicsMissing,
    kdpImported,
    daily,
  };
}
