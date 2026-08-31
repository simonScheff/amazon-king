import type {
  MetricWindow,
  SpendBreakdown,
  SpendBreakdownEntity,
  SpendGrain,
  SpendTree,
} from "@amazon-king/contracts";
import {
  microsFromDecimalString,
  microsToDecimalString,
} from "@amazon-king/optimizer";
import { fx, identity, profiles, spend, type Db } from "@amazon-king/database";
import { conflict } from "./errors.js";
import { dateRange, dayList, previousDateRange } from "./date-ranges.js";

/**
 * Spend explorer reads (GET /api/spend/breakdown and /api/spend/tree). Both
 * group daily facts by market, campaign, or search term; with `country=all`
 * every fact is converted at its own metric date into one display currency
 * (same USD-pivot convention as the overview summary), and both endpoints
 * refuse to answer with silently unconverted numbers: an empty fx_rates table
 * yields zeroed figures with `ratesAvailable: false`, partial coverage a 409.
 */

/** How many entities the breakdown keeps before folding the rest into `other`. */
const BREAKDOWN_TOP_N = 12;
/** How many children each treemap parent keeps before folding into "Other". */
const TREE_CHILD_CAP = 10;

interface EntityAcc {
  id: string;
  name: string;
  spendMicros: number;
  salesMicros: number;
  orders: number;
  /** date → spend micros */
  daily: Map<string, number>;
}

function emptyAcc(id: string, name: string): EntityAcc {
  return {
    id,
    name,
    spendMicros: 0,
    salesMicros: 0,
    orders: 0,
    daily: new Map(),
  };
}

/** Merge series rows into per-entity accumulators, keyed by entity id. */
function aggregate(
  rows: readonly spend.SpendSeriesRow[],
): Map<string, EntityAcc> {
  const byId = new Map<string, EntityAcc>();
  for (const row of rows) {
    const acc = byId.get(row.id) ?? emptyAcc(row.id, row.name);
    const spendMicros = microsFromDecimalString(row.spend);
    acc.spendMicros += spendMicros;
    acc.salesMicros += microsFromDecimalString(row.sales);
    acc.orders += row.orders;
    acc.daily.set(row.date, (acc.daily.get(row.date) ?? 0) + spendMicros);
    byId.set(row.id, acc);
  }
  return byId;
}

/** Per-day series over [start, end], zero-filled so charts align per day. */
function zeroFilledDaily(
  daily: ReadonlyMap<string, number>,
  days: readonly string[],
): { date: string; spend: string }[] {
  return days.map((date) => ({
    date,
    spend: microsToDecimalString(daily.get(date) ?? 0),
  }));
}

function acosOf(spendMicros: number, salesMicros: number): number | null {
  return salesMicros > 0 ? spendMicros / salesMicros : null;
}

interface SpendContext {
  profilePks: string[];
  currency: string;
  ratesAvailable: boolean;
  converted: boolean;
}

/**
 * Resolve the profile set, the currency of the answer, and the FX posture.
 * With `country=all` this is the all-market convention: the display currency
 * is the request's override or the workspace setting, and an empty fx_rates
 * table reports `ratesAvailable: false` instead of numbers. Single-country
 * answers stay in the facts' native currency (resolved after the fetch;
 * `currency` here is only the no-facts fallback).
 */
async function spendContext(
  db: Db,
  workspaceId: string,
  countryCode: string,
  displayCurrency: string | undefined,
): Promise<SpendContext> {
  const all = await profiles.listProfilesByWorkspace(db, workspaceId);
  const enabled = all.filter(
    (p) =>
      p.enabled && (countryCode === "all" || p.countryCode === countryCode),
  );
  const latestRateDate = await fx.getLatestRateDate(db);
  if (countryCode === "all") {
    const storedDisplay =
      displayCurrency === undefined
        ? await identity.getWorkspaceDisplayCurrency(db, workspaceId)
        : null;
    return {
      profilePks: enabled.map((p) => p.id),
      currency: displayCurrency ?? storedDisplay ?? "USD",
      ratesAvailable: latestRateDate !== null,
      converted: true,
    };
  }
  return {
    profilePks: enabled.map((p) => p.id),
    currency: enabled[0]?.currencyCode ?? "USD",
    ratesAvailable: latestRateDate !== null,
    converted: false,
  };
}

/** Fetch one window's series, converted or native per the context. */
function fetchSeries(
  db: Db,
  ctx: SpendContext,
  grain: SpendGrain,
  start: string,
  end: string,
): Promise<spend.SpendSeriesRow[]> {
  return ctx.converted
    ? spend.convertedSpendDailySeries(
        db,
        grain,
        ctx.profilePks,
        start,
        end,
        ctx.currency,
      )
    : spend.spendDailySeries(db, grain, ctx.profilePks, start, end);
}

