import type {
  AmazonProfile,
  Book,
  CannibalizationResolutionContext,
  ConversionResolutionContext,
  CountrySpend,
  DashboardSummary,
  FxRatesStatus,
  FxSyncResult,
  MetricWindow,
  SearchTermDetail,
  SearchTermExclusionList,
  SearchTermListRow,
  NegativeDetail,
  NegativeKind,
  NegativeListRow,
  NegativePeriodTotals,
  SearchTermCampaignRow,
  WorkspaceSettings,
} from "@amazon-king/contracts";
import {
  blockedCampaignIds,
  keywordSpecsFromNegativeTargets,
  matchesNegative,
  microsFromDecimalString,
  microsToDecimalString,
  type NegativeKeywordSpec,
  type NegativeTargetSpec,
} from "@amazon-king/optimizer";
import {
  audit,
  books,
  changes,
  connections,
  dashboard,
  enqueue,
  enqueueIfNotQueued,
  exclusions,
  fx,
  identity,
  metrics,
  profiles,
  recommendations,
  reports,
  structure,
  type Db,
} from "@amazon-king/database";
import { z } from "zod";
import {
  DAY_MS,
  dateRange,
  isoDay,
  previousDateRange,
  utcToday,
} from "./date-ranges.js";
import { ApiError, conflict, notFound } from "./errors.js";
import { getKdpHistory, listKdpTransactions } from "./kdp-history.js";
import { getKdpDailyProfit } from "./daily-profit.js";
import { getSpendBreakdown, getSpendTree } from "./spend.js";
import {
  applyKdpRoyaltyImport,
  createKdpRoyaltyImport,
  listKdpRoyaltyImports,
} from "./kdp-royalty.js";
import {
  amazonConsoleUrl,
  coverImageUrlOf,
  isoDate,
  isoDateTime,
  toContractAuditEvent,
  toContractChangeSet,
  toContractProfile,
  toContractRecommendation,
  toContractSyncRun,
  toContractSyncRunSummary,
} from "./serialize.js";
import type {
  AuthContext,
  ReadService,
  ReadServiceConfig,
  ReadServiceLogger,
  RequestMeta,
} from "./types.js";

/** Read-side service: dashboard, profiles, campaigns, books, recommendations. */

export interface ReadServiceDeps {
  db: Db;
  config: ReadServiceConfig;
  logger: ReadServiceLogger;
  now?: () => Date;
}

const MANUAL_SYNC_HISTORY_DAYS = 60;
/**
 * How long a rejected finding stays suppressed. Matches the longest optimizer
 * evidence window, so the metrics that produced it have fully rolled out of
 * every window before it can be raised again.
 */
const REJECTION_SUPPRESSION_DAYS = 60;

/**
 * Inputs `evaluateHighCtrPoorConversion` stores. Only the measurements the
 * resolution screen shows are required; the rule's thresholds are ignored
 * here because the screen states what was observed, not how it was judged.
 */
const conversionEvidenceSchema = z.object({
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
  costMicros: z.number().nonnegative(),
  ctr: z.number().nonnegative(),
  cvr: z.number().nonnegative(),
});

/**
 * Fraction of the observed average CPC offered as a starting ceiling. A
 * break-even CPC cannot be computed for this finding — that needs a
 * conversion rate, and the whole point of the finding is that there is none —
 * so the screen offers a cut below what clicks currently cost and lets the
 * author change it.
 */
const SUGGESTED_MAX_CPC_FRACTION = 0.7;
/** Amazon's lowest accepted bid in every marketplace the MVP supports. */
const MIN_SUGGESTED_MAX_CPC_MICROS = 20_000;
/** How many zero-order shopper terms the resolution screen offers to block. */
const MAX_WASTEFUL_TERMS = 20;

function isSearchTermAlreadyNegated(
  term: string,
  keywords: ReadonlyArray<{
    keywordText: string;
    matchType: string;
    state: string;
  }>,
  targets: ReadonlyArray<{ asin: string; state: string }>,
): boolean {
  const specs = [
    ...keywords.map((row) => ({
      campaignId: "",
      adGroupId: null,
      keywordText: row.keywordText,
      matchType: row.matchType,
      state: row.state,
    })),
    ...keywordSpecsFromNegativeTargets(
      targets.map((row) => ({
        campaignId: "",
        adGroupId: null,
        asin: row.asin,
        state: row.state,
      })),
    ),
  ];
  return specs.some((negative) => matchesNegative(term, negative));
}

const cannibalizationEvidenceSchema = z.object({
  searchTerm: z.string().min(1),
  campaigns: z
    .array(
      z.object({
        campaignId: z.string(),
        orders: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
      }),
    )
    .min(2),
});

const MATCHED_PHRASE_CAP = 20;

/** Same normalization as the optimizer / exclusion list. */
function negativeValueKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isEnabledAmazonState(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "enabled" || normalized === "active";
}

function isPhraseMatchType(matchType: string): boolean {
  return (
    matchType
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, "")
      .replace(/^negative/, "") === "phrase"
  );
}

function preferUsCountryCodes(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort((a, b) => {
    if (a === "US") return -1;
    if (b === "US") return 1;
    return a.localeCompare(b);
  });
}

function toNegativePeriod(
  period: dashboard.NegativePeriodTotalsData,
): NegativePeriodTotals {
  const costMicros = microsFromDecimalString(period.totals.cost);
  const salesMicros = microsFromDecimalString(period.totals.sales);
  const royaltyMicros =
    period.estimatedRoyalty === null
      ? null
      : microsFromDecimalString(period.estimatedRoyalty);
  return {
    ...period.totals,
    acos: salesMicros > 0 ? costMicros / salesMicros : null,
    estimatedRoyalty:
      royaltyMicros === null ? null : microsToDecimalString(royaltyMicros),
    estimatedAdProfit:
      royaltyMicros === null
        ? null
        : microsToDecimalString(royaltyMicros - costMicros),
    economicsMissing: period.economicsMissing,
  };
}

function searchTermCampaignFromFacts(
  row: dashboard.SearchTermCampaignRowData,
): SearchTermCampaignRow {
  const rowCostMicros = microsFromDecimalString(row.totals.cost);
  const rowRoyaltyMicros =
    row.estimatedRoyalty === null
      ? null
      : microsFromDecimalString(row.estimatedRoyalty);
  return {
    profileId: row.amazonProfileId,
    campaignId: row.amazonCampaignId,
    name: row.name,
    state: row.state,
    totals: row.totals,
    estimatedRoyalty:
      rowRoyaltyMicros === null
        ? null
        : microsToDecimalString(rowRoyaltyMicros),
    estimatedAdProfit:
      rowRoyaltyMicros === null
        ? null
        : microsToDecimalString(rowRoyaltyMicros - rowCostMicros),
    economicsMissing: row.economicsMissing,
  };
}

function specKeywordSpecs(
  specs: readonly dashboard.NegativeSpecRowData[],
): NegativeKeywordSpec[] {
  const keywords: NegativeKeywordSpec[] = specs
    .filter((spec) => spec.kind === "keyword")
    .map((spec) => ({
      campaignId: spec.amazonCampaignId,
      adGroupId: spec.amazonAdGroupId,
      keywordText: spec.valueKey,
      matchType: spec.matchType,
      state: spec.negativeState,
    }));
  const targets: NegativeTargetSpec[] = specs
    .filter((spec) => spec.kind === "product")
    .map((spec) => ({
      campaignId: spec.amazonCampaignId,
      adGroupId: spec.amazonAdGroupId,
      asin: spec.valueKey,
      state: spec.negativeState,
    }));
  return [...keywords, ...keywordSpecsFromNegativeTargets(targets)];
}

function servingAdGroupsByCampaign(
  serving: readonly dashboard.NegativeServingRowData[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of serving) {
    const set = map.get(row.amazonCampaignId) ?? new Set<string>();
    set.add(row.amazonAdGroupId);
    map.set(row.amazonCampaignId, set);
  }
  return map;
}

function stillServingCampaignCount(
  term: string,
  specs: readonly dashboard.NegativeSpecRowData[],
  serving: readonly dashboard.NegativeServingRowData[],
): number {
  const blocked = blockedCampaignIds(
    term,
    specKeywordSpecs(specs),
    servingAdGroupsByCampaign(serving),
  );
  const ids = new Set<string>();
  for (const row of serving) {
    if (!isEnabledAmazonState(row.campaignState)) continue;
    if (blocked.has(row.amazonCampaignId)) continue;
    ids.add(row.amazonCampaignId);
  }
  return ids.size;
}

function pickBlockingSpec(
  specs: readonly dashboard.NegativeSpecRowData[],
): dashboard.NegativeSpecRowData {
  return [...specs].sort((left, right) => {
    const leftLive =
      isEnabledAmazonState(left.campaignState) &&
      isEnabledAmazonState(left.negativeState)
        ? 0
        : 1;
    const rightLive =
      isEnabledAmazonState(right.campaignState) &&
      isEnabledAmazonState(right.negativeState)
        ? 0
        : 1;
    if (leftLive !== rightLive) return leftLive - rightLive;
    const leftLevel = left.level === "campaign" ? 0 : 1;
    const rightLevel = right.level === "campaign" ? 0 : 1;
    if (leftLevel !== rightLevel) return leftLevel - rightLevel;
    return left.amazonNegativeId.localeCompare(right.amazonNegativeId);
  })[0]!;
}

/** Market picker order on the search-term detail: US first, then A–Z. */
function sortMarketCodes(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => {
    if (a === "US") return -1;
    if (b === "US") return 1;
    return a.localeCompare(b);
  });
}

/** Map a raw job_queue status to the contract's fx_sync run state. */
function fxRunState(status: string | null): FxRatesStatus["lastRunState"] {
  if (status === null) return "never_run";
  if (status === "done") return "succeeded";
  if (status === "running") return "running";
  // 'failed', 'dead', or 'pending' after a failed attempt (retry backoff).
  return "failed";
}

/** Most recent business day (Mon–Fri, UTC) strictly before today. */
function previousBusinessDay(now: Date): string {
  const day = new Date(utcToday(now).getTime() - DAY_MS);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
    day.setTime(day.getTime() - DAY_MS);
  }
  return isoDay(day);
}

