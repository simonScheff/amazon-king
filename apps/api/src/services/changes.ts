import type {
  ActionResult,
  AmazonAdsGateway,
  ChangeAction as GatewayAction,
  StructureSnapshot,
} from "@amazon-king/amazon-ads";
import type { ChangeActionType } from "@amazon-king/contracts";
import {
  checkGuardrails,
  DEFAULT_GUARDRAIL_CONFIG,
  microsFromDecimalString,
  type GuardrailAction,
  type GuardrailResult,
} from "@amazon-king/optimizer";
import {
  audit,
  buildChangeActionFingerprint,
  buildChangeSetFingerprint,
  changes,
  profiles,
  recommendations,
  structure,
  type Db,
  type Pool,
} from "@amazon-king/database";
import type { FastifyBaseLogger as Logger } from "fastify";
import type { ApiConfig } from "../config.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { toContractChangeAction, toContractChangeSet } from "../serialize.js";
import type {
  AuthContext,
  ChangeService,
  ChangeSetWithActions,
  RequestMeta,
} from "./types.js";

/**
 * Guarded writes (plan §10): create → preview → apply → verify, and
 * compensating rollback. The apply flow re-reads Amazon state and compares
 * it to the immutable before snapshot, re-runs guardrails, maps per-item
 * results, and verifies the intended state after writing.
 */

/** Recommendation types that map to an MVP write action. */
const WRITABLE_TYPES: Record<string, ChangeActionType> = {
  wasteful_search_term: "add_negative_exact",
  expensive_target: "update_bid",
  profitable_target: "update_bid",
};

export interface ChangeServiceDeps {
  db: Db;
  pool: Pool;
  config: ApiConfig;
  logger: Logger;
  gateway: Pick<AmazonAdsGateway, "syncCampaignStructure" | "applyActions">;
  now?: () => Date;
}

interface LoadedSet {
  set: changes.ChangeSetWithProfile;
  actions: changes.ChangeAction[];
}