/** Single-country answers stay in the facts' one native currency. */
function singleCurrencyOf(
  rows: readonly spend.SpendSeriesRow[],
): string | null {
  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.size > 1) {
    throw conflict(
      "MIXED_CURRENCY",
      "Profiles use different currencies; refusing to aggregate (plan §9)",
    );
  }
  return currencies.values().next().value ?? null;
}

function throwIfRatesMissing(rows: readonly spend.SpendSeriesRow[]): void {
  if (rows.some((row) => row.ratesMissing)) {
    throw conflict(
      "FX_RATES_INCOMPLETE",
      "Stored exchange rates do not cover every fact in this window yet; the next fx_sync run closes the gap",
    );
  }
}

export async function getSpendBreakdown(
  db: Db,
  workspaceId: string,
  params: {
    grain: SpendGrain;
    days: MetricWindow;
    country: string;
    currency?: string;
  },
  now: () => Date,
): Promise<SpendBreakdown> {
  const { grain, days: window, country } = params;
  const { start, end } = dateRange(now(), window);
  const previous = previousDateRange(now(), window);
  const ctx = await spendContext(db, workspaceId, country, params.currency);
  const days = dayList(start, end);

  const emptyBreakdown = (
    currency: string,
    ratesAvailable: boolean,
  ): SpendBreakdown => ({
    grain,
    dateRange: { start, end },
    previousDateRange: previous,
    currency: currency as SpendBreakdown["currency"],
    ratesAvailable,
    totals: {
      spend: microsToDecimalString(0),
      sales: microsToDecimalString(0),
      previousSpend: microsToDecimalString(0),
    },
    entities: [],
    other: {
      spend: microsToDecimalString(0),
      daily: zeroFilledDaily(new Map(), days),
    },
  });

  // The all-market view without any stored rates reports zeroed figures
  // rather than unconverted numbers (same posture as the summary).
  if (ctx.converted && !ctx.ratesAvailable) {
    return emptyBreakdown(ctx.currency, false);
  }
  if (ctx.profilePks.length === 0) {
    return emptyBreakdown(ctx.currency, ctx.ratesAvailable);
  }

  const [currentRows, previousRows] = await Promise.all([
    fetchSeries(db, ctx, grain, start, end),
    fetchSeries(db, ctx, grain, previous.start, previous.end),
  ]);
  if (ctx.converted) {
    throwIfRatesMissing(currentRows);
    throwIfRatesMissing(previousRows);
  }

  let currency = ctx.currency;
  if (!ctx.converted) {
    currency =
      singleCurrencyOf(currentRows) ??
      singleCurrencyOf(previousRows) ??
      ctx.currency;
  }

  const currentById = aggregate(currentRows);
  const previousById = aggregate(previousRows);

  const sorted = [...currentById.values()].sort(
    (a, b) => b.spendMicros - a.spendMicros || a.id.localeCompare(b.id),
  );
  const top = sorted.slice(0, BREAKDOWN_TOP_N);
  const rest = sorted.slice(BREAKDOWN_TOP_N);

  const otherAcc = emptyAcc("other", "Other");
  for (const acc of rest) {
    otherAcc.spendMicros += acc.spendMicros;
    for (const [date, value] of acc.daily) {
      otherAcc.daily.set(date, (otherAcc.daily.get(date) ?? 0) + value);
    }
  }

  const entities: SpendBreakdownEntity[] = top.map((acc) => ({
    id: acc.id,
    name: acc.name,
    spend: microsToDecimalString(acc.spendMicros),
    sales: microsToDecimalString(acc.salesMicros),
    orders: acc.orders,
    acos: acosOf(acc.spendMicros, acc.salesMicros),
    previousSpend: microsToDecimalString(
      previousById.get(acc.id)?.spendMicros ?? 0,
    ),
    daily: zeroFilledDaily(acc.daily, days),
  }));

  let totalSpend = 0;
  let totalSales = 0;
  for (const acc of currentById.values()) {
    totalSpend += acc.spendMicros;
    totalSales += acc.salesMicros;
  }
  let totalPreviousSpend = 0;
  for (const acc of previousById.values()) {
    totalPreviousSpend += acc.spendMicros;
  }

  return {
    grain,
    dateRange: { start, end },
    previousDateRange: previous,
    currency: currency as SpendBreakdown["currency"],
    ratesAvailable: ctx.ratesAvailable,
    totals: {
      spend: microsToDecimalString(totalSpend),
      sales: microsToDecimalString(totalSales),
      previousSpend: microsToDecimalString(totalPreviousSpend),
    },
    entities,
    other: {
      spend: microsToDecimalString(otherAcc.spendMicros),
      daily: zeroFilledDaily(otherAcc.daily, days),
    },
  };
}

