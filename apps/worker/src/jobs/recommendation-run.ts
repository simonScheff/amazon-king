import { z } from "zod";
import {
  aggregateWindow,
  addDays,
  formatIsoDate,
  microsFromDecimalString,
  rankRecommendations,
  DEFAULT_OPTIMIZER_CONFIG,
  evaluateBudgetConstrainedWinner,
  evaluateCannibalizationConflict,
  evaluateExpensiveTarget,
  evaluateHighCtrPoorConversion,
  evaluateLowImpressions,
  evaluatePlacementOpportunity,
  evaluateProfitableTarget,
  evaluateSearchTermHarvest,
  evaluateWastefulSearchTerm,
  normalizeTerm,
} from "@amazon-king/optimizer";
import type {
  DailyMetricRow,
  EvidenceWindow,
  OptimizerConfig,
  RecommendationDraft,
  RuleContext,
  WindowMetrics,
} from "@amazon-king/optimizer";
import type {
  CurrencyCode,
  IsoDate,
  IsoDateTime,
} from "@amazon-king/contracts";
import type { Logger } from "pino";
import { TerminalJobError, type JobHandler } from "../loop.js";
import { profilePkSchema, type JobDeps } from "./types.js";
import type {
  BookEconomicsRecord,
  DailyFact,
  ProfileRecord,
  RecentChangeRecord,
  StructureData,
} from "../store.js";

/**
 * recommendation_run (plan §9): load the enabled profile's structure, daily
 * metrics (7/14/30/60-day windows), user-entered book economics, and recent
 * change actions (cooldown suppression); evaluate every deterministic rule;
 * expire stale recommendations and insert new ranked drafts with immutable
 * evidence. The run skips entirely when required datasets are incomplete
 * (data freshness check) rather than recommending from partial data, and
 * profit rules stay disabled for entities without KDP economics.
 */

const EVIDENCE_WINDOWS_DAYS = [7, 14, 30, 60] as const;

const payloadSchema = z.looseObject({
  profileId: profilePkSchema,
});

export function createRecommendationRunHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const { profileId } = payloadSchema.parse(payload);
    const profile = await deps.store.getProfile(profileId);
    if (!profile) {
      throw new TerminalJobError(`Unknown profile ${profileId}`);
    }
    if (!profile.enabled) {
      logger.info(
        { profileId },
        "Profile disabled; skipping recommendation run",
      );
      return;
    }

    // Data freshness gate (plan §8: never recommend from a silent partial dataset).
    const metricsRun = await deps.store.latestCompletedSyncRun(
      profileId,
      "metrics",
    );
    const freshnessCutoff =
      deps.now().getTime() -
      deps.config.recommendationFreshnessHours * 3_600_000;
    if (!metricsRun || Date.parse(metricsRun.finishedAt) < freshnessCutoff) {
      logger.info(
        { profileId, lastCompleteMetricsSync: metricsRun?.finishedAt ?? null },
        "Skipping recommendation run: no recent complete metrics sync",
      );
      return;
    }

    const expired = await deps.store.expireStaleRecommendations();
    const structure = await deps.store.loadStructure(profileId);
    const currency = profile.currencyCode as CurrencyCode;
    const nowIso = deps.now().toISOString() as IsoDateTime;
    const endDate = formatIsoDate(deps.now().getTime() - 86_400_000) as IsoDate;
    const sinceDate = addDays(
      endDate,
      -(Math.max(...EVIDENCE_WINDOWS_DAYS) - 1),
    );
    const facts = await deps.store.loadDailyFacts(profileId, sinceDate);
    const economics = await deps.store.listBookEconomics(profileId);
    const recentChanges = await deps.store.listRecentChanges(
      profileId,
      new Date(
        deps.now().getTime() -
          DEFAULT_OPTIMIZER_CONFIG.cooldownDays * 86_400_000,
      ).toISOString(),
    );

    const drafts = evaluateAllRules({
      profile,
      structure,
      facts,
      economics,
      recentChanges,
      currency,
      endDate,
      nowIso,
    });

    // Dedupe across windows: same rule + same entity keeps the highest impact.
    const deduped = new Map<string, RecommendationDraft>();
    for (const draft of drafts) {
      const key = `${draft.type}|${draft.campaignId}|${draft.adGroupId}|${draft.targetId}|${draft.searchTerm}`;
      const existing = deduped.get(key);
      if (!existing || draft.impactMicros > existing.impactMicros) {
        deduped.set(key, draft);
      }
    }
    const ranked = rankRecommendations([...deduped.values()]);

    let inserted = 0;
    let skippedExisting = 0;
    for (const draft of ranked) {
      const identity = {
        profileId: profile.id,
        type: draft.type,
        campaignId: draft.campaignId,
        adGroupId: draft.adGroupId,
        targetId: draft.targetId,
        searchTerm: draft.searchTerm,
      };
      if (await deps.store.pendingRecommendationExists(identity)) {
        skippedExisting += 1;
        continue;
      }
      await deps.store.insertRecommendation({
        profileId: profile.id,
        type: draft.type,
        campaignId: draft.campaignId,
        adGroupId: draft.adGroupId,
        targetId: draft.targetId,
        searchTerm: draft.searchTerm,
        priority: draft.priority,
        evidenceWindowStart: draft.evidenceWindow.start,
        evidenceWindowEnd: draft.evidenceWindow.end,
        currentValue: draft.currentValue,
        proposedValue: draft.proposedValue,
        rationale: draft.rationale,
        confidence: draft.confidence.toFixed(3),
        ruleVersion: draft.ruleVersion,
        dataFreshnessAt: metricsRun.finishedAt,
        expiresAt: new Date(
          deps.now().getTime() +
            DEFAULT_OPTIMIZER_CONFIG.stalenessDays * 86_400_000,
        ).toISOString(),
        evidenceInputs: {
          ...draft.evidenceInputs,
          requiresHumanReview: draft.requiresHumanReview,
          rank: draft.rank,
          impactMicros: draft.impactMicros,
        },
      });
      inserted += 1;
    }
    logger.info(
      { profileId, expired, drafts: ranked.length, inserted, skippedExisting },
      "Recommendation run completed",
    );
  };
}

