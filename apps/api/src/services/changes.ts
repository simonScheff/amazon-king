import {
  AdapterValidationError,
  AmazonApiError,
  AmazonNetworkError,
  type ActionResult,
  type AmazonAdsGateway,
  type CampaignBidControls,
  type CampaignDynamicBidding,
  type ChangeAction as GatewayAction,
  type StructureSnapshot,
} from "@amazon-king/amazon-ads";
import {
  recommendationChangeActionType,
  type CampaignMaxCpc,
  type MaxCpcChangeSetResult,
} from "@amazon-king/contracts";
import {
  checkGuardrails,
  DEFAULT_GUARDRAIL_CONFIG,
  microsFromDecimalString,
  type GuardrailAction,
  type GuardrailResult,
} from "@amazon-king/optimizer";
import {
  audit,
  bidPolicies,
  buildChangeActionFingerprint,
  buildChangeSetFingerprint,
  changes,
  profiles,
  recommendations,
  structure,
  stableStringify,
  type Db,
  type Pool,
} from "@amazon-king/database";
import type { FastifyBaseLogger as Logger } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import {
  isoDate,
  toContractChangeAction,
  toContractChangeSet,
} from "../serialize.js";
import type {
  AuthContext,
  ChangeService,
  ChangeSetWithActions,
  RequestMeta,
} from "./types.js";
import {
  buildMaxCpcActionDrafts,
  canonicalBid,
  isActiveOptimizationRule,
} from "./max-cpc.js";

/**
 * Guarded writes (plan §10): create → preview → apply → verify, and
 * compensating rollback. The apply flow re-reads Amazon state and compares
 * it to the immutable before snapshot, re-runs guardrails, maps per-item
 * results, and verifies the intended state after writing.
 */

export interface ChangeServiceDeps {
  db: Db;
  pool: Pool;
  config: ApiConfig;
  logger: Logger;
  gateway: Pick<
    AmazonAdsGateway,
    "syncCampaignStructure" | "getCampaignBidControls" | "applyActions"
  >;
  now?: () => Date;
}

interface LoadedSet {
  set: changes.ChangeSetWithProfile;
  actions: changes.ChangeAction[];
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

function bidMicros(bid: number | null): number | null {
  return bid === null ? null : Math.round(bid * 1_000_000);
}

function sameState(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function amazonErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = amazonErrorMessage(item);
      if (message) return message;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of [
    "message",
    "detail",
    "details",
    "errorDescription",
    "error_description",
    "errors",
    "errorDetails",
    "error",
  ]) {
    if (!(key in record)) continue;
    const message = amazonErrorMessage(record[key]);
    if (message) return message;
  }
  return null;
}

function applyFailureDetails(error: unknown): {
  code: string;
  message: string;
  requestId: string | null;
  details: unknown;
} {
  if (error instanceof AmazonApiError) {
    return {
      code: `AMAZON_HTTP_${error.status}`,
      message: amazonErrorMessage(error.details) ?? error.message,
      requestId: error.requestId,
      details: error.details ?? null,
    };
  }
  if (error instanceof AdapterValidationError) {
    return {
      code: "AMAZON_RESPONSE_INVALID",
      message: error.message,
      requestId: null,
      details: { context: error.context, issues: error.issues },
    };
  }
  if (error instanceof AmazonNetworkError) {
    return {
      code: "AMAZON_NETWORK_ERROR",
      message: error.message,
      requestId: null,
      details: null,
    };
  }
  return {
    code: "AMAZON_APPLY_FAILED",
    message:
      error instanceof Error
        ? error.message
        : "Amazon apply failed before a result was returned",
    requestId: null,
    details: null,
  };
}