export async function getSpendTree(
  db: Db,
  workspaceId: string,
  params: {
    days: MetricWindow;
    country: string;
    currency?: string;
  },
  now: () => Date,
): Promise<SpendTree> {
  const { days: window, country } = params;
  const { start, end } = dateRange(now(), window);
  const ctx = await spendContext(db, workspaceId, country, params.currency);

  // The hierarchy flips with the market selection: across markets the roots
  // are markets and the children campaigns; inside one market the roots are
  // campaigns and the children the search terms that served there.
  const rootGrain: SpendGrain = country === "all" ? "market" : "campaign";
  const childGrain: SpendGrain = country === "all" ? "campaign" : "searchTerm";

  const emptyTree = (currency: string, ratesAvailable: boolean): SpendTree => ({
    dateRange: { start, end },
    currency: currency as SpendTree["currency"],
    ratesAvailable,
    roots: [],
  });

  if (ctx.converted && !ctx.ratesAvailable) {
    return emptyTree(ctx.currency, false);
  }
  if (ctx.profilePks.length === 0) {
    return emptyTree(ctx.currency, ctx.ratesAvailable);
  }

  const [rootRows, childRows] = await Promise.all([
    fetchSeries(db, ctx, rootGrain, start, end),
    fetchSeries(db, ctx, childGrain, start, end),
  ]);
  if (ctx.converted) {
    throwIfRatesMissing(rootRows);
    throwIfRatesMissing(childRows);
  }

  let currency = ctx.currency;
  if (!ctx.converted) {
    currency =
      singleCurrencyOf(rootRows) ?? singleCurrencyOf(childRows) ?? ctx.currency;
  }

  const rootById = aggregate(rootRows);
  const realRootIds = new Set(rootRows.map((row) => row.id));

  // Children aggregate per parent, never across parents. A child whose
  // parent has no root row (e.g. search-term facts for a campaign with no
  // campaign-level fact in the window) synthesizes a parent so its spend is
  // not silently dropped.
  const rowsByParent = new Map<string, spend.SpendSeriesRow[]>();
  for (const row of childRows) {
    if (row.parent === null) continue;
    const list = rowsByParent.get(row.parent) ?? [];
    list.push(row);
    rowsByParent.set(row.parent, list);
  }
  const childrenByParent = new Map<string, EntityAcc[]>();
  for (const [parent, rows] of rowsByParent) {
    childrenByParent.set(parent, [...aggregate(rows).values()]);
    if (!rootById.has(parent)) {
      rootById.set(parent, emptyAcc(parent, parent));
    }
  }

  const rootsWithTotals = [...rootById.values()].map((root) => {
    const children = (childrenByParent.get(root.id) ?? []).sort(
      (a, b) => b.spendMicros - a.spendMicros || a.id.localeCompare(b.id),
    );
    // A synthesized parent sums its children; a real one keeps its own totals.
    const synthesized = !realRootIds.has(root.id);
    const spendMicros = synthesized
      ? children.reduce((sum, child) => sum + child.spendMicros, 0)
      : root.spendMicros;
    const salesMicros = synthesized
      ? children.reduce((sum, child) => sum + child.salesMicros, 0)
      : root.salesMicros;
    return { root, children, spendMicros, salesMicros };
  });

  const roots = rootsWithTotals
    .sort(
      (a, b) =>
        b.spendMicros - a.spendMicros || a.root.id.localeCompare(b.root.id),
    )
    .map(({ root, children, spendMicros, salesMicros }) => {
      const kept = children.slice(0, TREE_CHILD_CAP);
      const folded = children.slice(TREE_CHILD_CAP);
      let otherSpendMicros = 0;
      let otherSalesMicros = 0;
      for (const acc of folded) {
        otherSpendMicros += acc.spendMicros;
        otherSalesMicros += acc.salesMicros;
      }
      const childNodes = kept.map((child) => ({
        id: child.id,
        name: child.name,
        kind: childGrain,
        spend: microsToDecimalString(child.spendMicros),
        sales: microsToDecimalString(child.salesMicros),
        acos: acosOf(child.spendMicros, child.salesMicros),
      }));
      if (folded.length > 0) {
        childNodes.push({
          id: "other",
          name: "Other",
          kind: childGrain,
          spend: microsToDecimalString(otherSpendMicros),
          sales: microsToDecimalString(otherSalesMicros),
          acos: acosOf(otherSpendMicros, otherSalesMicros),
        });
      }
      return {
        id: root.id,
        name: root.name,
        kind: rootGrain,
        spend: microsToDecimalString(spendMicros),
        sales: microsToDecimalString(salesMicros),
        acos: acosOf(spendMicros, salesMicros),
        children: childNodes,
      };
    });

  return {
    dateRange: { start, end },
    currency: currency as SpendTree["currency"],
    ratesAvailable: ctx.ratesAvailable,
    roots,
  };
}