// ---------------------------------------------------------------------------
// Rule evaluation over the loaded datasets (pure given the inputs)
// ---------------------------------------------------------------------------

interface EvaluationInputs {
  profile: ProfileRecord;
  structure: StructureData;
  facts: {
    campaign: DailyFact[];
    target: DailyFact[];
    searchTerm: DailyFact[];
    placement: DailyFact[];
  };
  economics: BookEconomicsRecord[];
  recentChanges: RecentChangeRecord[];
  currency: CurrencyCode;
  endDate: IsoDate;
  nowIso: IsoDateTime;
}

function toDailyRows(facts: readonly DailyFact[]): DailyMetricRow[] {
  return facts.map((fact) => ({
    date: fact.date as IsoDate,
    currency: fact.currency as CurrencyCode,
    impressions: fact.impressions,
    clicks: fact.clicks,
    orders: fact.orders,
    costMicros: fact.costMicros,
    salesMicros: fact.salesMicros,
  }));
}

export function evaluateAllRules(
  inputs: EvaluationInputs,
): RecommendationDraft[] {
  const { structure, facts, economics, currency, endDate, nowIso } = inputs;
  // TODO(protected-entities): the schema has no `protected_entities` table yet
  // (checked migrations/0001_initial.sql). Until one exists, the protected
  // lists stay empty; the owner cannot mark campaigns/terms as protected.
  const config: OptimizerConfig = {
    ...DEFAULT_OPTIMIZER_CONFIG,
    protectedSearchTerms: [],
    protectedCampaignIds: [],
  };

  const economicsByAsin = new Map(
    economics.map((record) => [record.marketplaceAsin, record]),
  );
  const campaignByAmazonId = new Map(
    structure.campaigns.map((campaign) => [
      campaign.amazonCampaignId,
      campaign,
    ]),
  );
  const targetByAmazonId = new Map(
    structure.targets.map((target) => [target.amazonTargetId, target]),
  );
  const adGroupById = new Map(
    structure.adGroups.map((adGroup) => [adGroup.id, adGroup]),
  );

  /** Resolve the KDP economics for a campaign through ad group → ad ASIN → book. */
  const economicsForCampaign = (
    campaignId: string,
  ): BookEconomicsRecord | null => {
    for (const adGroup of structure.adGroups) {
      if (adGroup.campaignId !== campaignId) continue;
      for (const ad of structure.ads) {
        if (ad.adGroupId !== adGroup.id) continue;
        const record = economicsByAsin.get(ad.asin);
        if (record) return record;
      }
    }
    return null;
  };

  const recentChanges = inputs.recentChanges.map((change) => ({
    actionType: change.actionType,
    targetId: change.targetId,
    campaignId: change.campaignId,
    searchTerm: change.searchTerm,
    changedAt: change.changedAt as IsoDateTime,
  }));

  const contextFor = (
    campaignId: string | null,
    window: EvidenceWindow,
  ): RuleContext => {
    const record =
      campaignId === null ? null : economicsForCampaign(campaignId);
    return {
      config,
      goalMode: record?.goalMode ?? "balanced",
      // Economics are null (never guessed) when the owner has not entered
      // them; profit rules are suppressed by the rules themselves (plan §7).
      targetAcos: record?.targetAcos ? Number(record.targetAcos) : null,
      royaltyPerSaleMicros: record
        ? microsFromDecimalString(record.estimatedRoyaltyPerSale)
        : null,
      currency,
      maxBidMicros: record?.maxBid
        ? microsFromDecimalString(record.maxBid)
        : null,
      maxDailyBudgetMicros: record?.maxDailyBudget
        ? microsFromDecimalString(record.maxDailyBudget)
        : null,
      recentChanges,
      window,
      now: nowIso,
    };
  };

  const drafts: RecommendationDraft[] = [];
  const push = (draft: RecommendationDraft | null): void => {
    if (draft) drafts.push(draft);
  };

  const exactKeywordTerms = new Set(
    structure.targets
      .filter(
        (target) =>
          target.targetKind === "keyword" &&
          target.matchType === "exact" &&
          (target.state === "enabled" || target.state === "active"),
      )
      .map((target) =>
        normalizeTerm(
          String(
            (target.expression as { value?: unknown } | null)?.value ?? "",
          ),
        ),
      ),
  );

  for (const windowDays of EVIDENCE_WINDOWS_DAYS) {
    const window: EvidenceWindow = {
      start: addDays(endDate, -(windowDays - 1)),
      end: endDate,
    };
    const aggregate = (rows: DailyFact[]): WindowMetrics =>
      aggregateWindow(toDailyRows(rows), windowDays, endDate, currency);
    const inWindow = (fact: DailyFact): boolean =>
      fact.date >= window.start && fact.date <= window.end;

    // --- target grain: expensive / profitable / low impressions ---
    const targetGroups = groupBy(facts.target, (fact) => fact.entityKey);
    for (const [amazonTargetId, rows] of targetGroups) {
      const target = targetByAmazonId.get(amazonTargetId);
      if (!target) continue;
      const ctx = contextFor(target.campaignId, window);
      const metrics = aggregate(rows);
      const adGroup = adGroupById.get(target.adGroupId);
      const bidString = target.bid ?? adGroup?.defaultBid ?? null;
      const currentBidMicros = bidString
        ? microsFromDecimalString(bidString)
        : null;
      if (
        target.state === "enabled" &&
        currentBidMicros !== null &&
        currentBidMicros > 0
      ) {
        push(
          evaluateExpensiveTarget(
            {
              targetId: target.id,
              campaignId: target.campaignId,
              adGroupId: target.adGroupId,
              currentBidMicros,
              metrics,
            },
            ctx,
          ),
        );
        push(
          evaluateProfitableTarget(
            {
              targetId: target.id,
              campaignId: target.campaignId,
              adGroupId: target.adGroupId,
              currentBidMicros,
              metrics,
            },
            ctx,
          ),
        );
      }
      push(
        evaluateLowImpressions(
          {
            targetId: target.id,
            campaignId: target.campaignId,
            adGroupId: target.adGroupId,
            state: target.state,
            currentBidMicros,
            metrics,
          },
          ctx,
        ),
      );
    }

    // --- search-term grain: wasteful / harvest / cannibalization ---
    const termGroups = groupBy(
      facts.searchTerm,
      (fact) => `${fact.entityKey}|${normalizeTerm(fact.subKey ?? "")}`,
    );
    for (const [, rows] of termGroups) {
      const first = rows[0]!;
      const target = targetByAmazonId.get(first.entityKey);
      const campaign = campaignByAmazonId.get(first.campaignAmazonId);
      const searchTerm = first.subKey ?? "";
      if (!campaign || searchTerm === "") continue;
      const ctx = contextFor(campaign.id, window);
      const metrics = aggregate(rows);
      push(
        evaluateWastefulSearchTerm(
          { searchTerm, campaignId: campaign.id, metrics },
          ctx,
        ),
      );
      const sourceTargetingType =
        campaign.targetingType === "auto"
          ? "auto"
          : target?.targetKind === "keyword"
            ? (target.matchType ?? "exact")
            : "exact";
      push(
        evaluateSearchTermHarvest(
          {
            searchTerm,
            sourceCampaignId: campaign.id,
            sourceTargetingType: sourceTargetingType as
              "auto" | "broad" | "phrase" | "exact",
            alreadyTargetedExactly: exactKeywordTerms.has(
              normalizeTerm(searchTerm),
            ),
            metrics,
          },
          ctx,
        ),
      );
    }
    const termsAcrossCampaigns = groupBy(facts.searchTerm, (fact) =>
      normalizeTerm(fact.subKey ?? ""),
    );
    for (const [term, rows] of termsAcrossCampaigns) {
      if (term === "") continue;
      const perCampaign = groupBy(
        rows.filter((row) => row.costMicros > 0 || row.orders > 0),
        (row) => row.campaignAmazonId,
      );
      const campaigns = [...perCampaign.entries()]
        .map(([amazonCampaignId, campaignRows]) => {
          const campaign = campaignByAmazonId.get(amazonCampaignId);
          if (!campaign) return null;
          const totals = aggregate(campaignRows);
          return {
            campaignId: campaign.id,
            orders: totals.orders,
            costMicros: totals.costMicros,
          };
        })
        .filter((entry) => entry !== null);
      push(
        evaluateCannibalizationConflict(
          { searchTerm: rows[0]!.subKey ?? term, campaigns },
          contextFor(null, window),
        ),
      );
    }

    // --- campaign grain: budget constrained winner / high CTR poor conversion ---
    const campaignGroups = groupBy(facts.campaign, (fact) => fact.entityKey);
    for (const [amazonCampaignId, rows] of campaignGroups) {
      const campaign = campaignByAmazonId.get(amazonCampaignId);
      if (!campaign) continue;
      const ctx = contextFor(campaign.id, window);
      const metrics = aggregate(rows);
      push(
        evaluateHighCtrPoorConversion(
          { campaignId: campaign.id, metrics },
          ctx,
        ),
      );
      if (campaign.dailyBudget) {
        const dailyBudgetMicros = microsFromDecimalString(campaign.dailyBudget);
        const byDay = groupBy(rows.filter(inWindow), (row) => row.date);
        const dailySpendMicros = [...byDay.values()].map((dayRows) =>
          dayRows.reduce((sum, row) => sum + row.costMicros, 0),
        );
        push(
          evaluateBudgetConstrainedWinner(
            {
              campaignId: campaign.id,
              dailyBudgetMicros,
              dailySpendMicros,
              metrics,
            },
            ctx,
          ),
        );
      }
    }

    // --- placement grain: placement opportunity (no import path yet; runs
    // only when placement_metrics_daily has rows) ---
    const placementGroups = groupBy(
      facts.placement,
      (fact) => `${fact.entityKey}|${fact.subKey}`,
    );
    for (const [, rows] of placementGroups) {
      const first = rows[0]!;
      const campaign = campaignByAmazonId.get(first.campaignAmazonId);
      if (!campaign) continue;
      push(
        evaluatePlacementOpportunity(
          {
            campaignId: campaign.id,
            placement: first.subKey ?? "",
            currentModifierPct: 0,
            metrics: aggregate(rows),
          },
          contextFor(campaign.id, window),
        ),
      );
    }
  }

  return drafts;
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey);
    if (group) {
      group.push(item);
    } else {
      groups.set(groupKey, [item]);
    }
  }
  return groups;
}
