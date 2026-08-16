import type {
  AmazonProfile,
  Book,
  CannibalizationResolutionContext,
  DashboardSummary,
  SearchTermDetail,
  SearchTermListRow,
} from "@amazon-king/contracts";
import {
  microsFromDecimalString,
  microsToDecimalString,
} from "@amazon-king/optimizer";
import {
  audit,
  books,
  changes,
  connections,
  dashboard,
  enqueue,
  metrics,
  profiles,
  recommendations,
  reports,
  structure,
  type Db,
} from "@amazon-king/database";
import type { FastifyBaseLogger as Logger } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import { ApiError, conflict, notFound } from "../errors.js";
import {
  amazonConsoleUrl,
  isoDate,
  isoDateTime,
  toContractAuditEvent,
  toContractChangeSet,
  toContractProfile,
  toContractRecommendation,
  toContractSyncRun,
} from "../serialize.js";
import type { AuthContext, ReadService, RequestMeta } from "./types.js";

/** Read-side service: dashboard, profiles, campaigns, books, recommendations. */

export interface ReadServiceDeps {
  db: Db;
  config: ApiConfig;
  logger: Logger;
  now?: () => Date;
}

const MAX_DAYS = 90;
const MANUAL_SYNC_HISTORY_DAYS = 60;
const DAY_MS = 86_400_000;

