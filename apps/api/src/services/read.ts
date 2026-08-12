import type { AmazonProfile, DashboardSummary } from "@amazon-king/contracts";
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
import type { ApiConfig } from "../config.js";
import { ApiError, conflict, notFound } from "../errors.js";
import {
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
      const payload = { syncRunId, profileId: profile.id };
      await enqueue(db, "structure_sync", payload);
      await enqueue(db, "metrics_sync", payload);
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

    async dashboardSummary(workspaceId, days): Promise<DashboardSummary> {
      const { start, end } = dateRange(now(), days);
      const all = await profiles.listProfilesByWorkspace(db, workspaceId);
      const enabled = all.filter((p) => p.enabled);

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

      const lastDataDate = dailyRows.at(-1)?.date ?? null;

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
        daily: dailyRows.map((row) => ({
          date: row.date,
          cost: row.cost,
          sales: row.sales,
        })),
      };
    },

    async listCampaigns(workspaceId, days) {
      const { start, end } = dateRange(now(), days);
      const rows = await dashboard.listCampaignRows(
        db,
        workspaceId,
        start,
        end,
      );
      return rows.map((row) => ({
        profileId: row.amazonProfileId,
        campaignId: row.amazonCampaignId,
        name: row.name,
        state: row.state,
        totals: row.totals,
      }));
    },

    async getCampaignDetail(workspaceId, amazonCampaignId, days) {
      const campaign = await structure.findCampaignByAmazonId(
        db,
        workspaceId,
        amazonCampaignId,
      );
      if (!campaign) return null;
      const { start, end } = dateRange(now(), days);
      const rows = await dashboard.listCampaignRows(
        db,
        workspaceId,
        start,
        end,
      );
      const row = rows.find(
        (r) =>
          r.amazonCampaignId === amazonCampaignId &&
          r.profilePk === campaign.profileId,
      );
      const [adGroups, targets, searchTerms] = await Promise.all([
        dashboard.listAdGroupRows(db, campaign.id, start, end),
        dashboard.listTargetRows(db, campaign.id, start, end),
        dashboard.listSearchTermRows(
          db,
          campaign.profileId,
          amazonCampaignId,
          start,
          end,
        ),
      ]);
      return {
        campaign: {
          profileId: campaign.amazonProfileId,
          campaignId: campaign.amazonCampaignId,
          name: campaign.name,
          state: campaign.state,
          totals: row?.totals ?? {
            impressions: 0,
            clicks: 0,
            cost: "0",
            sales: "0",
            orders: 0,
          },
        },
        adGroups,
        targets,
        searchTerms,
      };
    },

    async listBooks(workspaceId) {
      const rows = await books.listBooks(db, workspaceId);
      return rows.map((row) => ({
        id: row.id,
        asin: row.asin,
        title: row.title,
        format: row.format,
        status: row.status,
      }));
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