function bidMicros(bid: number | null): number | null {
  return bid === null ? null : Math.round(bid * 1_000_000);
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
        actionType: action.actionType,
        targetId: action.targetId,
        campaignId: action.campaignId,
        searchTerm: action.searchTerm,
        beforeMicros: action.beforeValue
          ? microsFromDecimalString(action.beforeValue)
          : null,
        afterMicros: action.afterValue
          ? microsFromDecimalString(action.afterValue)
          : null,
        // Rollback actions have no recommendation; they are never stale.
        evidenceEnd: rec?.evidenceWindowEnd ?? today,
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
        .map((r) => ({
          actionType: r.actionType,
          targetId: r.targetId,
          campaignId: r.campaignId,
          searchTerm: r.searchTerm,
          changedAt: r.changedAt,
        })),
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

  function toResult(
    set: changes.ChangeSetWithProfile,
    actions: changes.ChangeAction[],
  ) {
    return {
      changeSet: toContractChangeSet(set),
      actions: actions.map(toContractChangeAction),
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

  function negativeExists(
    snapshot: StructureSnapshot,
    amazonCampaignId: string,
    amazonAdGroupId: string | null,
    searchTerm: string,
  ): boolean {
    const term = searchTerm.trim().toLowerCase();
    return snapshot.negativeKeywords.some(
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
    snapshot: StructureSnapshot,
  ): Promise<TranslatedAction[]> {
    const translated: TranslatedAction[] = [];
    for (const action of actions) {
      if (action.actionType === "update_bid") {
        if (!action.targetId || !action.afterValue) {
          throw new ApiError(500, "INTERNAL", "Malformed update_bid action");
        }
        const target = await structure.getTarget(db, action.targetId);
        if (!target) {
          throw conflict(
            "STALE_BEFORE_STATE",
            "Target no longer exists locally; re-sync before applying",
          );
        }
        const currentBid = findCurrentBid(snapshot, target.amazonTargetId);
        const beforeMicros = action.beforeValue
          ? microsFromDecimalString(action.beforeValue)
          : null;
        if (
          currentBid === undefined ||
          bidMicros(currentBid) !== beforeMicros
        ) {
          throw conflict(
            "STALE_BEFORE_STATE",
            `Amazon bid for target ${target.amazonTargetId} no longer matches the approved before-state; re-sync and re-create the change set`,
          );
        }
        translated.push({
          action,
          gatewayAction: {
            actionId: action.id,
            kind: "update_bid",
            keywordId: target.amazonTargetId,
            bid: action.afterValue,
          },
          amazonTargetId: target.amazonTargetId,
          amazonCampaignId: null,
          amazonAdGroupId: null,
          preSatisfied: false,
        });
      } else {
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
        const exists = negativeExists(
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
          amazonTargetId: null,
          amazonCampaignId: campaign.amazonCampaignId,
          amazonAdGroupId: adGroup?.amazonAdGroupId ?? null,
          // An identical negative already present means the desired end
          // state is reached; skip resending (idempotent retry safe).
          preSatisfied: exists,
        });
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

    // Idempotent re-apply: a finished set returns its stored result without
    // touching Amazon again (plan §10 step 1: cannot be applied twice).
    if (["applied", "partially_applied", "failed"].includes(set.status)) {
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

    // Lock the set: only a draft/previewed set may move to applying.
    const locked = await changes.transitionChangeSetStatus(
      db,
      set.id,
      ["draft", "previewed"],
      "applying",
    );
    if (!locked) {
      const reloaded = await loadSet(auth, set.id);
      if (
        ["applied", "partially_applied", "failed"].includes(reloaded.set.status)
      ) {
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

      // Steps 3–4: re-read Amazon state and compare to the before snapshot.
      const snapshot = await gateway.syncCampaignStructure(set.profileId);
      let translated: TranslatedAction[];
      try {
        translated = await translateAndCheckBeforeState(actions, snapshot);
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
            amazonResponse: { code: "ALREADY_PRESENT" },
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
        });
      }

      // Post-write verification: re-read and confirm the intended state.
      const verification = await gateway.syncCampaignStructure(set.profileId);
      for (const t of translated) {
        const current = await changes.getChangeAction(db, t.action.id);
        if (!current || current.status !== "applied") continue;
        const verified =
          t.action.actionType === "update_bid"
            ? t.amazonTargetId !== null &&
              bidMicros(
                findCurrentBid(verification, t.amazonTargetId) ?? null,
              ) === microsFromDecimalString(t.action.afterValue ?? "0")
            : t.amazonCampaignId !== null &&
              negativeExists(
                verification,
                t.amazonCampaignId,
                t.amazonAdGroupId,
                t.action.searchTerm ?? "",
              );
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
        logger.error(
          { err: error, changeSetId: set.id },
          "Change set apply failed",
        );
        await changes.transitionChangeSetStatus(
          db,
          set.id,
          ["applying"],
          "failed",
        );
        throw new ApiError(
          502,
          "AMAZON_APPLY_FAILED",
          "Applying the change set failed; no further Amazon calls were made",
        );
      }
      throw error;
    }
  }

  const service: ChangeService = {
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
        const actionType = WRITABLE_TYPES[rec.type];
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
        actionType: WRITABLE_TYPES[rec.type]!,
        campaignId: rec.campaignId,
        adGroupId: rec.adGroupId,
        targetId: rec.type === "wasteful_search_term" ? null : rec.targetId,
        searchTerm: rec.searchTerm,
        beforeValue: rec.currentValue,
        afterValue:
          WRITABLE_TYPES[rec.type] === "update_bid" ? rec.proposedValue : null,
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
      if (
        original.actionType !== "update_bid" ||
        original.beforeValue === null
      ) {
        throw conflict(
          "NOT_ROLLBACKABLE",
          "Only bid changes can be rolled back in the MVP (negative keywords have no delete path)",
        );
      }

      // Compensating action: swap before/after, linked via rollback_of_id.
      const spec = {
        recommendationId: null,
        actionType: "update_bid" as const,
        campaignId: original.campaignId,
        adGroupId: original.adGroupId,
        targetId: original.targetId,
        searchTerm: null,
        beforeValue: original.afterValue,
        afterValue: original.beforeValue,
        rollbackOfId: original.id,
      };
      const setFingerprint = buildChangeSetFingerprint({
        profileId: original.profilePk,
        creatorUserId: auth.userId,
        actions: [spec],
      });
      const created = await changes.createChangeSet(pool, {
        profileId: original.profilePk,
        creatorUserId: auth.userId,
        fingerprint: setFingerprint,
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