/** Extract the user-entered cover image URL from a book's `cover_json` blob. */
function coverImageUrlOf(coverJson: unknown): string | null {
  if (coverJson && typeof coverJson === "object" && "imageUrl" in coverJson) {
    const url = (coverJson as { imageUrl?: unknown }).imageUrl;
    if (typeof url === "string") return url;
  }
  return null;
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

function dateRange(now: Date, days: number): { start: string; end: string } {
  const clamped = Math.min(Math.max(Math.trunc(days) || 30, 1), MAX_DAYS);
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end.getTime() - (clamped - 1) * 86_400_000);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
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

  /** Resolve an optional product filter to a workspace-owned book. */
  async function requireBook(workspaceId: string, bookId: string | null) {
    if (bookId === null) return null;
    const book = await books.getBook(db, bookId);
    if (!book || book.workspaceId !== workspaceId) {
      throw notFound("Unknown book");
    }
    return book.id;
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

    async dashboardSummary(
      workspaceId,
      days,
      countryCode,
    ): Promise<DashboardSummary> {
      const { start, end } = dateRange(now(), days);
      const all = await profiles.listProfilesByWorkspace(db, workspaceId);
      const enabled = all.filter(
        (p) => p.enabled && p.countryCode === countryCode,
      );

      let currency: string | null = null;
      let impressions = 0;
      let clicks = 0;
      let orders = 0;
      let costMicros = 0;
      let salesMicros = 0;
      const totalsByProfile = new Map<
        string,
        { orders: number; costMicros: number }
      >();

      for (const profile of enabled) {
        let totals: metrics.MetricTotals | null;
        try {
          totals = await metrics.dashboardTotals(db, profile.id, start, end);
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
        costMicros += microsFromDecimalString(totals.cost);
        salesMicros += microsFromDecimalString(totals.sales);
        totalsByProfile.set(profile.id, {
          orders: totals.orders,
          costMicros: microsFromDecimalString(totals.cost),
        });
      }

      // Profit requires user-entered economics for EVERY enabled profile;
      // otherwise it is reported as missing, never guessed (plan §9).
      const economics = await dashboard.latestEconomicsForProfiles(
        db,
        enabled.map((p) => p.id),
        end,
      );
      const economicsByProfile = new Map(
        economics.map((row) => [row.profilePk, row]),
      );
      const economicsMissing =
        enabled.length === 0 ||
        enabled.some((p) => !economicsByProfile.has(p.id));

      let estimatedRoyaltyMicros: number | null = null;
      if (!economicsMissing) {
        estimatedRoyaltyMicros = 0;
        for (const profile of enabled) {
          const totals = totalsByProfile.get(profile.id);
          const econ = economicsByProfile.get(profile.id);
          if (!totals || !econ) continue;
          estimatedRoyaltyMicros +=
            totals.orders *
            microsFromDecimalString(econ.estimatedRoyaltyPerSale);
        }
      }

      const dailyRows = await dashboard.dailySeries(
        db,
        enabled.map((p) => p.id),
        start,
        end,
      );
      const dailyCurrencies = new Set(dailyRows.map((row) => row.currency));
      if (dailyCurrencies.size > 1) {
        throw conflict(
          "MIXED_CURRENCY",
          "Daily metrics mix currencies; refusing to aggregate (plan §9)",
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
          estimatedRoyaltyMicros: economicsMissing ? null : 0,
        };
        point.costMicros += microsFromDecimalString(row.cost);
        point.salesMicros += microsFromDecimalString(row.sales);
        point.orders += row.orders;
        if (point.estimatedRoyaltyMicros !== null) {
          const economics = economicsByProfile.get(row.profilePk);
          if (economics) {
            point.estimatedRoyaltyMicros +=
              row.orders *
              microsFromDecimalString(economics.estimatedRoyaltyPerSale);
          }
        }
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
        totals: {
          impressions,
          clicks,
          cost: microsToDecimalString(costMicros),
          sales: microsToDecimalString(salesMicros),
          orders,
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

    async listCampaigns(workspaceId, days) {
      const { start, end } = dateRange(now(), days);
      const [rows, profileRows] = await Promise.all([
        dashboard.listCampaignRows(db, workspaceId, start, end),
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

    async getCampaignDetail(workspaceId, amazonCampaignId, days) {
      const campaign = await structure.findCampaignByAmazonId(
        db,
        workspaceId,
        amazonCampaignId,
      );
      if (!campaign) return null;
      const { start, end } = dateRange(now(), days);
      const [
        profile,
        rows,
        adGroups,
        targets,
        searchTerms,
        negativeKeywords,
        dailyRows,
      ] = await Promise.all([
        profiles.getProfile(db, campaign.profileId),
        dashboard.listCampaignRows(db, workspaceId, start, end),
        dashboard.listAdGroupRows(db, campaign.id, start, end),
        dashboard.listTargetRows(db, campaign.id, start, end),
        dashboard.listSearchTermRows(
          db,
          campaign.profileId,
          amazonCampaignId,
          start,
          end,
        ),
        dashboard.listNegativeKeywordRows(db, campaign.id),
        dashboard.campaignDailySeries(
          db,
          campaign.profileId,
          amazonCampaignId,
          start,
          end,
        ),
      ]);
      if (!profile) return null;
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
        targets,
        searchTerms,
        negativeKeywords,
      };
    },

    async listSearchTerms(
      workspaceId,
      days,
      bookId = null,
    ): Promise<SearchTermListRow[]> {
      const { start, end } = dateRange(now(), days);
      const bookPk = await requireBook(workspaceId, bookId);
      const rows = await dashboard.listSearchTermRollupRows(
        db,
        workspaceId,
        start,
        end,
        bookPk,
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
        };
      });
    },

    async getSearchTermDetail(
      workspaceId,
      searchTerm,
      days,
      bookId = null,
      countryCode = null,
    ): Promise<SearchTermDetail | null> {
      const { start, end } = dateRange(now(), days);
      const bookPk = await requireBook(workspaceId, bookId);
      const allRows = await dashboard.listSearchTermCampaignRows(
        db,
        workspaceId,
        searchTerm,
        start,
        end,
        bookPk,
      );
      if (allRows.length === 0) return null;

      const availableCountryCodes = [
        ...new Set(allRows.map((row) => row.countryCode)),
      ].sort((a, b) => {
        if (a === "US") return -1;
        if (b === "US") return 1;
        return a.localeCompare(b);
      });
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
        bookPk,
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

    async listRecommendations(workspaceId, filter) {
      const rows = await recommendations.listRecommendationsByWorkspace(
        db,
        workspaceId,
        filter,
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

    async rejectRecommendation(auth, recommendationId, meta) {
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
      await audit.insertAuditEvent(db, {
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        event: "recommendation.reject",
        entityType: "recommendation",
        entityId: recommendationId,
        ip: meta.ip ?? null,
        sessionId: auth.sessionId,
      });
      return toContractRecommendation({
        ...rejected,
        amazonProfileId: row.amazonProfileId,
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

    async dataFreshness(workspaceId) {
      const rows = await dashboard.dataFreshnessByWorkspace(db, workspaceId);
      return rows.map((row) => ({
        profileId: row.amazonProfileId,
        dataset: row.dataset,
        lastSuccessAt: row.lastSuccessAt
          ? isoDateTime(row.lastSuccessAt)
          : null,
        completeThrough: row.completeThrough,
      }));
    },
  };
}