export function createChangeService(deps: ChangeServiceDeps): ChangeService {
  const { db, pool, config, logger, gateway } = deps;
  const now = () => deps.now?.() ?? new Date();

  async function loadSet(
    auth: AuthContext,
    changeSetId: string,
  ): Promise<LoadedSet> {
    const set = await changes.getChangeSetForWorkspace(
      db,
      auth.workspaceId,
      changeSetId,
    );
    if (!set) throw notFound("Unknown change set");
    const actions = await changes.listChangeActions(db, set.id);
    return { set, actions };
  }

  /** Recommendations linked to the actions, keyed by recommendation id. */
  async function loadRecommendations(
    auth: AuthContext,
    actions: readonly changes.ChangeAction[],
  ): Promise<Map<string, recommendations.RecommendationWithProfile>> {
    const map = new Map<string, recommendations.RecommendationWithProfile>();
    for (const action of actions) {
      if (!action.recommendationId || map.has(action.recommendationId))
        continue;
      const rec = await recommendations.getRecommendationForWorkspace(
        db,
        auth.workspaceId,
        action.recommendationId,
      );
      if (rec) map.set(rec.id, rec);
    }
    return map;
  }

  function guardrailActions(
    actions: readonly changes.ChangeAction[],
    recById: Map<string, recommendations.RecommendationWithProfile>,
  ): GuardrailAction[] {
    const today = now().toISOString().slice(0, 10);
    return actions.map((action) => {
      const rec = action.recommendationId
        ? recById.get(action.recommendationId)
        : undefined;
      return {
        actionType:
          action.actionType === "add_negative_exact" ||
          action.actionType === "remove_negative_exact"
            ? action.actionType
            : "update_bid",
        targetId: action.targetId ?? action.amazonEntityId,
        campaignId: action.campaignId,
        searchTerm: action.searchTerm,
        beforeMicros: action.beforeValue
          ? microsFromDecimalString(action.beforeValue)
          : null,
        afterMicros: action.afterValue
          ? microsFromDecimalString(action.afterValue)
          : null,
        // Rollback actions have no recommendation; they are never stale.
        // PostgreSQL drivers may return a date column as a local-midnight
        // Date. Normalize it without shifting the calendar day before the
        // optimizer's strict YYYY-MM-DD parser sees it.
        evidenceEnd: rec ? isoDate(rec.evidenceWindowEnd) : today,
      };
    });
  }

  async function evaluateGuardrails(
    set: changes.ChangeSetWithProfile,
    gActions: GuardrailAction[],
    /** Change set whose applied actions are ignored for cooldown (rollback). */
    cooldownExemptSetId: string | null,
  ): Promise<GuardrailResult> {
    const profile = await profiles.getProfile(db, set.profileId);
    if (!profile) throw new ApiError(500, "INTERNAL", "Profile row missing");
    const since = new Date(
      now().getTime() - DEFAULT_GUARDRAIL_CONFIG.bidCooldownDays * 86_400_000,
    );
    const recent = await changes.listRecentAppliedActions(
      db,
      set.profileId,
      since,
    );
    return checkGuardrails({
      killSwitch: config.killSwitch,
      writeEnabled: profile.writeEnabled,
      now: now().toISOString(),
      actions: gActions,
      recentChanges: recent
        .filter((r) => r.changeSetId !== cooldownExemptSetId)
        .filter(
          (r) =>
            r.actionType === "update_bid" ||
            r.actionType === "add_negative_exact",
        )
        .map((r) => ({
          actionType: r.actionType as "update_bid" | "add_negative_exact",
          targetId: r.targetId,
          campaignId: r.campaignId,
          searchTerm: r.searchTerm,
          changedAt: r.changedAt,
        })),
      ...(set.kind === "max_cpc"
        ? {
            config: {
              // A ceiling batch can contain every bid in a campaign. It only
              // reduces monetary exposure; construction below forbids raises.
              maxActionsPerChangeSet: 5_000,
              maxBidChangePct: 1,
              bidCooldownDays: 0,
              stalenessDays: 1,
            },
          }
        : {}),
    });
  }

  async function recordAudit(
    auth: AuthContext,
    meta: RequestMeta,
    event: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await audit.insertAuditEvent(db, {
      workspaceId: auth.workspaceId,
      actorUserId: auth.userId,
      event,
      entityType: "change_set",
      entityId,
      ip: meta.ip ?? null,
      sessionId: auth.sessionId,
      details,
    });
  }

  async function assertActiveMaxCpc(
    actions: readonly changes.ChangeAction[],
  ): Promise<void> {
    const policies = new Map<string, bidPolicies.CampaignBidPolicy | null>();
    for (const action of actions) {
      if (
        action.campaignId === null ||
        action.afterValue === null ||
        (action.actionType !== "update_bid" &&
          action.actionType !== "update_ad_group_default_bid")
      ) {
        continue;
      }
      if (!policies.has(action.campaignId)) {
        policies.set(
          action.campaignId,
          await bidPolicies.getCampaignBidPolicy(db, action.campaignId),
        );
      }
      const policy = policies.get(action.campaignId);
      if (
        policy?.status === "active" &&
        microsFromDecimalString(action.afterValue) >
          microsFromDecimalString(policy.maxCpc)
      ) {
        throw conflict(
          "MAX_CPC_EXCEEDED",
          `The proposed bid ${action.afterValue} exceeds this campaign's Max CPC of ${policy.maxCpc}`,
        );
      }
    }
  }

  function toResult(
    set: changes.ChangeSetWithProfile,
    actions: changes.ChangeAction[],
  ) {
    return {
      changeSet: toContractChangeSet(set),
      actions: actions.map(toContractChangeAction),
    };
  }

  async function toCampaignMaxCpc(
    campaignPk: string,
    amazonProfileId: string,
    currency: string,
    writeEnabled: boolean,
    live: CampaignBidControls,
  ): Promise<CampaignMaxCpc> {
    const policy = await bidPolicies.getCampaignBidPolicy(db, campaignPk);
    const cap = policy ? Number(policy.maxCpc) : null;
    const baseBids = [
      ...live.adGroups.map((item) => item.defaultBid),
      ...live.keywords.map((item) => item.bid),
      ...live.targets.map((item) => item.bid),
    ].filter((value): value is number => value !== null);
    const currentMaxBase = baseBids.length > 0 ? Math.max(...baseBids) : null;
    const adjustments = [
      ...(live.campaign.dynamicBidding?.placements ?? []).map((item) => ({
        type: "placement" as const,
        name: item.name,
        percentage: item.percentage,
      })),
      ...(live.campaign.dynamicBidding?.audiences ?? []).map((item) => ({
        type: "audience" as const,
        name: item.name,
        percentage: item.percentage,
      })),
    ];
    const activeRules = live.optimizationRules
      .filter((rule) => isActiveOptimizationRule(rule.status))
      .map((rule) => ({
        id: rule.optimizationRuleId,
        name: rule.name,
        category: rule.ruleCategory,
        subcategory: rule.ruleSubCategory,
        status: rule.status,
      }));
    const coverageIssues: string[] = [];
    if (live.campaign.dynamicBidding?.strategy !== "LEGACY_FOR_SALES") {
      coverageIssues.push("Dynamic bid increases are not disabled");
    }
    if (adjustments.some((item) => item.percentage > 0)) {
      coverageIssues.push("Placement or audience bid adjustments are active");
    }
    if (activeRules.length > 0) {
      coverageIssues.push(
        "Amazon bid rules can still change the effective CPC",
      );
    }
    const bidsAboveCeiling =
      cap === null ? 0 : baseBids.filter((bid) => bid > cap).length;
    if (bidsAboveCeiling > 0) {
      coverageIssues.push(`${bidsAboveCeiling} base bids exceed the ceiling`);
    }
    let status: CampaignMaxCpc["status"] = "not_configured";
    if (policy?.status === "pending") status = "pending";
    if (policy?.status === "drifted") status = "drifted";
    if (policy?.status === "active") {
      status = coverageIssues.length === 0 ? "covered" : "drifted";
    }
    const knownMultiplier =
      adjustments.length === 0
        ? 1
        : adjustments.reduce(
            (multiplier, item) => multiplier * (1 + item.percentage / 100),
            1,
          );
    const currentMaxAdjusted =
      currentMaxBase === null ||
      live.campaign.dynamicBidding === null ||
      live.campaign.dynamicBidding?.strategy === "AUTO_FOR_SALES" ||
      live.campaign.dynamicBidding?.strategy === "RULE_BASED" ||
      activeRules.length > 0
        ? null
        : currentMaxBase * knownMultiplier;
    return {
      campaignId: live.campaign.campaignId,
      profileId: amazonProfileId,
      currency,
      maxCpc: policy?.maxCpc ?? null,
      status,
      strategy: live.campaign.dynamicBidding?.strategy ?? null,
      adjustments,
      activeBidRules: activeRules,
      coverageIssues,
      currentMaxBaseBid:
        currentMaxBase === null ? null : canonicalBid(currentMaxBase),
      currentMaxAdjustedBid:
        currentMaxAdjusted === null ? null : canonicalBid(currentMaxAdjusted),
      counts: {
        adGroups: live.adGroups.length,
        explicitTargetBids:
          live.keywords.filter((item) => item.bid !== null).length +
          live.targets.filter((item) => item.bid !== null).length,
        bidsAboveCeiling,
      },
      writeEnabled,
      sourceReadAt: live.retrievedAt,
      enforcedAt: policy?.enforcedAt ?? null,
    };
  }

  async function loadCampaignControls(
    workspaceId: string,
    amazonCampaignId: string,
  ) {
    const campaign = await structure.findCampaignByAmazonId(
      db,
      workspaceId,
      amazonCampaignId,
    );
    if (!campaign) throw notFound("Unknown campaign");
    const profile = await profiles.getProfile(db, campaign.profileId);
    if (!profile) throw new ApiError(500, "INTERNAL", "Profile row missing");
    const live = await gateway.getCampaignBidControls(
      campaign.profileId,
      amazonCampaignId,
    );
    return {
      campaign,
      profile,
      live,
      controls: await toCampaignMaxCpc(
        campaign.id,
        profile.profileId,
        profile.currencyCode,
        profile.writeEnabled,
        live,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Amazon state comparison helpers
  // -------------------------------------------------------------------------

  interface TranslatedAction {
    action: changes.ChangeAction;
    gatewayAction: GatewayAction;
    /** Amazon ids needed for verification. */
    amazonTargetId: string | null;
    amazonCampaignId: string | null;
    amazonAdGroupId: string | null;
    /** Already satisfied on Amazon (e.g. negative exists) — do not resend. */
    preSatisfied: boolean;
  }

  function findCurrentBid(
    snapshot: StructureSnapshot,
    amazonTargetId: string,
  ): number | null | undefined {
    const keyword = snapshot.keywords.find(
      (k) => k.keywordId === amazonTargetId,
    );
    if (keyword) return keyword.bid;
    const target = snapshot.targets.find((t) => t.targetId === amazonTargetId);
    if (target) return target.bid;
    return undefined; // entity missing on Amazon
  }

  function findCurrentState(
    snapshot: StructureSnapshot,
    amazonTargetId: string,
  ): string | undefined {
    return (
      snapshot.keywords.find((item) => item.keywordId === amazonTargetId)
        ?.state ??
      snapshot.targets.find((item) => item.targetId === amazonTargetId)?.state
    );
  }

  function stateRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function findControlBid(
    controls: CampaignBidControls,
    amazonEntityId: string,
    entityType: "keyword" | "target",
  ): number | null | undefined {
    return entityType === "keyword"
      ? controls.keywords.find((item) => item.keywordId === amazonEntityId)?.bid
      : controls.targets.find((item) => item.targetId === amazonEntityId)?.bid;
  }

  function findControlState(
    controls: CampaignBidControls,
    amazonEntityId: string,
    entityType: "keyword" | "target",
  ): string | undefined {
    return entityType === "keyword"
      ? controls.keywords.find((item) => item.keywordId === amazonEntityId)
          ?.state
      : controls.targets.find((item) => item.targetId === amazonEntityId)
          ?.state;
  }

  function negativeExists(
    snapshot: StructureSnapshot,
    amazonCampaignId: string,
    amazonAdGroupId: string | null,
    searchTerm: string,
  ): boolean {
    return (
      findNegative(snapshot, amazonCampaignId, amazonAdGroupId, searchTerm) !==
      undefined
    );
  }

  function findNegative(
    snapshot: StructureSnapshot,
    amazonCampaignId: string,
    amazonAdGroupId: string | null,
    searchTerm: string,
  ) {
    const term = searchTerm.trim().toLowerCase();
    return snapshot.negativeKeywords.find(
      (nk) =>
        nk.campaignId === amazonCampaignId &&
        (amazonAdGroupId === null
          ? nk.adGroupId === null
          : nk.adGroupId === amazonAdGroupId) &&
        nk.keywordText.trim().toLowerCase() === term,
    );
  }

  /**
   * Resolve internal ids to Amazon ids and compare the live state to the
   * stored before snapshot. Throws STALE_BEFORE_STATE on any mismatch.
   */
  async function translateAndCheckBeforeState(
    actions: readonly changes.ChangeAction[],
    snapshot: StructureSnapshot | null,
    bidControls: CampaignBidControls | null,
  ): Promise<TranslatedAction[]> {
    const translated: TranslatedAction[] = [];
    for (const action of actions) {
      if (action.actionType === "update_bid") {
        if (!action.afterValue) {
          throw new ApiError(500, "INTERNAL", "Malformed update_bid action");
        }
        let amazonTargetId: string;
        let entityType: "keyword" | "target";
        let currentBid: number | null | undefined;
        let currentState: string | undefined;
        if (action.amazonEntityId && bidControls) {
          amazonTargetId = action.amazonEntityId;
          entityType =
            stateRecord(action.beforeState).entityType === "target"
              ? "target"
              : "keyword";
          currentBid = findControlBid(bidControls, amazonTargetId, entityType);
          currentState = findControlState(
            bidControls,
            amazonTargetId,
            entityType,
          );
        } else {
          if (!action.targetId || !snapshot) {
            throw new ApiError(500, "INTERNAL", "Malformed update_bid action");
          }
          const target = await structure.getTarget(db, action.targetId);
          if (!target) {
            throw conflict(
              "STALE_BEFORE_STATE",
              "Target no longer exists locally; re-sync before applying",
            );
          }
          amazonTargetId = target.amazonTargetId;
          entityType = target.targetKind === "product" ? "target" : "keyword";
          currentBid = findCurrentBid(snapshot, target.amazonTargetId);
          currentState = findCurrentState(snapshot, target.amazonTargetId);
        }
        const beforeMicros = action.beforeValue
          ? microsFromDecimalString(action.beforeValue)
          : null;
        const afterMicros = microsFromDecimalString(action.afterValue);
        const preSatisfied = bidMicros(currentBid ?? null) === afterMicros;
        if (
          !preSatisfied &&
          (currentBid === undefined || bidMicros(currentBid) !== beforeMicros)
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            `Amazon bid for target ${amazonTargetId} no longer matches the approved before-state; re-sync and re-create the change set`,
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "update_bid",
            keywordId: amazonTargetId,
            entityType,
            bid: action.afterValue,
            ...(currentState ? { state: currentState } : {}),
          },
          amazonTargetId,
          amazonCampaignId: null,
          amazonAdGroupId: null,
          preSatisfied,
        });
      } else if (action.actionType === "update_ad_group_default_bid") {
        if (!action.amazonEntityId || !action.afterValue || !bidControls) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Malformed update_ad_group_default_bid action",
          );
        }
        const liveAdGroup = bidControls.adGroups.find(
          (item) => item.adGroupId === action.amazonEntityId,
        );
        const current = liveAdGroup?.defaultBid;
        const preSatisfied =
          bidMicros(current ?? null) ===
          microsFromDecimalString(action.afterValue);
        if (
          !preSatisfied &&
          (current === undefined ||
            bidMicros(current) !==
              (action.beforeValue
                ? microsFromDecimalString(action.beforeValue)
                : null))
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            `Amazon default bid for ad group ${action.amazonEntityId} changed; re-create the Max CPC change set`,
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "update_ad_group_default_bid",
            adGroupId: action.amazonEntityId,
            bid: action.afterValue,
            ...(liveAdGroup?.state ? { state: liveAdGroup.state } : {}),
          },
          amazonTargetId: action.amazonEntityId,
          amazonCampaignId: bidControls.campaign.campaignId,
          amazonAdGroupId: action.amazonEntityId,
          preSatisfied,
        });
      } else if (action.actionType === "update_campaign_bidding") {
        if (!action.amazonEntityId || !bidControls) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Malformed update_campaign_bidding action",
          );
        }
        const preSatisfied = sameState(
          bidControls.campaign.dynamicBidding,
          action.afterState,
        );
        if (
          !preSatisfied &&
          !sameState(bidControls.campaign.dynamicBidding, action.beforeState)
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            "Amazon campaign bidding settings changed; re-create the Max CPC change set",
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "update_campaign_bidding",
            campaignId: action.amazonEntityId,
            dynamicBidding: action.afterState as CampaignDynamicBidding,
            state: bidControls.campaign.state,
          },
          amazonTargetId: null,
          amazonCampaignId: action.amazonEntityId,
          amazonAdGroupId: null,
          preSatisfied,
        });
      } else if (action.actionType === "update_optimization_rule") {
        if (!action.amazonEntityId || !bidControls) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Malformed update_optimization_rule action",
          );
        }
        const rule = bidControls.optimizationRules.find(
          (item) => item.optimizationRuleId === action.amazonEntityId,
        );
        const preSatisfied =
          rule !== undefined && !isActiveOptimizationRule(rule.status);
        if (
          !preSatisfied &&
          (!rule || !sameState(rule.raw, action.beforeState))
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            `Amazon bid rule ${action.amazonEntityId} changed; re-create the Max CPC change set`,
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "update_optimization_rule",
            optimizationRuleId: action.amazonEntityId,
            rule: stateRecord(action.afterState),
          },
          amazonTargetId: action.amazonEntityId,
          amazonCampaignId: bidControls.campaign.campaignId,
          amazonAdGroupId: null,
          preSatisfied,
        });
      } else if (action.actionType === "add_negative_exact") {
        if (!snapshot) {
          throw new ApiError(500, "INTERNAL", "Missing structure snapshot");
        }
        if (!action.campaignId || !action.searchTerm) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Malformed add_negative_exact action",
          );
        }
        const campaign = await structure.getCampaign(db, action.campaignId);
        if (!campaign) {
          throw conflict(
            "STALE_BEFORE_STATE",
            "Campaign no longer exists locally; re-sync before applying",
          );
        }
        const adGroup = action.adGroupId
          ? await structure.getAdGroup(db, action.adGroupId)
          : null;
        const existing = findNegative(
          snapshot,
          campaign.amazonCampaignId,
          adGroup?.amazonAdGroupId ?? null,
          action.searchTerm,
        );
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "add_negative_exact",
            campaignId: campaign.amazonCampaignId,
            ...(adGroup ? { adGroupId: adGroup.amazonAdGroupId } : {}),
            keywordText: action.searchTerm,
          },
          amazonCampaignId: campaign.amazonCampaignId,
          amazonAdGroupId: adGroup?.amazonAdGroupId ?? null,
          // An identical negative already present means the desired end
          // state is reached; skip resending (idempotent retry safe).
          amazonTargetId: existing?.negativeKeywordId ?? null,
          preSatisfied: existing !== undefined,
        });
      } else if (action.actionType === "remove_negative_exact") {
        if (
          !snapshot ||
          !action.amazonEntityId ||
          !action.campaignId ||
          !action.searchTerm
        ) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Malformed remove_negative_exact action",
          );
        }
        const campaign = await structure.getCampaign(db, action.campaignId);
        if (!campaign) {
          throw conflict(
            "STALE_BEFORE_STATE",
            "Campaign no longer exists locally; re-sync before rolling back",
          );
        }
        const liveNegative = snapshot.negativeKeywords.find(
          (item) => item.negativeKeywordId === action.amazonEntityId,
        );
        if (
          liveNegative &&
          (liveNegative.campaignId !== campaign.amazonCampaignId ||
            liveNegative.adGroupId !== null ||
            liveNegative.keywordText.trim().toLowerCase() !==
              action.searchTerm.trim().toLowerCase())
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            "The Amazon negative keyword no longer matches the action being rolled back",
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "remove_negative_exact",
            negativeKeywordId: action.amazonEntityId,
            scope: action.adGroupId ? "ad_group" : "campaign",
          },
          amazonTargetId: action.amazonEntityId,
          amazonCampaignId: campaign.amazonCampaignId,
          amazonAdGroupId: null,
          preSatisfied: liveNegative === undefined,
        });
      } else {
        throw new ApiError(
          500,
          "INTERNAL",
          `Unsupported change action ${action.actionType}`,
        );
      }
    }
    return translated;
  }

  // -------------------------------------------------------------------------
  // Apply pipeline (shared by apply and rollback)
  // -------------------------------------------------------------------------

  async function applyLoadedSet(
    auth: AuthContext,
    meta: RequestMeta,
    loaded: LoadedSet,
    cooldownExemptSetId: string | null,
  ): Promise<ChangeSetWithActions> {
    const { set, actions } = loaded;
    let translatedForFailure: TranslatedAction[] = [];

    // Idempotent re-apply: a finished set returns its stored result without
    // touching Amazon again (plan §10 step 1: cannot be applied twice).
    if (["applied", "partially_applied"].includes(set.status)) {
      return toResult(set, actions);
    }
    if (set.status === "applying") {
      throw conflict(
        "APPLY_IN_PROGRESS",
        "Change set is already being applied",
      );
    }
    if (set.status === "blocked") {
      throw conflict(
        "CHANGE_SET_BLOCKED",
        "Change set is blocked; create a fresh set from current data",
      );
    }

    const profile = await profiles.getProfile(db, set.profileId);
    if (!profile) throw new ApiError(500, "INTERNAL", "Profile row missing");
    if (!profile.writeEnabled) {
      throw forbidden(
        "WRITES_DISABLED",
        "Profile is read-only; enable writes before applying changes",
      );
    }

    // Lock the set. A failed attempt may be retried only through this same
    // guarded path: live state is re-read and compared before anything is sent.
    const locked = await changes.transitionChangeSetStatus(
      db,
      set.id,
      ["draft", "previewed", "failed"],
      "applying",
    );
    if (!locked) {
      const reloaded = await loadSet(auth, set.id);
      if (["applied", "partially_applied"].includes(reloaded.set.status)) {
        return toResult(reloaded.set, reloaded.actions);
      }
      throw conflict(
        "APPLY_IN_PROGRESS",
        "Change set is already being applied",
      );
    }

    try {
      // Step 2: recommendations must not be expired.
      const recById = await loadRecommendations(auth, actions);
      for (const rec of recById.values()) {
        if (rec.state === "expired" || new Date(rec.expiresAt) <= now()) {
          await changes.transitionChangeSetStatus(
            db,
            set.id,
            ["applying"],
            "previewed",
          );
          throw conflict(
            "RECOMMENDATION_EXPIRED",
            "A recommendation in this change set has expired; re-create the set from fresh data",
          );
        }
      }

      try {
        await assertActiveMaxCpc(actions);
      } catch (error) {
        if (error instanceof ApiError && error.code === "MAX_CPC_EXCEEDED") {
          await changes.transitionChangeSetStatus(
            db,
            set.id,
            ["applying"],
            "blocked",
          );
          await recordAudit(auth, meta, "change_set.blocked", set.id, {
            reason: "max_cpc_exceeded",
          });
        }
        throw error;
      }

      // Steps 3–4: re-read Amazon state and compare to the before snapshot.
      const maxCampaignId =
        set.kind === "max_cpc" &&
        typeof set.metadata.amazonCampaignId === "string"
          ? set.metadata.amazonCampaignId
          : null;
      const snapshot =
        set.kind === "max_cpc"
          ? null
          : await gateway.syncCampaignStructure(set.profileId);
      const liveBidControls = maxCampaignId
        ? await gateway.getCampaignBidControls(set.profileId, maxCampaignId)
        : null;
      let translated: TranslatedAction[];
      try {
        translated = await translateAndCheckBeforeState(
          actions,
          snapshot,
          liveBidControls,
        );
        translatedForFailure = translated;
      } catch (error) {
        if (error instanceof ApiError && error.code === "STALE_BEFORE_STATE") {
          await changes.transitionChangeSetStatus(
            db,
            set.id,
            ["applying"],
            "blocked",
          );
          await recordAudit(auth, meta, "change_set.blocked", set.id, {
            reason: "stale_before_state",
          });
        }
        throw error;
      }

      // Step 5: re-run guardrails.
      const guardrails = await evaluateGuardrails(
        set,
        guardrailActions(actions, recById),
        cooldownExemptSetId,
      );
      if (!guardrails.allowed) {
        await changes.transitionChangeSetStatus(
          db,
          set.id,
          ["applying"],
          "blocked",
          guardrails,
        );
        await recordAudit(auth, meta, "change_set.blocked", set.id, {
          violations: guardrails.violations.map((v) => v.code),
        });
        throw conflict(
          "GUARDRAIL_VIOLATION",
          "Change set violates guardrails",
          guardrails.violations.map((v) => `${v.code}: ${v.message}`),
        );
      }

      // Steps 6–7: translate and send, keeping per-item fingerprints.
      const toSend = translated.filter((t) => !t.preSatisfied);
      let results: ActionResult[] = [];
      if (toSend.length > 0) {
        results = await gateway.applyActions({
          changeSetId: set.id,
          profileId: set.profileId,
          actions: toSend.map((t) => t.gatewayAction),
        });
      }
      const resultByActionId = new Map(results.map((r) => [r.actionId, r]));

      // Per-item result handling — a batch success never implies item success.
      for (const t of translated) {
        if (t.preSatisfied) {
          await changes.recordChangeActionResult(db, t.action.id, {
            status: "applied",
            amazonResponse: {
              code:
                t.action.actionType === "remove_negative_exact"
                  ? "ALREADY_ABSENT"
                  : "ALREADY_PRESENT",
            },
            amazonEntityId:
              t.action.actionType === "add_negative_exact"
                ? null
                : t.amazonTargetId,
          });
          continue;
        }
        const r = resultByActionId.get(t.action.id);
        await changes.recordChangeActionResult(db, t.action.id, {
          status: r?.status === "applied" ? "applied" : "failed",
          amazonRequest: t.gatewayAction,
          amazonResponse: r
            ? {
                code: r.code,
                message: r.message ?? null,
                amazonEntityId: r.amazonEntityId ?? null,
              }
            : { code: "NO_RESULT" },
          amazonRequestId: null,
          amazonEntityId: r?.amazonEntityId ?? null,
        });
      }

      // Post-write verification: re-read and confirm the intended state.
      const verification =
        set.kind === "max_cpc"
          ? null
          : await gateway.syncCampaignStructure(set.profileId);
      const bidVerification = maxCampaignId
        ? await gateway.getCampaignBidControls(set.profileId, maxCampaignId)
        : null;
      for (const t of translated) {
        const current = await changes.getChangeAction(db, t.action.id);
        if (!current || current.status !== "applied") continue;
        let verified = false;
        if (t.action.actionType === "update_bid" && t.amazonTargetId) {
          const entityType =
            stateRecord(t.action.beforeState).entityType === "target"
              ? "target"
              : "keyword";
          const currentBid = bidVerification
            ? findControlBid(bidVerification, t.amazonTargetId, entityType)
            : verification
              ? findCurrentBid(verification, t.amazonTargetId)
              : undefined;
          verified =
            currentBid !== undefined &&
            bidMicros(currentBid) ===
              microsFromDecimalString(t.action.afterValue ?? "0");
        } else if (
          t.action.actionType === "update_ad_group_default_bid" &&
          t.amazonAdGroupId &&
          bidVerification
        ) {
          const current = bidVerification.adGroups.find(
            (item) => item.adGroupId === t.amazonAdGroupId,
          )?.defaultBid;
          verified =
            current !== undefined &&
            bidMicros(current) ===
              microsFromDecimalString(t.action.afterValue ?? "0");
        } else if (
          t.action.actionType === "update_campaign_bidding" &&
          bidVerification
        ) {
          verified = sameState(
            bidVerification.campaign.dynamicBidding,
            t.action.afterState,
          );
        } else if (
          t.action.actionType === "update_optimization_rule" &&
          t.amazonTargetId &&
          bidVerification
        ) {
          const rule = bidVerification.optimizationRules.find(
            (item) => item.optimizationRuleId === t.amazonTargetId,
          );
          verified =
            rule !== undefined && !isActiveOptimizationRule(rule.status);
        } else if (
          t.action.actionType === "remove_negative_exact" &&
          t.amazonTargetId &&
          verification
        ) {
          verified = !verification.negativeKeywords.some(
            (item) => item.negativeKeywordId === t.amazonTargetId,
          );
        } else if (t.amazonCampaignId && verification) {
          const negative = findNegative(
            verification,
            t.amazonCampaignId,
            t.amazonAdGroupId,
            t.action.searchTerm ?? "",
          );
          verified = negative !== undefined;
          if (negative && !t.preSatisfied) {
            await changes.recordChangeActionResult(db, t.action.id, {
              status: "applied",
              amazonEntityId: negative.negativeKeywordId,
            });
          }
        }
        await changes.recordChangeActionResult(db, t.action.id, {
          status: verified ? "applied" : "verification_failed",
          verifiedAt: verified ? now().toISOString() : null,
        });
      }

      const finalActions = await changes.listChangeActions(db, set.id);
      const appliedCount = finalActions.filter(
        (a) => a.status === "applied",
      ).length;
      const finalStatus =
        appliedCount === finalActions.length
          ? "applied"
          : appliedCount > 0
            ? "partially_applied"
            : "failed";
      await changes.transitionChangeSetStatus(
        db,
        set.id,
        ["applying"],
        finalStatus,
      );
      if (
        set.kind === "max_cpc" &&
        typeof set.metadata.campaignPk === "string"
      ) {
        await bidPolicies.markCampaignBidPolicy(
          db,
          set.metadata.campaignPk,
          finalStatus === "applied" ? "active" : "drifted",
        );
      }
      await recordAudit(auth, meta, "change_set.apply", set.id, {
        total: finalActions.length,
        applied: appliedCount,
        failed: finalActions.filter((a) => a.status === "failed").length,
        verificationFailed: finalActions.filter(
          (a) => a.status === "verification_failed",
        ).length,
      });

      const reloaded = await loadSet(auth, set.id);
      return toResult(reloaded.set, reloaded.actions);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        const failure = applyFailureDetails(error);
        logger.error(
          { err: error, changeSetId: set.id },
          "Change set apply failed",
        );
        const currentActions = await changes.listChangeActions(db, set.id);
        for (const action of currentActions) {
          if (
            action.status === "applied" ||
            action.status === "partially_applied"
          ) {
            continue;
          }
          const attempted = translatedForFailure.find(
            (item) => item.action.id === action.id,
          );
          await changes.recordChangeActionResult(db, action.id, {
            status: "failed",
            amazonRequest: attempted?.gatewayAction,
            amazonResponse: {
              code: failure.code,
              message: failure.message,
              details: failure.details,
            },
            amazonRequestId: failure.requestId,
          });
        }
        await changes.transitionChangeSetStatus(
          db,
          set.id,
          ["applying"],
          "failed",
        );
        throw new ApiError(502, "AMAZON_APPLY_FAILED", failure.message);
      }
      throw error;
    }
  }

  const service: ChangeService = {
    async getCampaignMaxCpc(workspaceId, amazonCampaignId) {
      return (await loadCampaignControls(workspaceId, amazonCampaignId))
        .controls;
    },

    async setCampaignMaxCpc(auth, amazonCampaignId, maxCpc, meta) {
      if (config.killSwitch) {
        throw forbidden(
          "WRITES_DISABLED",
          "The global kill switch is enabled; all writes are disabled",
        );
      }
      const loaded = await loadCampaignControls(
        auth.workspaceId,
        amazonCampaignId,
      );
      if (!loaded.profile.writeEnabled) {
        throw forbidden(
          "WRITES_DISABLED",
          "Profile is read-only; enable writes before creating a Max CPC change set",
        );
      }
      const cap = Number(maxCpc);
      const normalizedCap = canonicalBid(cap);
      const specs = buildMaxCpcActionDrafts({
        live: loaded.live,
        campaignPk: loaded.campaign.id,
        campaignName: loaded.campaign.name,
        maxCpc: cap,
      });
      if (specs.length > 5_000) {
        throw conflict(
          "TOO_MANY_ACTIONS",
          "This campaign has more than 5,000 bid controls. Split it into smaller campaigns before enforcing one ceiling.",
        );
      }

      const setFingerprint = buildChangeSetFingerprint({
        profileId: loaded.campaign.profileId,
        creatorUserId: auth.userId,
        actions: [
          {
            kind: "max_cpc",
            campaignId: amazonCampaignId,
            maxCpc: normalizedCap,
          },
          ...specs,
        ],
      });
      const actions = specs.map((spec) => ({
        ...spec,
        fingerprint: buildChangeActionFingerprint({
          changeSetId: setFingerprint,
          actionType: spec.actionType,
          targetId: spec.targetId,
          campaignId: spec.campaignId,
          adGroupId: spec.adGroupId,
          searchTerm: spec.searchTerm,
          beforeValue: spec.beforeValue,
          afterValue: spec.afterValue,
          amazonEntityId: spec.amazonEntityId,
          beforeState: spec.beforeState,
          afterState: spec.afterState,
        }),
      }));
      const created = await changes.createChangeSet(pool, {
        profileId: loaded.campaign.profileId,
        creatorUserId: auth.userId,
        fingerprint: setFingerprint,
        kind: "max_cpc",
        metadata: {
          campaignPk: loaded.campaign.id,
          amazonCampaignId,
          maxCpc: normalizedCap,
        },
        actions,
      });
      if (
        created.created ||
        ["draft", "previewed"].includes(created.changeSet.status)
      ) {
        await bidPolicies.upsertPendingCampaignBidPolicy(db, {
          campaignId: loaded.campaign.id,
          maxCpc: normalizedCap,
          changeSetId: created.changeSet.id,
        });
      }
      await recordAudit(
        auth,
        meta,
        "campaign.max_cpc.create",
        created.changeSet.id,
        {
          campaignId: amazonCampaignId,
          maxCpc: normalizedCap,
          actionCount: created.actions.length,
          replayed: !created.created,
        },
      );
      const reloaded = await loadSet(auth, created.changeSet.id);
      const controls = await toCampaignMaxCpc(
        loaded.campaign.id,
        loaded.profile.profileId,
        loaded.profile.currencyCode,
        loaded.profile.writeEnabled,
        loaded.live,
      );
      return {
        changeSet: toResult(reloaded.set, reloaded.actions).changeSet,
        controls,
        actionsCreated: created.actions.length,
      } satisfies MaxCpcChangeSetResult;
    },

    async createChangeSet(auth, recommendationIds, meta) {
      const ids = [...new Set(recommendationIds)];
      if (ids.length === 0) {
        throw new ApiError(400, "BAD_REQUEST", "No recommendation ids given");
      }
      const recs: recommendations.RecommendationWithProfile[] = [];
      for (const id of ids) {
        const rec = await recommendations.getRecommendationForWorkspace(
          db,
          auth.workspaceId,
          id,
        );
        if (!rec) throw notFound(`Unknown recommendation ${id}`);
        if (rec.state !== "pending" && rec.state !== "approved") {
          throw conflict(
            "INVALID_STATE",
            `Recommendation ${id} is '${rec.state}' and cannot enter a change set`,
          );
        }
        if (new Date(rec.expiresAt) <= now()) {
          throw conflict(
            "RECOMMENDATION_EXPIRED",
            `Recommendation ${id} has expired`,
          );
        }
        const actionType = recommendationChangeActionType[rec.type];
        if (!actionType) {
          throw conflict(
            "RECOMMENDATION_NOT_WRITABLE",
            `Recommendation type '${rec.type}' has no write action in the MVP`,
          );
        }
        if (
          actionType === "update_bid" &&
          (!rec.targetId || !rec.proposedValue)
        ) {
          throw conflict(
            "RECOMMENDATION_NOT_WRITABLE",
            `Recommendation ${id} lacks a target or proposed bid`,
          );
        }
        if (
          actionType === "add_negative_exact" &&
          (!rec.searchTerm || !rec.campaignId)
        ) {
          throw conflict(
            "RECOMMENDATION_NOT_WRITABLE",
            `Recommendation ${id} lacks a search term or campaign`,
          );
        }
        recs.push(rec);
      }
      const profileIds = new Set(recs.map((r) => r.profileId));
      if (profileIds.size !== 1) {
        throw new ApiError(
          400,
          "BAD_REQUEST",
          "A change set must target a single profile",
        );
      }
      const profilePk = recs[0]!.profileId;

      const specs = recs.map((rec) => ({
        recommendationId: rec.id,
        actionType: recommendationChangeActionType[rec.type]!,
        campaignId: rec.campaignId,
        adGroupId: rec.adGroupId,
        targetId: rec.type === "wasteful_search_term" ? null : rec.targetId,
        searchTerm: rec.searchTerm,
        beforeValue: rec.currentValue,
        afterValue:
          recommendationChangeActionType[rec.type] === "update_bid"
            ? rec.proposedValue
            : null,
      }));
      const setFingerprint = buildChangeSetFingerprint({
        profileId: profilePk,
        creatorUserId: auth.userId,
        actions: specs,
      });
      const created = await changes.createChangeSet(pool, {
        profileId: profilePk,
        creatorUserId: auth.userId,
        fingerprint: setFingerprint,
        actions: specs.map((spec) => ({
          ...spec,
          fingerprint: buildChangeActionFingerprint({
            changeSetId: setFingerprint,
            actionType: spec.actionType,
            targetId: spec.targetId,
            campaignId: spec.campaignId,
            adGroupId: spec.adGroupId,
            searchTerm: spec.searchTerm,
            beforeValue: spec.beforeValue,
            afterValue: spec.afterValue,
          }),
        })),
      });

      if (created.created) {
        // Creating a change set is the approval action (no separate approve route).
        for (const rec of recs) {
          await recommendations.transitionRecommendationState(
            db,
            rec.id,
            "pending",
            "approved",
          );
        }
      }
      await recordAudit(auth, meta, "change_set.create", created.changeSet.id, {
        actionCount: created.actions.length,
        replayed: !created.created,
      });

      const loaded = await loadSet(auth, created.changeSet.id);
      return toResult(loaded.set, loaded.actions);
    },

    async createCannibalizationChangeSet(
      auth,
      recommendationId,
      destinationCampaignId,
      meta,
    ) {
      const rec = await recommendations.getRecommendationForWorkspace(
        db,
        auth.workspaceId,
        recommendationId,
      );
      if (!rec) throw notFound("Unknown recommendation");
      if (rec.type !== "cannibalization_conflict") {
        throw conflict(
          "INVALID_RECOMMENDATION_TYPE",
          "Only cannibalization findings can create this resolution",
        );
      }
      if (rec.state !== "pending" && rec.state !== "approved") {
        throw conflict(
          "INVALID_STATE",
          `Recommendation ${rec.id} is '${rec.state}' and cannot enter a change set`,
        );
      }
      if (new Date(rec.expiresAt) <= now()) {
        throw conflict(
          "RECOMMENDATION_EXPIRED",
          `Recommendation ${rec.id} has expired`,
        );
      }
      const evidence = cannibalizationEvidenceSchema.safeParse(
        await recommendations.getRecommendationEvidence(db, rec.id),
      );
      if (!evidence.success) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "This finding does not contain the campaign evidence needed for a safe resolution",
        );
      }
      const campaignRows = await Promise.all(
        evidence.data.campaigns.map(async (entry) => ({
          entry,
          campaign: await structure.getCampaign(db, entry.campaignId),
        })),
      );
      if (
        campaignRows.some(
          ({ campaign }) =>
            campaign === null || campaign.profileId !== rec.profileId,
        )
      ) {
        throw conflict(
          "INCOMPLETE_EVIDENCE",
          "An affected campaign is missing or no longer belongs to this profile; re-sync before resolving",
        );
      }
      const destination = campaignRows.find(
        ({ campaign }) => campaign!.amazonCampaignId === destinationCampaignId,
      );
      if (!destination) {
        throw new ApiError(
          400,
          "BAD_REQUEST",
          "Destination must be one of the campaigns in this finding",
        );
      }
      const sourceCampaigns = campaignRows.filter(
        ({ campaign }) => campaign!.amazonCampaignId !== destinationCampaignId,
      );
      const specs = sourceCampaigns.map(({ campaign }) => ({
        recommendationId: rec.id,
        actionType: "add_negative_exact" as const,
        campaignId: campaign!.id,
        adGroupId: null,
        targetId: null,
        searchTerm: evidence.data.searchTerm,
        beforeValue: null,
        afterValue: null,
        entityName: campaign!.name,
        beforeState: {
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: false,
        },
        afterState: {
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: true,
        },
      }));
      const setFingerprint = buildChangeSetFingerprint({
        profileId: rec.profileId,
        creatorUserId: auth.userId,
        actions: [
          {
            kind: "cannibalization_resolution",
            recommendationId: rec.id,
            destinationCampaignId,
          },
          ...specs,
        ],
      });
      const created = await changes.createChangeSet(pool, {
        profileId: rec.profileId,
        creatorUserId: auth.userId,
        fingerprint: setFingerprint,
        kind: "recommendation",
        metadata: {
          strategy: "route_with_negative_exact",
          recommendationId: rec.id,
          destinationCampaignId,
          destinationCampaignName: destination.campaign!.name,
          searchTerm: evidence.data.searchTerm,
        },
        actions: specs.map((spec) => ({
          ...spec,
          fingerprint: buildChangeActionFingerprint({
            changeSetId: setFingerprint,
            actionType: spec.actionType,
            targetId: spec.targetId,
            campaignId: spec.campaignId,
            adGroupId: spec.adGroupId,
            searchTerm: spec.searchTerm,
            beforeValue: spec.beforeValue,
            afterValue: spec.afterValue,
            beforeState: spec.beforeState,
            afterState: spec.afterState,
          }),
        })),
      });
      if (created.created) {
        await recommendations.transitionRecommendationState(
          db,
          rec.id,
          "pending",
          "approved",
        );
      }
      await recordAudit(
        auth,
        meta,
        "cannibalization.change_set.create",
        created.changeSet.id,
        {
          recommendationId: rec.id,
          destinationCampaignId,
          negativeExactCampaignIds: sourceCampaigns.map(
            ({ campaign }) => campaign!.amazonCampaignId,
          ),
          actionCount: created.actions.length,
          replayed: !created.created,
        },
      );
      const loaded = await loadSet(auth, created.changeSet.id);
      return toResult(loaded.set, loaded.actions);
    },

    async previewChangeSet(auth, changeSetId, meta) {
      const { set, actions } = await loadSet(auth, changeSetId);
      const recById = await loadRecommendations(auth, actions);
      const result = await evaluateGuardrails(
        set,
        guardrailActions(actions, recById),
        null,
      );
      if (set.status === "draft" || set.status === "previewed") {
        await changes.transitionChangeSetStatus(
          db,
          set.id,
          [set.status],
          "previewed",
          result,
        );
      }
      await recordAudit(auth, meta, "change_set.preview", set.id, {
        violations: result.violations.map((v) => v.code),
      });
      const loaded = await loadSet(auth, set.id);
      return {
        ...toResult(loaded.set, loaded.actions),
        guardrails: result.violations.map((v) => `${v.code}: ${v.message}`),
      };
    },

    async applyChangeSet(auth, changeSetId, meta) {
      if (config.killSwitch) {
        throw forbidden(
          "WRITES_DISABLED",
          "The global kill switch is enabled; all writes are disabled",
        );
      }
      const loaded = await loadSet(auth, changeSetId);
      return applyLoadedSet(auth, meta, loaded, null);
    },

    async rollbackAction(auth, changeActionId, meta) {
      if (config.killSwitch) {
        throw forbidden(
          "WRITES_DISABLED",
          "The global kill switch is enabled; all writes are disabled",
        );
      }
      const original = await changes.getChangeActionForWorkspace(
        db,
        auth.workspaceId,
        changeActionId,
      );
      if (!original) throw notFound("Unknown change action");
      if (original.status !== "applied") {
        throw conflict(
          "NOT_ROLLBACKABLE",
          `Action in state '${original.status}' cannot be rolled back`,
        );
      }
      let spec: changes.ChangeActionInsert;
      if (original.actionType === "update_bid" && original.beforeValue) {
        spec = {
          recommendationId: null,
          actionType: "update_bid",
          campaignId: original.campaignId,
          adGroupId: original.adGroupId,
          targetId: original.targetId,
          searchTerm: null,
          beforeValue: original.afterValue,
          afterValue: original.beforeValue,
          rollbackOfId: original.id,
          fingerprint: "",
        };
      } else if (
        original.actionType === "add_negative_exact" &&
        original.amazonEntityId &&
        original.campaignId &&
        original.searchTerm
      ) {
        spec = {
          recommendationId: null,
          actionType: "remove_negative_exact",
          campaignId: original.campaignId,
          adGroupId: null,
          targetId: null,
          searchTerm: original.searchTerm,
          beforeValue: null,
          afterValue: null,
          rollbackOfId: original.id,
          amazonEntityId: original.amazonEntityId,
          entityName: original.entityName,
          beforeState: original.afterState,
          afterState: original.beforeState,
          fingerprint: "",
        };
      } else {
        throw conflict(
          "NOT_ROLLBACKABLE",
          "This action has no verified compensating Amazon operation",
        );
      }

      // Compensating action linked via rollback_of_id.
      const setFingerprint = buildChangeSetFingerprint({
        profileId: original.profilePk,
        creatorUserId: auth.userId,
        actions: [spec],
      });
      const created = await changes.createChangeSet(pool, {
        profileId: original.profilePk,
        creatorUserId: auth.userId,
        fingerprint: setFingerprint,
        kind: "rollback",
        actions: [
          {
            ...spec,
            fingerprint: buildChangeActionFingerprint({
              changeSetId: setFingerprint,
              actionType: spec.actionType,
              targetId: spec.targetId,
              campaignId: spec.campaignId,
              adGroupId: spec.adGroupId,
              searchTerm: spec.searchTerm,
              beforeValue: spec.beforeValue,
              afterValue: spec.afterValue,
              rollbackOfId: spec.rollbackOfId,
              amazonEntityId: spec.amazonEntityId,
              beforeState: spec.beforeState,
              afterState: spec.afterState,
            }),
          },
        ],
      });
      await recordAudit(
        auth,
        meta,
        "change_set.rollback",
        created.changeSet.id,
        {
          rollbackOf: original.id,
          replayed: !created.created,
        },
      );

      const loaded = await loadSet(auth, created.changeSet.id);
      // Same checks as a normal apply; the cooldown ignores the set being
      // undone so a rollback is not blocked by the change it compensates.
      const result = await applyLoadedSet(
        auth,
        meta,
        loaded,
        original.changeSetId,
      );
      if (result.changeSet.status === "applied") {
        await changes.recordChangeActionResult(db, original.id, {
          status: "rolled_back",
        });
      }
      return result;
    },
  };

  return service;
}