/**
 * Rates are stale when the newest stored fixing predates the last business
 * day. Weekend fixings do not exist, so a Friday fixing is still fresh on
 * Sunday (docs/fx-rates-all-market-plan.md, decision 7). An empty rate table
 * counts as stale.
 */
function fxRatesStale(latestRateDate: string | null, now: Date): boolean {
  if (latestRateDate === null) return true;
  return latestRateDate < previousBusinessDay(now);
}

/** Map the raw fx_rates/job_queue health to the contract FX status. */
function toContractFxRatesStatus(
  status: fx.FxSyncStatus,
  now: Date,
): FxRatesStatus {
  return {
    latestRateDate: status.latestRateDate,
    lastRunState: fxRunState(status.lastStatus),
    lastRunAt: status.lastRunAt ? isoDateTime(status.lastRunAt) : null,
    lastError: status.lastError,
    stale: fxRatesStale(status.latestRateDate, now),
  };
}

export function createReadService(deps: ReadServiceDeps): ReadService {
  const { db, config } = deps;
  const now = () => deps.now?.() ?? new Date();

  async function requireProfile(workspaceId: string, amazonProfileId: string) {
    const profile = await profiles.findProfileByAmazonId(
      db,
      workspaceId,
      amazonProfileId,
    );
    if (!profile) {
      throw notFound("Unknown profile");
    }
    return profile;
  }

  async function toContractBook(book: books.Book): Promise<Book> {
    const savedEconomics = await books.listLatestBookEconomicsByWorkspace(
      db,
      book.workspaceId,
    );
    const profileIds =
      book.profileIds.length > 0
        ? book.profileIds
        : book.marketplaceAsins.map((entry) => entry.profileId);
    return {
      id: book.id,
      asin: book.asin,
      title: book.title,
      format: book.format,
      status: book.status,
      coverImageUrl: coverImageUrlOf(book.coverJson),
      profileIds,
      marketplaceAsins: book.marketplaceAsins,
      economics: savedEconomics
        .filter((economics) => economics.bookId === book.id)
        .map((economics) => ({
          profileId: economics.amazonProfileId,
          effectiveFrom: isoDate(economics.effectiveFrom),
          currency: economics.currency,
          listPrice: economics.listPrice,
          estimatedRoyaltyPerSale: economics.estimatedRoyaltyPerSale,
          targetAcos:
            economics.targetAcos === null ? null : Number(economics.targetAcos),
          goalMode: economics.goalMode,
          maxSpendWithoutSale: economics.maxSpendWithoutSale,
          maxBid: economics.maxBid,
          maxDailyBudget: economics.maxDailyBudget,
          notes: economics.notes,
        })),
    };
  }

  /** Resolve an optional product filter to a workspace-owned book. */
  async function requireBook(workspaceId: string, bookId: string | null) {
    if (bookId === null) return null;
    const book = await books.getBook(db, bookId);
    if (!book || book.workspaceId !== workspaceId) {
      throw notFound("Unknown book");
    }
    return book.id;
  }

  /**
   * Resolve the product filter's external book ids to workspace-owned
   * internal PKs (bigint for the repositories). Null/empty = no filter;
   * an unknown or foreign book id is a 404, exactly like a single id.
   */
  async function requireBookPks(
    workspaceId: string,
    bookIds: string[] | null | undefined,
  ): Promise<bigint[] | null> {
    if (!bookIds || bookIds.length === 0) return null;
    const pks: bigint[] = [];
    for (const bookId of bookIds) {
      pks.push(BigInt((await requireBook(workspaceId, bookId))!));
    }
    return pks;
  }

  /**
   * All-market overview (docs/fx-rates-all-market-plan.md §4): every enabled
   * profile, each fact converted at its own metric date's fixing into one
   * display currency (the request's `currency` or the workspace's display
   * currency). With an empty fx_rates table the response carries zeroed
   * totals and `ratesAvailable: false` — never silently unconverted numbers
   * (decision 8); partial coverage is a conflict, not a guess. Royalty keeps
   * the single-country rules: per-book per-marketplace economics, per-copy
   * valuation, and missing economics hide profit rather than guessing.
   */
  async function dashboardSummaryAllMarkets(
    workspaceId: string,
    days: MetricWindow,
    bookIds: string[] | undefined,
    currencyParam: string | undefined,
  ): Promise<DashboardSummary> {
    const { start, end } = dateRange(now(), days);
    const previous = previousDateRange(now(), days);
    const bookPks = await requireBookPks(workspaceId, bookIds);
    const all = await profiles.listProfilesByWorkspace(db, workspaceId);
    const enabled = all.filter((p) => p.enabled);
    const [storedDisplay, latestRateDate] = await Promise.all([
      currencyParam === undefined
        ? identity.getWorkspaceDisplayCurrency(db, workspaceId)
        : Promise.resolve(null),
      fx.getLatestRateDate(db),
    ]);
    const displayCurrency = (currencyParam ??
      storedDisplay ??
      "USD") as DashboardSummary["currency"];
    const ratesAvailable = latestRateDate !== null;
    const writesDisabled =
      config.killSwitch || enabled.every((p) => !p.writeEnabled);

    const zeroTotals = () => ({
      impressions: 0,
      clicks: 0,
      cost: microsToDecimalString(0),
      sales: microsToDecimalString(0),
      orders: 0,
      units: 0,
      acos: null,
      estimatedRoyalty: null,
      estimatedAdProfit: null,
    });

    if (!ratesAvailable) {
      return {
        dateRange: { start, end },
        currency: displayCurrency,
        ratesAvailable: false,
        totals: zeroTotals(),
        previous: {
          dateRange: { start: previous.start, end: previous.end },
          totals: zeroTotals(),
        },
        economicsMissing: true,
        dataCurrentThrough: `${start}T00:00:00.000Z`,
        writesDisabled,
        daily: [],
      };
    }

    const profilePks = enabled.map((p) => p.id);
    const [
      current,
      previousWindow,
      royaltyRows,
      previousRoyaltyRows,
      dailyRows,
    ] = await Promise.all([
      dashboard.convertedDailyTotals(
        db,
        profilePks,
        start,
        end,
        displayCurrency,
        bookPks,
      ),
      dashboard.convertedDailyTotals(
        db,
        profilePks,
        previous.start,
        previous.end,
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
      dashboard.convertedRoyaltySeries(
        db,
        profilePks,
        previous.start,
        previous.end,
        displayCurrency,
        bookPks,
      ),
      dashboard.convertedDailySeries(
        db,
        profilePks,
        start,
        end,
        displayCurrency,
        bookPks,
      ),
    ]);
    if (
      current.ratesMissing ||
      previousWindow.ratesMissing ||
      royaltyRows.some((row) => row.ratesMissing) ||
      previousRoyaltyRows.some((row) => row.ratesMissing) ||
      dailyRows.some((row) => row.ratesMissing)
    ) {
      throw conflict(
        "FX_RATES_INCOMPLETE",
        "Stored exchange rates do not cover every fact in this window yet; the next fx_sync run closes the gap",
      );
    }

    function royaltyFromSeries(
      points: readonly {
        estimatedRoyalty: string | null;
        economicsMissing: boolean;
      }[],
      orders: number,
    ): { micros: number | null; missing: boolean } {
      if (enabled.length === 0) {
        return { micros: null, missing: true };
      }
      if (
        points.some((p) => p.economicsMissing || p.estimatedRoyalty === null)
      ) {
        return { micros: null, missing: true };
      }
      if (orders > 0 && points.length === 0) {
        return { micros: null, missing: true };
      }
      let total = 0;
      for (const point of points) {
        total += microsFromDecimalString(point.estimatedRoyalty ?? "0");
      }
      return { micros: total, missing: false };
    }

    const currentRoyalty = royaltyFromSeries(royaltyRows, current.orders);
    const previousRoyalty = royaltyFromSeries(
      previousRoyaltyRows,
      previousWindow.orders,
    );
    const economicsMissing = currentRoyalty.missing;
    const estimatedRoyaltyMicros = currentRoyalty.micros;
    const previousEstimatedRoyaltyMicros = previousRoyalty.missing
      ? null
      : previousRoyalty.micros;

    const royaltyByDate = new Map<string, number | null>();
    for (const row of royaltyRows) {
      royaltyByDate.set(
        row.date,
        economicsMissing ||
          row.economicsMissing ||
          row.estimatedRoyalty === null
          ? null
          : microsFromDecimalString(row.estimatedRoyalty),
      );
    }

    const currentCostMicros = microsFromDecimalString(current.cost);
    const currentSalesMicros = microsFromDecimalString(current.sales);
    const previousCostMicros = microsFromDecimalString(previousWindow.cost);
    const previousSalesMicros = microsFromDecimalString(previousWindow.sales);

    const daily = dailyRows.map((row) => {
      const royaltyMicros = economicsMissing
        ? null
        : (royaltyByDate.get(row.date) ?? 0);
      return {
        date: row.date,
        cost: microsToDecimalString(microsFromDecimalString(row.cost)),
        sales: microsToDecimalString(microsFromDecimalString(row.sales)),
        orders: row.orders,
        estimatedRoyalty:
          royaltyMicros === null ? null : microsToDecimalString(royaltyMicros),
      };
    });
    const lastDataDate = daily.at(-1)?.date ?? null;

    return {
      dateRange: { start, end },
      currency: displayCurrency,
      ratesAvailable: true,
      totals: {
        impressions: current.impressions,
        clicks: current.clicks,
        cost: microsToDecimalString(currentCostMicros),
        sales: microsToDecimalString(currentSalesMicros),
        orders: current.orders,
        units: current.units,
        acos:
          currentSalesMicros > 0
            ? currentCostMicros / currentSalesMicros
            : null,
        estimatedRoyalty:
          estimatedRoyaltyMicros === null
            ? null
            : microsToDecimalString(estimatedRoyaltyMicros),
        estimatedAdProfit:
          estimatedRoyaltyMicros === null
            ? null
            : microsToDecimalString(estimatedRoyaltyMicros - currentCostMicros),
      },
      previous: {
        dateRange: { start: previous.start, end: previous.end },
        totals: {
          impressions: previousWindow.impressions,
          clicks: previousWindow.clicks,
          cost: microsToDecimalString(previousCostMicros),
          sales: microsToDecimalString(previousSalesMicros),
          orders: previousWindow.orders,
          units: previousWindow.units,
          acos:
            previousSalesMicros > 0
              ? previousCostMicros / previousSalesMicros
              : null,
          estimatedRoyalty:
            previousEstimatedRoyaltyMicros === null
              ? null
              : microsToDecimalString(previousEstimatedRoyaltyMicros),
          estimatedAdProfit:
            previousEstimatedRoyaltyMicros === null
              ? null
              : microsToDecimalString(
                  previousEstimatedRoyaltyMicros - previousCostMicros,
                ),
        },
      },
      economicsMissing,
      dataCurrentThrough: `${lastDataDate ?? start}T00:00:00.000Z`,
      writesDisabled,
      daily,
    };
  }

  return {
    async listProfiles(workspaceId) {
      const rows = await profiles.listProfilesByWorkspace(db, workspaceId);
      return rows.map(toContractProfile);
    },

    async updateProfile(
      auth,
      amazonProfileId,
      patch,
      meta,
    ): Promise<AmazonProfile> {
      const profile = await requireProfile(auth.workspaceId, amazonProfileId);
      if (patch.enabled !== undefined) {
        const ok = await profiles.setProfileEnabled(
          db,
          profile.id,
          patch.enabled,
        );
        if (!ok) throw notFound("Unknown profile");
        await audit.insertAuditEvent(db, {
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          event: patch.enabled ? "profile.enable" : "profile.disable",
          entityType: "amazon_profile",
          entityId: amazonProfileId,
          ip: meta.ip ?? null,
          sessionId: auth.sessionId,
        });
      }
      if (patch.writeEnabled !== undefined) {
        const ok = await profiles.setProfileWriteEnabled(
          db,
          profile.id,
          patch.writeEnabled,
        );
        if (!ok) {
          throw conflict(
            "PROFILE_DISABLED",
            "Writes can only be enabled on a profile that is enabled for syncing",
          );
        }
        await audit.insertAuditEvent(db, {
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          event: patch.writeEnabled
            ? "profile.write_enable"
            : "profile.write_disable",
          entityType: "amazon_profile",
          entityId: amazonProfileId,
          ip: meta.ip ?? null,
          sessionId: auth.sessionId,
        });
      }
      const updated = await profiles.getProfile(db, profile.id);
      if (!updated) throw notFound("Unknown profile");
      return toContractProfile(updated);
    },

    async requestSync(auth, amazonProfileId, meta) {
      const profile = await requireProfile(auth.workspaceId, amazonProfileId);
      if (!profile.enabled) {
        throw conflict(
          "PROFILE_DISABLED",
          "Enable the profile before requesting a sync",
        );
      }
      // Record the run, then hand work to the worker via the durable queue —
      // the sync never runs inside this request (plan §8).
      const syncRunId = await reports.createSyncRun(
        db,
        profile.id,
        "structure",
      );
      const basePayload = { syncRunId, profileId: profile.id };
      await enqueue(db, "structure_sync", basePayload);
      // Amazon's current day is incomplete. A manual sync imports the trailing
      // 60 complete UTC days so every optimizer evidence window is available.
      const { start: startDate, end: endDate } = dateRange(
        new Date(now().getTime() - DAY_MS),
        MANUAL_SYNC_HISTORY_DAYS,
      );
      await enqueue(db, "metrics_sync", {
        ...basePayload,
        startDate,
        endDate,
      });
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "sync.request",
        entityType: "sync_run",
        entityId: syncRunId,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: { profileId: amazonProfileId },
      });
      const run = await reports.getSyncRun(db, syncRunId);
      if (!run) throw new ApiError(500, "INTERNAL", "Sync run vanished");
      return toContractSyncRun(run, amazonProfileId);
    },

    async requestFxSync(auth, meta): Promise<FxSyncResult> {
      // A read-only upstream fetch of daily fixings: no spend, no Amazon
      // state, so like requestSync there is no recent-auth gate. There is no
      // sync_runs row either — that table is per-profile; the job queue and
      // fx_rates coverage are the status source, same as the freshness
      // endpoint reads them. Dedupe keeps a double-click from stacking
      // duplicate fx_sync jobs.
      const jobId = await enqueueIfNotQueued(db, "fx_sync", {});
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "fx_sync.request",
        entityType: "job_queue",
        entityId: jobId,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
      });
      const status = await fx.getFxSyncStatus(db);
      return {
        ...toContractFxRatesStatus(status, now()),
        queued: jobId !== null,
      };
    },

    async getSyncRun(workspaceId, syncRunId) {
      const run = await reports.getSyncRun(db, syncRunId);
      if (!run) return null;
      const profile = await profiles.getProfile(db, run.profileId);
      if (!profile) return null;
      const connection = await connections.getConnection(
        db,
        profile.connectionId,
      );
      if (!connection || connection.workspaceId !== workspaceId) return null;
      return toContractSyncRun(run, profile.profileId);
    },

    async listSyncRuns(workspaceId) {
      const runs = await reports.listRecentSyncRunsByWorkspace(db, workspaceId);
      const jobs = await reports.listReportJobsForSyncRuns(
        db,
        runs.map(({ run }) => run.id),
      );
      const jobsByRun = new Map<string, reports.ReportJob[]>();
      for (const job of jobs) {
        const list = jobsByRun.get(job.syncRunId);
        if (list) {
          list.push(job);
        } else {
          jobsByRun.set(job.syncRunId, [job]);
        }
      }
      return runs.map(({ run, amazonProfileId }) =>
        toContractSyncRunSummary(
          run,
          amazonProfileId,
          jobsByRun.get(run.id) ?? [],
        ),
      );
    },

    async dashboardSummary(
      workspaceId,
      days,
      countryCode,
      bookIds,
      // Display currency of the all-market view; ignored for a specific
      // country, whose totals stay in the native currency.
      displayCurrency,
    ): Promise<DashboardSummary> {
      if (countryCode === "all") {
        return dashboardSummaryAllMarkets(
          workspaceId,
          days,
          bookIds,
          displayCurrency,
        );
      }
      const { start, end } = dateRange(now(), days);
      const previous = previousDateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const all = await profiles.listProfilesByWorkspace(db, workspaceId);
      const enabled = all.filter(
        (p) => p.enabled && p.countryCode === countryCode,
      );

      async function aggregateWindow(windowStart: string, windowEnd: string) {
        let currency: string | null = null;
        let impressions = 0;
        let clicks = 0;
        let orders = 0;
        let units = 0;
        let costMicros = 0;
        let salesMicros = 0;

        for (const profile of enabled) {
          let totals: metrics.MetricTotals | null;
          try {
            totals = await metrics.dashboardTotals(
              db,
              profile.id,
              windowStart,
              windowEnd,
              bookPks,
            );
          } catch (error) {
            if (error instanceof metrics.MixedCurrencyError) {
              throw conflict(
                "MIXED_CURRENCY",
                "Profile data mixes currencies; refusing to aggregate (plan §9)",
              );
            }
            throw error;
          }
          if (!totals) continue;
          if (currency === null) {
            currency = totals.currency;
          } else if (currency !== totals.currency) {
            throw conflict(
              "MIXED_CURRENCY",
              "Profiles use different currencies; refusing to aggregate (plan §9)",
            );
          }
          impressions += totals.impressions;
          clicks += totals.clicks;
          orders += totals.orders;
          units += totals.units;
          costMicros += microsFromDecimalString(totals.cost);
          salesMicros += microsFromDecimalString(totals.sales);
        }
        return {
          currency,
          impressions,
          clicks,
          orders,
          units,
          costMicros,
          salesMicros,
        };
      }

      const current = await aggregateWindow(start, end);
      const previousWindow = await aggregateWindow(
        previous.start,
        previous.end,
      );
      const currency = current.currency ?? previousWindow.currency;
      if (
        current.currency !== null &&
        previousWindow.currency !== null &&
        current.currency !== previousWindow.currency
      ) {
        throw conflict(
          "MIXED_CURRENCY",
          "Profiles use different currencies; refusing to aggregate (plan §9)",
        );
      }

      const profilePks = enabled.map((p) => p.id);
      // Royalty is per advertised book per marketplace (profile) per day —
      // never one rate for the whole country. Missing economics on any
      // attributed order hides profit rather than guessing (plan §9).
      const [royaltyRows, previousRoyaltyRows, dailyRows, latestRateDate] =
        await Promise.all([
          dashboard.overviewRoyaltySeries(db, profilePks, start, end, bookPks),
          dashboard.overviewRoyaltySeries(
            db,
            profilePks,
            previous.start,
            previous.end,
            bookPks,
          ),
          dashboard.dailySeries(db, profilePks, start, end, bookPks),
          // Gates the client's "all markets" option (plan decision 8);
          // returned for every country selection.
          fx.getLatestRateDate(db),
        ]);
      const royaltyCurrencies = new Set(royaltyRows.map((row) => row.currency));
      const dailyCurrencies = new Set(dailyRows.map((row) => row.currency));
      if (royaltyCurrencies.size > 1 || dailyCurrencies.size > 1) {
        throw conflict(
          "MIXED_CURRENCY",
          "Daily metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }

      function royaltyFromSeries(
        points: readonly {
          estimatedRoyalty: string | null;
          economicsMissing: boolean;
        }[],
        orders: number,
      ): { micros: number | null; missing: boolean } {
        if (enabled.length === 0) {
          return { micros: null, missing: true };
        }
        if (
          points.some((p) => p.economicsMissing || p.estimatedRoyalty === null)
        ) {
          return { micros: null, missing: true };
        }
        if (orders > 0 && points.length === 0) {
          return { micros: null, missing: true };
        }
        let total = 0;
        for (const point of points) {
          total += microsFromDecimalString(point.estimatedRoyalty ?? "0");
        }
        return { micros: total, missing: false };
      }

      const currentRoyalty = royaltyFromSeries(royaltyRows, current.orders);
      const previousRoyalty = royaltyFromSeries(
        previousRoyaltyRows,
        previousWindow.orders,
      );
      const economicsMissing = currentRoyalty.missing;
      const estimatedRoyaltyMicros = currentRoyalty.micros;
      const previousEstimatedRoyaltyMicros = previousRoyalty.missing
        ? null
        : previousRoyalty.micros;

      const royaltyByDate = new Map<string, number | null>();
      for (const row of royaltyRows) {
        if (
          economicsMissing ||
          row.economicsMissing ||
          row.estimatedRoyalty === null
        ) {
          royaltyByDate.set(row.date, null);
          continue;
        }
        const currentValue = royaltyByDate.get(row.date);
        if (currentValue === null) continue;
        royaltyByDate.set(
          row.date,
          (currentValue ?? 0) + microsFromDecimalString(row.estimatedRoyalty),
        );
      }

      const dailyByDate = new Map<
        string,
        {
          date: string;
          costMicros: number;
          salesMicros: number;
          orders: number;
          estimatedRoyaltyMicros: number | null;
        }
      >();
      for (const row of dailyRows) {
        const point = dailyByDate.get(row.date) ?? {
          date: row.date,
          costMicros: 0,
          salesMicros: 0,
          orders: 0,
          estimatedRoyaltyMicros: economicsMissing
            ? null
            : (royaltyByDate.get(row.date) ?? 0),
        };
        point.costMicros += microsFromDecimalString(row.cost);
        point.salesMicros += microsFromDecimalString(row.sales);
        point.orders += row.orders;
        dailyByDate.set(row.date, point);
      }
      const daily = [...dailyByDate.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      const lastDataDate = daily.at(-1)?.date ?? null;

      return {
        dateRange: { start, end },
        currency: (currency ??
          enabled[0]?.currencyCode ??
          "USD") as DashboardSummary["currency"],
        ratesAvailable: latestRateDate !== null,
        totals: {
          impressions: current.impressions,
          clicks: current.clicks,
          cost: microsToDecimalString(current.costMicros),
          sales: microsToDecimalString(current.salesMicros),
          orders: current.orders,
          units: current.units,
          acos:
            current.salesMicros > 0
              ? current.costMicros / current.salesMicros
              : null,
          estimatedRoyalty:
            estimatedRoyaltyMicros === null
              ? null
              : microsToDecimalString(estimatedRoyaltyMicros),
          estimatedAdProfit:
            estimatedRoyaltyMicros === null
              ? null
              : microsToDecimalString(
                  estimatedRoyaltyMicros - current.costMicros,
                ),
        },
        previous: {
          dateRange: { start: previous.start, end: previous.end },
          totals: {
            impressions: previousWindow.impressions,
            clicks: previousWindow.clicks,
            cost: microsToDecimalString(previousWindow.costMicros),
            sales: microsToDecimalString(previousWindow.salesMicros),
            orders: previousWindow.orders,
            units: previousWindow.units,
            acos:
              previousWindow.salesMicros > 0
                ? previousWindow.costMicros / previousWindow.salesMicros
                : null,
            estimatedRoyalty:
              previousEstimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(previousEstimatedRoyaltyMicros),
            estimatedAdProfit:
              previousEstimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(
                    previousEstimatedRoyaltyMicros - previousWindow.costMicros,
                  ),
          },
        },
        economicsMissing,
        dataCurrentThrough: `${lastDataDate ?? start}T00:00:00.000Z`,
        writesDisabled:
          config.killSwitch || enabled.every((p) => !p.writeEnabled),
        daily: daily.map((row) => ({
          date: row.date,
          cost: microsToDecimalString(row.costMicros),
          sales: microsToDecimalString(row.salesMicros),
          orders: row.orders,
          estimatedRoyalty:
            row.estimatedRoyaltyMicros === null
              ? null
              : microsToDecimalString(row.estimatedRoyaltyMicros),
        })),
      };
    },

    async dashboardCountrySpend(
      workspaceId,
      days,
      bookIds,
      currency,
    ): Promise<CountrySpend> {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const all = await profiles.listProfilesByWorkspace(db, workspaceId);
      const enabled = all.filter((p) => p.enabled);

      const byCountry = new Map<
        string,
        { currency: string; spendMicros: number }
      >();
      for (const profile of enabled) {
        let totals: metrics.MetricTotals | null;
        try {
          totals = await metrics.dashboardTotals(
            db,
            profile.id,
            start,
            end,
            bookPks,
          );
        } catch (error) {
          if (error instanceof metrics.MixedCurrencyError) {
            throw conflict(
              "MIXED_CURRENCY",
              "Profile data mixes currencies; refusing to aggregate (plan §9)",
            );
          }
          throw error;
        }
        if (!totals) continue;
        const entry = byCountry.get(profile.countryCode) ?? {
          currency: totals.currency,
          spendMicros: 0,
        };
        if (entry.currency !== totals.currency) {
          throw conflict(
            "MIXED_CURRENCY",
            "Profiles use different currencies; refusing to aggregate (plan §9)",
          );
        }
        entry.spendMicros += microsFromDecimalString(totals.cost);
        byCountry.set(profile.countryCode, entry);
      }

      // Optional conversion into one display currency (per fact date, SQL on
      // numeric). A market the stored rates do not cover reports null — never
      // a silently unconverted number (plan decision 8).
      const convertedByCountry = new Map<
        string,
        { convertedSpend: string; ratesMissing: boolean }
      >();
      if (currency !== undefined) {
        const converted = await dashboard.convertedCountrySpend(
          db,
          enabled.map((p) => p.id),
          start,
          end,
          currency,
          bookPks,
        );
        for (const row of converted) {
          convertedByCountry.set(row.countryCode, row);
        }
      }

      return {
        dateRange: { start, end },
        ...(currency !== undefined
          ? { currency: currency as NonNullable<CountrySpend["currency"]> }
          : {}),
        countries: [...byCountry.entries()]
          .map(([countryCode, entry]) => {
            const converted = convertedByCountry.get(countryCode);
            return {
              countryCode,
              currency:
                entry.currency as CountrySpend["countries"][number]["currency"],
              spend: microsToDecimalString(entry.spendMicros),
              ...(currency !== undefined
                ? {
                    convertedSpend:
                      converted === undefined || converted.ratesMissing
                        ? null
                        : microsToDecimalString(
                            microsFromDecimalString(converted.convertedSpend),
                          ),
                  }
                : {}),
            };
          })
          .sort((a, b) => Number(b.spend) - Number(a.spend)),
      };
    },

    async listCampaigns(workspaceId, days, bookIds) {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const [rows, profileRows] = await Promise.all([
        dashboard.listCampaignRows(db, workspaceId, start, end, bookPks),
        profiles.listProfilesByWorkspace(db, workspaceId),
      ]);
      const consoleUrlByProfile = new Map(
        profileRows.map((p) => [p.profileId, amazonConsoleUrl(p.accountId)]),
      );
      if (rows.some((row) => row.mixedCurrency)) {
        throw conflict(
          "MIXED_CURRENCY",
          "Campaign metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      return rows.map((row) => {
        const estimatedRoyaltyMicros =
          row.estimatedRoyalty === null
            ? null
            : microsFromDecimalString(row.estimatedRoyalty);
        const costMicros = microsFromDecimalString(row.totals.cost);
        return {
          profileId: row.amazonProfileId,
          campaignId: row.amazonCampaignId,
          name: row.name,
          state: row.state,
          totals: row.totals,
          amazonConsoleUrl:
            consoleUrlByProfile.get(row.amazonProfileId) ?? null,
          bookIds: row.bookIds,
          maxCpc: row.maxCpc,
          profitability: {
            dateRange: { start, end },
            currency: row.currency as DashboardSummary["currency"],
            estimatedRoyalty:
              estimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(estimatedRoyaltyMicros),
            estimatedAdProfit:
              estimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(estimatedRoyaltyMicros - costMicros),
            economicsMissing: row.economicsMissing,
            dataCurrentThrough: row.dataCurrentThrough,
          },
        };
      });
    },

    async getCampaignDetail(workspaceId, amazonCampaignId, days, bookIds) {
      const campaign = await structure.findCampaignByAmazonId(
        db,
        workspaceId,
        amazonCampaignId,
      );
      if (!campaign) return null;
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const [
        profile,
        rows,
        adGroups,
        targets,
        searchTerms,
        negativeKeywords,
        negativeTargets,
        dailyRows,
      ] = await Promise.all([
        profiles.getProfile(db, campaign.profileId),
        dashboard.listCampaignRows(db, workspaceId, start, end, bookPks),
        dashboard.listAdGroupRows(db, campaign.id, start, end, bookPks),
        dashboard.listTargetRows(db, campaign.id, start, end, bookPks),
        dashboard.listSearchTermRows(
          db,
          campaign.profileId,
          amazonCampaignId,
          start,
          end,
          bookPks,
        ),
        dashboard.listNegativeKeywordRows(db, campaign.id, bookPks),
        dashboard.listNegativeTargetRows(db, campaign.id, bookPks),
        dashboard.campaignDailySeries(
          db,
          campaign.profileId,
          amazonCampaignId,
          start,
          end,
          bookPks,
        ),
      ]);
      if (!profile) return null;
      const targetAsins = [
        ...new Set(
          targets
            .map((target) => target.asin)
            .filter((asin): asin is string => asin !== null),
        ),
      ];
      const targetBookTitles = await books.listBookTitlesByMarketplaceAsins(
        db,
        campaign.profileId,
        targetAsins,
      );
      const row = rows.find(
        (r) =>
          r.amazonCampaignId === amazonCampaignId &&
          r.profilePk === campaign.profileId,
      );
      const totals = row?.totals ?? {
        impressions: 0,
        clicks: 0,
        cost: "0",
        sales: "0",
        orders: 0,
        units: 0,
      };
      const currencies = new Set(dailyRows.map((point) => point.currency));
      if (currencies.size > 1) {
        throw conflict(
          "MIXED_CURRENCY",
          "Campaign metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      const economicsMissing = dailyRows.some(
        (point) => point.estimatedRoyalty === null,
      );
      let estimatedRoyaltyMicros: number | null = economicsMissing ? null : 0;
      if (estimatedRoyaltyMicros !== null) {
        for (const point of dailyRows) {
          estimatedRoyaltyMicros += microsFromDecimalString(
            point.estimatedRoyalty ?? "0",
          );
        }
      }
      const costMicros = microsFromDecimalString(totals.cost);
      const salesMicros = microsFromDecimalString(totals.sales);
      const dataCurrentThrough = dailyRows.at(-1)?.date ?? start;

      return {
        dateRange: { start, end },
        currency: (currencies.values().next().value ??
          profile.currencyCode) as DashboardSummary["currency"],
        campaign: {
          profileId: campaign.amazonProfileId,
          campaignId: campaign.amazonCampaignId,
          name: campaign.name,
          state: campaign.state,
          amazonConsoleUrl: amazonConsoleUrl(profile.accountId),
          totals: {
            ...totals,
            acos: salesMicros > 0 ? costMicros / salesMicros : null,
            estimatedRoyalty:
              estimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(estimatedRoyaltyMicros),
            estimatedAdProfit:
              estimatedRoyaltyMicros === null
                ? null
                : microsToDecimalString(estimatedRoyaltyMicros - costMicros),
          },
        },
        economicsMissing,
        dataCurrentThrough: `${dataCurrentThrough}T00:00:00.000Z`,
        daily: dailyRows.map((point) => {
          const royaltyMicros =
            point.estimatedRoyalty === null
              ? null
              : microsFromDecimalString(point.estimatedRoyalty);
          return {
            date: point.date,
            cost: point.cost,
            sales: point.sales,
            estimatedRoyalty:
              royaltyMicros === null
                ? null
                : microsToDecimalString(royaltyMicros),
            estimatedAdProfit:
              royaltyMicros === null
                ? null
                : microsToDecimalString(
                    royaltyMicros - microsFromDecimalString(point.cost),
                  ),
          };
        }),
        adGroups,
        targets: targets.map((target) => ({
          ...target,
          bookTitle:
            target.asin === null
              ? null
              : (targetBookTitles.get(target.asin) ?? null),
        })),
        searchTerms: searchTerms.map((term) => {
          const termCostMicros = microsFromDecimalString(term.totals.cost);
          const termRoyaltyMicros =
            term.estimatedRoyalty === null
              ? null
              : microsFromDecimalString(term.estimatedRoyalty);
          return {
            id: term.id,
            name: term.name,
            state: term.state,
            totals: term.totals,
            estimatedRoyalty:
              termRoyaltyMicros === null
                ? null
                : microsToDecimalString(termRoyaltyMicros),
            estimatedAdProfit:
              termRoyaltyMicros === null
                ? null
                : microsToDecimalString(termRoyaltyMicros - termCostMicros),
            economicsMissing: term.economicsMissing,
          };
        }),
        negativeKeywords,
        negativeTargets,
      };
    },

    async listSearchTerms(
      workspaceId,
      days,
      bookIds = null,
      countryCode = null,
    ): Promise<SearchTermListRow[]> {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const rows = await dashboard.listSearchTermRollupRows(
        db,
        workspaceId,
        start,
        end,
        bookPks,
        countryCode,
      );
      if (rows.some((row) => row.mixedCurrency)) {
        throw conflict(
          "MIXED_CURRENCY",
          "Search term metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      return rows.map((row) => {
        const costMicros = microsFromDecimalString(row.totals.cost);
        const salesMicros = microsFromDecimalString(row.totals.sales);
        const royaltyMicros =
          row.estimatedRoyalty === null
            ? null
            : microsFromDecimalString(row.estimatedRoyalty);
        return {
          searchTerm: row.searchTerm,
          campaignCount: row.campaignCount,
          countryCodes: row.countryCodes,
          currency: row.currency as SearchTermListRow["currency"],
          totals: {
            ...row.totals,
            acos: salesMicros > 0 ? costMicros / salesMicros : null,
          },
          estimatedRoyalty:
            royaltyMicros === null
              ? null
              : microsToDecimalString(royaltyMicros),
          estimatedAdProfit:
            royaltyMicros === null
              ? null
              : microsToDecimalString(royaltyMicros - costMicros),
          economicsMissing: row.economicsMissing,
          dataCurrentThrough: row.dataCurrentThrough,
          bookIds: row.bookIds,
        };
      });
    },

    async getSearchTermDetail(
      workspaceId,
      searchTerm,
      days,
      bookIds = null,
      countryCode = null,
    ): Promise<SearchTermDetail | null> {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const allRows = await dashboard.listSearchTermCampaignRows(
        db,
        workspaceId,
        searchTerm,
        start,
        end,
        bookPks,
      );
      if (allRows.length === 0) {
        // No facts in this window. Distinguish "term never served" (404)
        // from "served, but not in this window" (zeroed detail) through
        // all-time presence, so narrowing the date range never errors out a
        // term the workspace knows.
        const presence = await dashboard.listSearchTermPresence(
          db,
          workspaceId,
          searchTerm,
          bookPks,
        );
        if (presence.length === 0) return null;
        const presenceCountryCodes = sortMarketCodes(
          presence.map((row) => row.countryCode),
        );
        const presenceCountryCode =
          (countryCode !== null && presenceCountryCodes.includes(countryCode)
            ? countryCode
            : null) ?? presenceCountryCodes[0]!;
        const selected = presence.find(
          (row) => row.countryCode === presenceCountryCode,
        )!;
        const zero = microsToDecimalString(0);
        return {
          searchTerm,
          countryCode: presenceCountryCode,
          availableCountryCodes: presenceCountryCodes,
          dateRange: { start, end },
          currency: selected.currency as SearchTermDetail["currency"],
          totals: {
            impressions: 0,
            clicks: 0,
            cost: zero,
            sales: zero,
            orders: 0,
            units: 0,
            acos: null,
            // Zero orders earn zero royalty — no economics needed, no guess.
            estimatedRoyalty: zero,
            estimatedAdProfit: zero,
          },
          economicsMissing: false,
          dataCurrentThrough: selected.lastMetricDate,
          daily: [],
          campaigns: [],
        };
      }

      const availableCountryCodes = sortMarketCodes([
        ...new Set(allRows.map((row) => row.countryCode)),
      ]);
      const selectedCountryCode =
        (countryCode !== null && availableCountryCodes.includes(countryCode)
          ? countryCode
          : null) ?? availableCountryCodes[0]!;
      const rows = allRows.filter(
        (row) => row.countryCode === selectedCountryCode,
      );

      const dailyRows = await dashboard.searchTermDailySeries(
        db,
        workspaceId,
        searchTerm,
        selectedCountryCode,
        start,
        end,
        bookPks,
      );

      if (rows.some((row) => row.mixedCurrency)) {
        throw conflict(
          "MIXED_CURRENCY",
          "Search term metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      const currencies = new Set(rows.map((row) => row.currency));
      if (currencies.size > 1) {
        throw conflict(
          "MIXED_CURRENCY",
          "Campaigns use different currencies; refusing to aggregate (plan §9)",
        );
      }

      let impressions = 0;
      let clicks = 0;
      let orders = 0;
      let units = 0;
      let costMicros = 0;
      let salesMicros = 0;
      let royaltyMicros = 0;
      // Profit is reported only when every campaign with orders has complete
      // royalty economics — never a partial guess (plan §9).
      const economicsMissing = rows.some((row) => row.economicsMissing);
      let dataCurrentThrough: string | null = null;
      for (const row of rows) {
        impressions += row.totals.impressions;
        clicks += row.totals.clicks;
        orders += row.totals.orders;
        units += row.totals.units;
        costMicros += microsFromDecimalString(row.totals.cost);
        salesMicros += microsFromDecimalString(row.totals.sales);
        if (!economicsMissing && row.estimatedRoyalty !== null) {
          royaltyMicros += microsFromDecimalString(row.estimatedRoyalty);
        }
        if (
          row.dataCurrentThrough !== null &&
          (dataCurrentThrough === null ||
            row.dataCurrentThrough > dataCurrentThrough)
        ) {
          dataCurrentThrough = row.dataCurrentThrough;
        }
      }

      // Amazon reports a search-term row only for days with impressions, so
      // a missing day up through the term's latest fact is a true zero —
      // fill those gaps so the trend chart spans the window. Days after the
      // latest fact may simply not be imported yet; the series ends at the
      // latest fact instead of fabricating zeros there.
      const zeroMoney = microsToDecimalString(0);
      const dailyByDate = new Map(
        dailyRows.map((point) => [point.date, point]),
      );
      const lastFactDate = dailyRows.reduce(
        (latest, point) => (point.date > latest ? point.date : latest),
        start,
      );
      const daily: SearchTermDetail["daily"] = [];
      const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
      for (let offset = 0; ; offset += 1) {
        const date = isoDay(new Date(startMs + offset * DAY_MS));
        if (date > lastFactDate) break;
        const point = dailyByDate.get(date);
        if (!point) {
          daily.push({
            date,
            cost: zeroMoney,
            sales: zeroMoney,
            estimatedRoyalty: economicsMissing ? null : zeroMoney,
            estimatedAdProfit: economicsMissing ? null : zeroMoney,
          });
          continue;
        }
        const dayRoyaltyMicros =
          point.estimatedRoyalty === null
            ? null
            : microsFromDecimalString(point.estimatedRoyalty);
        daily.push({
          date: point.date,
          cost: point.cost,
          sales: point.sales,
          estimatedRoyalty:
            dayRoyaltyMicros === null
              ? null
              : microsToDecimalString(dayRoyaltyMicros),
          estimatedAdProfit:
            dayRoyaltyMicros === null
              ? null
              : microsToDecimalString(
                  dayRoyaltyMicros - microsFromDecimalString(point.cost),
                ),
        });
      }

      return {
        searchTerm,
        countryCode: selectedCountryCode,
        availableCountryCodes,
        dateRange: { start, end },
        currency: [...currencies][0]! as SearchTermDetail["currency"],
        totals: {
          impressions,
          clicks,
          cost: microsToDecimalString(costMicros),
          sales: microsToDecimalString(salesMicros),
          orders,
          units,
          acos: salesMicros > 0 ? costMicros / salesMicros : null,
          estimatedRoyalty: economicsMissing
            ? null
            : microsToDecimalString(royaltyMicros),
          estimatedAdProfit: economicsMissing
            ? null
            : microsToDecimalString(royaltyMicros - costMicros),
        },
        economicsMissing,
        dataCurrentThrough,
        daily,
        campaigns: rows.map((row) => {
          const rowCostMicros = microsFromDecimalString(row.totals.cost);
          const rowRoyaltyMicros =
            row.estimatedRoyalty === null
              ? null
              : microsFromDecimalString(row.estimatedRoyalty);
          return {
            profileId: row.amazonProfileId,
            campaignId: row.amazonCampaignId,
            name: row.name,
            state: row.state,
            totals: row.totals,
            estimatedRoyalty:
              rowRoyaltyMicros === null
                ? null
                : microsToDecimalString(rowRoyaltyMicros),
            estimatedAdProfit:
              rowRoyaltyMicros === null
                ? null
                : microsToDecimalString(rowRoyaltyMicros - rowCostMicros),
            economicsMissing: row.economicsMissing,
          };
        }),
      };
    },

    async listNegatives(
      workspaceId,
      days,
      bookIds = null,
      countryCode = null,
      kind = null,
    ): Promise<NegativeListRow[]> {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const [rows, specs, serving] = await Promise.all([
        dashboard.listNegativeRollupRows(
          db,
          workspaceId,
          start,
          end,
          bookPks,
          countryCode,
          kind,
        ),
        dashboard.listNegativeSpecRows(
          db,
          workspaceId,
          bookPks,
          countryCode,
          kind,
        ),
        dashboard.listNegativeServingRows(
          db,
          workspaceId,
          start,
          end,
          bookPks,
          countryCode,
          kind,
        ),
      ]);
      if (
        rows.some(
          (row) =>
            row.window.mixedCurrency ||
            row.before.mixedCurrency ||
            (row.window.currency === null && row.structureMixedCurrency),
        )
      ) {
        throw conflict(
          "MIXED_CURRENCY",
          "Negative metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      const specsByKey = new Map<string, dashboard.NegativeSpecRowData[]>();
      for (const spec of specs) {
        const key = `${spec.kind}:${spec.valueKey}`;
        const list = specsByKey.get(key) ?? [];
        list.push(spec);
        specsByKey.set(key, list);
      }
      const servingByKey = new Map<
        string,
        dashboard.NegativeServingRowData[]
      >();
      for (const row of serving) {
        const key = `${row.kind}:${row.valueKey}`;
        const list = servingByKey.get(key) ?? [];
        list.push(row);
        servingByKey.set(key, list);
      }
      return rows.map((row) => {
        const key = `${row.kind}:${row.valueKey}`;
        const currency = (row.window.currency ??
          row.structureCurrency) as NegativeListRow["currency"];
        return {
          kind: row.kind,
          value: row.value,
          matchTypes: row.matchTypes,
          countryCodes: row.countryCodes,
          currency,
          bookIds: row.bookIds,
          blockingCampaignCount: row.blockingCampaignCount,
          stillServingCampaignCount: stillServingCampaignCount(
            row.valueKey,
            specsByKey.get(key) ?? [],
            servingByKey.get(key) ?? [],
          ),
          pausedCampaignCount: row.pausedCampaignCount,
          excludedEverywhere: row.excludedEverywhere,
          catalogBookId: row.catalogBookId,
          firstSeenAt: isoDateTime(row.firstSeenAt),
          lastServedAt: row.lastServedAt,
          before: toNegativePeriod(row.before),
          window: toNegativePeriod(row.window),
          dataCurrentThrough: row.dataCurrentThrough,
        };
      });
    },

    async getNegativeDetail(
      workspaceId,
      kind,
      value,
      days,
      bookIds = null,
      countryCode = null,
    ): Promise<NegativeDetail | null> {
      const { start, end } = dateRange(now(), days);
      const bookPks = await requireBookPks(workspaceId, bookIds);
      const valueKey = negativeValueKey(value);
      const [allSpecs, allFactRows] = await Promise.all([
        dashboard.listNegativeSpecRows(
          db,
          workspaceId,
          bookPks,
          null,
          kind,
          valueKey,
        ),
        dashboard.listNegativeTermCampaignRows(
          db,
          workspaceId,
          valueKey,
          start,
          end,
          bookPks,
        ),
      ]);
      if (allSpecs.length === 0) return null;

      const availableCountryCodes = preferUsCountryCodes([
        ...allSpecs.map((spec) => spec.countryCode),
        ...allFactRows.map((row) => row.countryCode),
      ]);
      const selectedCountryCode =
        (countryCode !== null && availableCountryCodes.includes(countryCode)
          ? countryCode
          : null) ?? availableCountryCodes[0]!;

      const [rollupRows, serving, dailyRows, candidateTerms] =
        await Promise.all([
          dashboard.listNegativeRollupRows(
            db,
            workspaceId,
            start,
            end,
            bookPks,
            selectedCountryCode,
            kind,
            valueKey,
          ),
          dashboard.listNegativeServingRows(
            db,
            workspaceId,
            start,
            end,
            bookPks,
            selectedCountryCode,
            kind,
            valueKey,
          ),
          dashboard.listNegativeDailySeries(
            db,
            workspaceId,
            valueKey,
            selectedCountryCode,
            start,
            end,
            bookPks,
          ),
          allSpecs.some((spec) => isPhraseMatchType(spec.matchType))
            ? dashboard.listNegativeCandidateTerms(
                db,
                workspaceId,
                valueKey,
                start,
                end,
                bookPks,
                selectedCountryCode,
              )
            : Promise.resolve([]),
        ]);
      const rollup = rollupRows[0];
      if (!rollup) return null;

      if (
        rollup.window.mixedCurrency ||
        rollup.before.mixedCurrency ||
        (rollup.window.currency === null && rollup.structureMixedCurrency)
      ) {
        throw conflict(
          "MIXED_CURRENCY",
          "Negative metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }

      const specs = allSpecs.filter(
        (spec) => spec.countryCode === selectedCountryCode,
      );
      const factRows = allFactRows.filter(
        (row) => row.countryCode === selectedCountryCode,
      );
      if (factRows.some((row) => row.mixedCurrency)) {
        throw conflict(
          "MIXED_CURRENCY",
          "Negative metrics mix currencies; refusing to aggregate (plan §9)",
        );
      }
      const currencies = new Set(factRows.map((row) => row.currency));
      if (currencies.size > 1) {
        throw conflict(
          "MIXED_CURRENCY",
          "Campaigns use different currencies; refusing to aggregate (plan §9)",
        );
      }

      const currency = (rollup.window.currency ??
        [...currencies][0] ??
        rollup.structureCurrency) as NegativeDetail["currency"];
      const blocked = blockedCampaignIds(
        valueKey,
        specKeywordSpecs(specs),
        servingAdGroupsByCampaign(serving),
      );
      const appliedIds = new Set(specs.map((spec) => spec.amazonCampaignId));
      const factsByCampaign = new Map(
        factRows.map((row) => [row.amazonCampaignId, row]),
      );

      const blockingByCampaign = new Map<
        string,
        dashboard.NegativeSpecRowData[]
      >();
      for (const spec of specs) {
        const list = blockingByCampaign.get(spec.amazonCampaignId) ?? [];
        list.push(spec);
        blockingByCampaign.set(spec.amazonCampaignId, list);
      }

      const blockingCampaigns = [...blockingByCampaign.entries()].map(
        ([campaignId, campaignSpecs]) => {
          const spec = pickBlockingSpec(campaignSpecs);
          const facts = factsByCampaign.get(campaignId);
          const base = facts
            ? searchTermCampaignFromFacts(facts)
            : {
                profileId: spec.amazonProfileId,
                campaignId: spec.amazonCampaignId,
                name: spec.campaignName,
                state: spec.campaignState,
                totals: {
                  impressions: 0,
                  clicks: 0,
                  cost: "0",
                  sales: "0",
                  orders: 0,
                  units: 0,
                },
                estimatedRoyalty: "0",
                estimatedAdProfit: "0",
                economicsMissing: false,
              };
          return {
            ...base,
            negativeId: spec.amazonNegativeId,
            matchType: spec.matchType,
            level: spec.level,
            adGroupId: spec.amazonAdGroupId,
            adGroupName: spec.adGroupName,
            negativeState: spec.negativeState,
            firstSeenAt: isoDateTime(spec.firstSeenAt),
            currentlyBlocks:
              isEnabledAmazonState(spec.campaignState) &&
              blocked.has(campaignId),
          };
        },
      );

      const unblockedCampaigns = factRows
        .filter((row) => !appliedIds.has(row.amazonCampaignId))
        .map(searchTermCampaignFromFacts);

      const phraseSpec: NegativeKeywordSpec = {
        campaignId: "",
        adGroupId: null,
        keywordText: valueKey,
        matchType: "NEGATIVE_PHRASE",
        state: "enabled",
      };
      const matchedTerms = candidateTerms
        .filter((term) => matchesNegative(term, phraseSpec))
        .slice(0, MATCHED_PHRASE_CAP);

      const windowPeriod = toNegativePeriod(rollup.window);
      return {
        kind,
        value: rollup.value,
        matchTypes: rollup.matchTypes,
        countryCode: selectedCountryCode,
        availableCountryCodes,
        dateRange: { start, end },
        currency,
        bookIds: rollup.bookIds,
        blockingCampaignCount: rollup.blockingCampaignCount,
        stillServingCampaignCount: stillServingCampaignCount(
          valueKey,
          specs,
          serving,
        ),
        pausedCampaignCount: rollup.pausedCampaignCount,
        excludedEverywhere: rollup.excludedEverywhere,
        catalogBookId: rollup.catalogBookId,
        firstSeenAt: isoDateTime(rollup.firstSeenAt),
        lastServedAt: rollup.lastServedAt,
        before: toNegativePeriod(rollup.before),
        window: windowPeriod,
        economicsMissing: windowPeriod.economicsMissing,
        dataCurrentThrough: rollup.dataCurrentThrough,
        daily: dailyRows.map((point) => {
          const dayRoyaltyMicros =
            point.estimatedRoyalty === null
              ? null
              : microsFromDecimalString(point.estimatedRoyalty);
          return {
            date: point.date,
            cost: point.cost,
            sales: point.sales,
            estimatedRoyalty:
              dayRoyaltyMicros === null
                ? null
                : microsToDecimalString(dayRoyaltyMicros),
            estimatedAdProfit:
              dayRoyaltyMicros === null
                ? null
                : microsToDecimalString(
                    dayRoyaltyMicros - microsFromDecimalString(point.cost),
                  ),
          };
        }),
        blockingCampaigns,
        unblockedCampaigns,
        matchedTerms,
        hasSearchTermFacts: factRows.length > 0 || dailyRows.length > 0,
      };
    },

    async listBooks(workspaceId) {
      const [rows, savedEconomics] = await Promise.all([
        books.listBooks(db, workspaceId),
        books.listLatestBookEconomicsByWorkspace(db, workspaceId),
      ]);
      const economicsByBook = new Map<string, typeof savedEconomics>();
      for (const economics of savedEconomics) {
        const current = economicsByBook.get(economics.bookId);
        if (current) {
          current.push(economics);
        } else {
          economicsByBook.set(economics.bookId, [economics]);
        }
      }
      return rows.map((row) => ({
        id: row.id,
        asin: row.asin,
        title: row.title,
        format: row.format,
        status: row.status,
        coverImageUrl: coverImageUrlOf(row.coverJson),
        profileIds: row.profileIds,
        marketplaceAsins: row.marketplaceAsins,
        economics: (economicsByBook.get(row.id) ?? []).map((economics) => ({
          profileId: economics.amazonProfileId,
          effectiveFrom: isoDate(economics.effectiveFrom),
          currency: economics.currency,
          listPrice: economics.listPrice,
          estimatedRoyaltyPerSale: economics.estimatedRoyaltyPerSale,
          targetAcos:
            economics.targetAcos === null ? null : Number(economics.targetAcos),
          goalMode: economics.goalMode,
          maxSpendWithoutSale: economics.maxSpendWithoutSale,
          maxBid: economics.maxBid,
          maxDailyBudget: economics.maxDailyBudget,
          notes: economics.notes,
        })),
      }));
    },

    async listUnmappedAdvertisedProducts(workspaceId) {
      return books.listUnmappedAdvertisedProducts(db, workspaceId);
    },

    async mapAdvertisedProduct(auth, input, meta): Promise<Book> {
      // Resolve every browser-visible Amazon profile id through the workspace
      // boundary before the repository receives internal primary keys.
      const selectedProfiles = await Promise.all(
        input.profileIds.map((profileId) =>
          requireProfile(auth.workspaceId, profileId),
        ),
      );
      const mapped = await books.mapAdvertisedProductToBook(db, {
        workspaceId: auth.workspaceId,
        profileIds: selectedProfiles.map((profile) => profile.id),
        asin: input.asin,
        title: input.title,
        format: input.format,
        coverJson: input.coverImageUrl
          ? { imageUrl: input.coverImageUrl }
          : undefined,
      });
      if (!mapped) {
        throw notFound(
          "Advertised ASIN was not found for every selected profile",
        );
      }
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "books.map_advertised_asin",
        entityType: "book",
        entityId: mapped.id,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: {
          asin: input.asin,
          profileIds: input.profileIds,
          format: input.format,
          coverImageUrl: input.coverImageUrl ?? null,
        },
      });
      return {
        id: mapped.id,
        asin: mapped.asin,
        title: mapped.title,
        format: mapped.format,
        status: mapped.status,
        coverImageUrl: coverImageUrlOf(mapped.coverJson),
        profileIds: input.profileIds,
        marketplaceAsins: input.profileIds.map((profileId) => ({
          profileId,
          asin: input.asin,
        })),
        economics: [],
      };
    },

    async linkBookToMarkets(auth, bookId, input, meta): Promise<Book> {
      const book = await books.getBook(db, bookId);
      if (!book || book.workspaceId !== auth.workspaceId) {
        throw notFound("Unknown book");
      }
      const selectedProfiles = await Promise.all(
        input.profileIds.map((profileId) =>
          requireProfile(auth.workspaceId, profileId),
        ),
      );
      const linked = await books.linkBookToProfiles(db, {
        workspaceId: auth.workspaceId,
        bookId: book.id,
        profileIds: selectedProfiles.map((profile) => profile.id),
        asin: input.asin,
      });
      if (!linked.ok) {
        if (linked.reason === "asin_already_linked") {
          throw conflict(
            "ASIN_ALREADY_LINKED",
            "Another book already uses this ASIN in one of the selected markets",
          );
        }
        if (linked.reason === "asin_mismatch") {
          throw conflict(
            "BOOK_PROFILE_ASIN_MISMATCH",
            "This book is already linked to one of the selected markets with a different ASIN",
          );
        }
        throw notFound("Unknown book or profile");
      }
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "books.link_marketplace",
        entityType: "book",
        entityId: linked.book.id,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: {
          asin: input.asin,
          profileIds: input.profileIds,
        },
      });
      return toContractBook(linked.book);
    },

    async saveBookEconomics(auth, bookId, input, meta) {
      const book = await books.getBook(db, bookId);
      if (!book || book.workspaceId !== auth.workspaceId) {
        throw notFound("Unknown book");
      }
      const profile = await profiles.findProfileByAmazonId(
        db,
        auth.workspaceId,
        input.profileId,
      );
      if (!profile) {
        throw notFound("Unknown profile for economics");
      }
      if (!(await books.isBookLinkedToProfile(db, book.id, profile.id))) {
        throw conflict(
          "BOOK_PROFILE_NOT_LINKED",
          "Map this advertised book to the selected profile before saving economics",
        );
      }
      await books.upsertBookEconomics(db, {
        bookId: book.id,
        profileId: profile.id,
        effectiveFrom: input.effectiveFrom,
        currency: input.currency,
        listPrice: input.listPrice,
        estimatedRoyaltyPerSale: input.estimatedRoyaltyPerSale,
        targetAcos: input.targetAcos === null ? null : String(input.targetAcos),
        goalMode: input.goalMode,
        maxSpendWithoutSale: input.maxSpendWithoutSale ?? null,
        maxBid: input.maxBid ?? null,
        maxDailyBudget: input.maxDailyBudget ?? null,
        notes: input.notes ?? null,
      });
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "books.economics",
        entityType: "book",
        entityId: book.id,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: {
          profileId: input.profileId,
          effectiveFrom: input.effectiveFrom,
          goalMode: input.goalMode,
        },
      });
    },

    async saveBookCover(auth, bookId, input, meta) {
      const book = await books.getBook(db, bookId);
      if (!book || book.workspaceId !== auth.workspaceId) {
        throw notFound("Unknown book");
      }
      await books.updateBook(db, book.id, {
        coverJson: input.coverImageUrl
          ? { imageUrl: input.coverImageUrl }
          : null,
      });
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "books.cover",
        entityType: "book",
        entityId: book.id,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: { coverImageUrl: input.coverImageUrl },
      });
    },

    async createKdpRoyaltyImport(auth, input, meta) {
      return createKdpRoyaltyImport(deps, auth, input, meta);
    },

    async listKdpRoyaltyImports(workspaceId) {
      return listKdpRoyaltyImports(db, workspaceId);
    },

    async applyKdpRoyaltyImport(auth, importId, input, meta) {
      return applyKdpRoyaltyImport(deps, auth, importId, input, meta);
    },

    async getKdpHistory(workspaceId) {
      return getKdpHistory(db, workspaceId);
    },

    async listKdpTransactions(workspaceId, query) {
      return listKdpTransactions(db, workspaceId, query);
    },

    async kdpDailyProfit(workspaceId, query) {
      return getKdpDailyProfit(db, workspaceId, query, now);
    },

    async spendBreakdown(
      workspaceId,
      grain,
      days,
      countryCode,
      displayCurrency,
    ) {
      return getSpendBreakdown(
        db,
        workspaceId,
        { grain, days, country: countryCode, currency: displayCurrency },
        now,
      );
    },

    async spendTree(workspaceId, days, countryCode, displayCurrency) {
      return getSpendTree(
        db,
        workspaceId,
        { days, country: countryCode, currency: displayCurrency },
        now,
      );
    },

    async listRecommendations(workspaceId, filter) {
      const bookPks = await requireBookPks(workspaceId, filter.bookIds);
      const rows = await recommendations.listRecommendationsByWorkspace(
        db,
        workspaceId,
        { type: filter.type, state: filter.state, bookIds: bookPks },
      );
      return rows.map(toContractRecommendation);
    },

    async getRecommendation(workspaceId, recommendationId) {
      const row = await recommendations.getRecommendationForWorkspace(
        db,
        workspaceId,
        recommendationId,
      );
      return row ? toContractRecommendation(row) : null;
    },

    async getCannibalizationResolutionContext(
      workspaceId,
      recommendationId,
    ): Promise<CannibalizationResolutionContext | null> {
      const row = await recommendations.getRecommendationForWorkspace(
        db,
        workspaceId,
        recommendationId,
      );
      if (!row) return null;
      if (row.type !== "cannibalization_conflict") {
        throw conflict(
          "INVALID_RECOMMENDATION_TYPE",
          "Only cannibalization findings have a resolution context",
        );
      }
      const evidence = cannibalizationEvidenceSchema.safeParse(
        await recommendations.getRecommendationEvidence(db, row.id),
      );
      if (!evidence.success) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "This finding does not contain the campaign evidence needed for a safe resolution",
        );
      }
      const profile = await profiles.getProfile(db, row.profileId);
      if (!profile) throw new ApiError(500, "INTERNAL", "Profile row missing");
      const campaignRows = await Promise.all(
        evidence.data.campaigns.map(async (entry) => ({
          entry,
          campaign: await structure.getCampaign(db, entry.campaignId),
        })),
      );
      if (
        campaignRows.some(
          ({ campaign }) =>
            campaign === null || campaign.profileId !== row.profileId,
        )
      ) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "An affected campaign is missing or no longer belongs to this profile; re-sync before resolving",
        );
      }
      const totalCostMicros = evidence.data.campaigns.reduce(
        (sum, campaign) => sum + campaign.costMicros,
        0,
      );
      // #region agent log
      {
        const payload: Record<string, unknown> = {
          recId: row.id,
          state: row.state,
          searchTerm: row.searchTerm,
          campaignCount: evidence.data.campaigns.length,
        };
        try {
          const siblings = await db.query<{
            id: string;
            state: string;
            created_at: string;
          }>(
            `select id::text, state, created_at::text
             from recommendations
             where profile_id = $1 and type = 'cannibalization_conflict'
               and lower(btrim(coalesce(search_term, ''))) = lower(btrim($2))
             order by id`,
            [row.profileId, row.searchTerm ?? ""],
          );
          const nk = await db.query<{ n: string }>(
            `select count(*)::text as n from negative_keywords
             where profile_id = $1
               and lower(btrim(keyword_text)) = lower(btrim($2))`,
            [row.profileId, row.searchTerm ?? ""],
          );
          const ntActions = await db.query<{
            change_set_id: string;
            status: string;
            code: string | null;
          }>(
            `select ca.change_set_id::text, ca.status,
                    ca.amazon_response->>'code' as code
             from change_actions ca
             where ca.action_type = 'add_negative_target'
               and lower(btrim(coalesce(ca.search_term, ''))) = lower(btrim($1))
             order by ca.id`,
            [row.searchTerm ?? ""],
          );
          payload.siblingRecs = siblings.rows;
          payload.negativeKeywordCount = Number(nk.rows[0]?.n ?? 0);
          payload.negativeTargetActions = ntActions.rows;
          const nt = await db.query<{ n: string }>(
            `select count(*)::text as n from negative_targets
             where profile_id = $1
               and lower(btrim(expression_asin)) = lower(btrim($2))`,
            [row.profileId, row.searchTerm ?? ""],
          );
          payload.negativeTargetCount = Number(nt.rows[0]?.n ?? 0);
        } catch (error) {
          payload.debugQueryError =
            error instanceof Error ? error.message : String(error);
        }
        fetch(
          "http://127.0.0.1:7447/ingest/5d432678-775b-4130-8e0d-7b74692e8cd1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "77c0cc",
            },
            body: JSON.stringify({
              sessionId: "77c0cc",
              runId: "post-fix",
              hypothesisId: "H1-H2-H3",
              location:
                "apps/api/src/services/read.ts:getCannibalizationResolutionContext",
              message: "cannibalization context loaded",
              data: payload,
              timestamp: Date.now(),
            }),
          },
        ).catch(() => {});
      }
      // #endregion
      return {
        recommendationId: row.id,
        profileId: row.amazonProfileId,
        searchTerm: evidence.data.searchTerm,
        currency: profile.currencyCode,
        confidence: Number(row.confidence),
        evidenceWindow: {
          start: isoDate(row.evidenceWindowStart),
          end: isoDate(row.evidenceWindowEnd),
        },
        dataFreshness: isoDateTime(row.dataFreshnessAt),
        expiresAt: isoDateTime(row.expiresAt),
        totalSpend: microsToDecimalString(totalCostMicros),
        campaigns: campaignRows.map(({ entry, campaign }) => ({
          campaignId: campaign!.amazonCampaignId,
          name: campaign!.name,
          state: campaign!.state,
          targetingType: campaign!.targetingType,
          spend: microsToDecimalString(entry.costMicros),
          orders: entry.orders,
        })),
      };
    },

    async getConversionResolutionContext(
      workspaceId,
      recommendationId,
    ): Promise<ConversionResolutionContext | null> {
      const row = await recommendations.getRecommendationForWorkspace(
        db,
        workspaceId,
        recommendationId,
      );
      if (!row) return null;
      if (row.type !== "high_ctr_poor_conversion") {
        throw conflict(
          "INVALID_RECOMMENDATION_TYPE",
          "Only high-CTR/poor-conversion findings have a conversion context",
        );
      }
      const evidence = conversionEvidenceSchema.safeParse(
        await recommendations.getRecommendationEvidence(db, row.id),
      );
      if (!evidence.success || row.campaignId === null) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "This finding does not contain the campaign evidence needed for a safe resolution",
        );
      }
      const [profile, campaign] = await Promise.all([
        profiles.getProfile(db, row.profileId),
        structure.getCampaign(db, row.campaignId),
      ]);
      if (!profile) throw new ApiError(500, "INTERNAL", "Profile row missing");
      if (!campaign || campaign.profileId !== row.profileId) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "The campaign is missing or no longer belongs to this profile; re-sync before resolving",
        );
      }
      const start = isoDate(row.evidenceWindowStart);
      const end = isoDate(row.evidenceWindowEnd);
      const [campaignBooks, searchTermRows, negativeKeywords, negativeTargets] =
        await Promise.all([
          books.listCampaignBooks(db, campaign.id),
          dashboard.listSearchTermRows(
            db,
            campaign.profileId,
            campaign.amazonCampaignId,
            start,
            end,
          ),
          dashboard.listNegativeKeywordRows(db, campaign.id),
          dashboard.listNegativeTargetRows(db, campaign.id),
        ]);
      const { clicks, costMicros } = evidence.data;
      const averageCpcMicros = clicks > 0 ? Math.round(costMicros / clicks) : 0;
      const suggestedMicros =
        averageCpcMicros > 0
          ? Math.max(
              MIN_SUGGESTED_MAX_CPC_MICROS,
              // Round to whole cents: a ceiling is a price the author reads.
              Math.round(
                (averageCpcMicros * SUGGESTED_MAX_CPC_FRACTION) / 10_000,
              ) * 10_000,
            )
          : null;
      return {
        recommendationId: row.id,
        profileId: row.amazonProfileId,
        countryCode: profile.countryCode,
        currency: profile.currencyCode,
        confidence: Number(row.confidence),
        evidenceWindow: { start, end },
        dataFreshness: isoDateTime(row.dataFreshnessAt),
        expiresAt: isoDateTime(row.expiresAt),
        campaign: {
          campaignId: campaign.amazonCampaignId,
          name: campaign.name,
          state: campaign.state,
          targetingType: campaign.targetingType,
          amazonConsoleUrl: amazonConsoleUrl(profile.accountId),
          writeEnabled: profile.writeEnabled,
        },
        metrics: {
          impressions: evidence.data.impressions,
          clicks,
          orders: evidence.data.orders,
          ctr: evidence.data.ctr,
          cvr: evidence.data.cvr,
          spend: microsToDecimalString(costMicros),
          averageCpc:
            averageCpcMicros > 0
              ? microsToDecimalString(averageCpcMicros)
              : null,
          suggestedMaxCpc:
            suggestedMicros === null
              ? null
              : microsToDecimalString(suggestedMicros),
        },
        books: campaignBooks.map((book) => ({
          bookId: book.bookId,
          title: book.title,
          asin: book.marketplaceAsin,
          coverImageUrl: coverImageUrlOf(book.coverJson),
        })),
        // Terms that took clicks and returned nothing: the spend this finding
        // can actually stop without touching the listing. Terms a synced
        // negative already blocks stay in the evidence window but are not
        // offered again — Amazon will not serve them.
        wastefulTerms: searchTermRows
          .filter((term) => term.totals.orders === 0 && term.totals.clicks > 0)
          .filter(
            (term) =>
              !isSearchTermAlreadyNegated(
                term.name,
                negativeKeywords,
                negativeTargets,
              ),
          )
          .slice(0, MAX_WASTEFUL_TERMS)
          .map((term) => ({
            searchTerm: term.name,
            impressions: term.totals.impressions,
            clicks: term.totals.clicks,
            orders: term.totals.orders,
            spend: term.totals.cost,
          })),
      };
    },

    async rejectRecommendation(auth, recommendationId, meta, options) {
      const row = await recommendations.getRecommendationForWorkspace(
        db,
        auth.workspaceId,
        recommendationId,
      );
      if (!row) return null;
      const rejected =
        (await recommendations.transitionRecommendationState(
          db,
          recommendationId,
          "pending",
          "rejected",
        )) ??
        (await recommendations.transitionRecommendationState(
          db,
          recommendationId,
          "approved",
          "rejected",
        ));
      if (!rejected) {
        throw conflict(
          "INVALID_STATE",
          `Recommendation in state '${row.state}' cannot be rejected`,
        );
      }
      // Rejecting only changes this row's state; without a dismissal the next
      // recommendation run re-inserts an identical finding from the same
      // evidence. Suppress it for as long as that evidence can persist, or
      // for the shorter window the caller asked to be reminded after.
      const suppressionDays = options?.snoozeDays ?? REJECTION_SUPPRESSION_DAYS;
      await recommendations.upsertRecommendationDismissal(db, {
        profileId: rejected.profileId,
        type: rejected.type,
        campaignId: rejected.campaignId,
        adGroupId: rejected.adGroupId,
        targetId: rejected.targetId,
        searchTerm: rejected.searchTerm,
        recommendationId: rejected.id,
        dismissedUntil: new Date(
          now().getTime() + suppressionDays * DAY_MS,
        ).toISOString(),
      });
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "recommendation.reject",
        entityType: "recommendation",
        entityId: recommendationId,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: { suppressionDays },
      });
      return toContractRecommendation({
        ...rejected,
        amazonProfileId: row.amazonProfileId,
        amazonCampaignId: row.amazonCampaignId,
        campaignName: row.campaignName,
        campaignState: row.campaignState,
      });
    },

    async listChangeSets(workspaceId) {
      const rows = await changes.listChangeSetsByWorkspace(db, workspaceId);
      return rows.map(toContractChangeSet);
    },

    async listAuditEvents(workspaceId) {
      const rows = await audit.listAuditEvents(db, workspaceId, { limit: 100 });
      return rows.map(toContractAuditEvent);
    },

    async listSearchTermExclusions(workspaceId) {
      const rows = await exclusions.listExclusions(db, workspaceId);
      return {
        exclusions: rows.map((row) => ({
          term: row.searchTerm,
          createdAt: isoDateTime(row.createdAt),
        })),
      };
    },

    async dataFreshness(workspaceId) {
      // FX health is workspace-level (plan decision 7): it is included
      // whether or not any market is selected, in every run state.
      const [rows, fxStatus] = await Promise.all([
        dashboard.dataFreshnessByWorkspace(db, workspaceId),
        fx.getFxSyncStatus(db),
      ]);
      return {
        profiles: rows.map((row) => ({
          profileId: row.amazonProfileId,
          countryCode: row.countryCode,
          dataset: row.dataset,
          lastSuccessAt: row.lastSuccessAt
            ? isoDateTime(row.lastSuccessAt)
            : null,
          completeThrough: row.completeThrough,
          hasCampaigns: row.hasCampaigns,
        })),
        fxRates: toContractFxRatesStatus(fxStatus, now()),
      };
    },

    async updateWorkspaceSettings(
      auth,
      patch,
      meta,
    ): Promise<WorkspaceSettings> {
      // Display setting only — stored facts keep their native currency, so
      // this needs no recent-auth gate (it changes no spend).
      const ok = await identity.setWorkspaceDisplayCurrency(
        db,
        auth.workspaceId,
        patch.displayCurrency,
      );
      if (!ok) throw notFound("Unknown workspace");
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "workspace.settings_update",
        entityType: "workspace",
        entityId: auth.workspaceId,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
        details: { displayCurrency: patch.displayCurrency },
      });
      return { displayCurrency: patch.displayCurrency };
    },
  };
}
