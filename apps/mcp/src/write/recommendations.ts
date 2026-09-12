import { recommendationChangeActionType } from "@amazon-king/contracts";
import {
  changeDrafts,
  changes,
  recommendations,
  structure,
  type Pool,
} from "@amazon-king/database";
import {
  createFingerprintedChangeSet,
  getOwnerUserId,
  recordAudit,
} from "./common.js";
import {
  AuditEvent,
  ChangeActionType,
  ChangeSetKind,
  RecommendationState,
  RecommendationType,
} from "./enums.js";
import type {
  RecommendationChangeSetResult,
  RejectRecommendationResult,
} from "./types.js";

export const REJECTION_SUPPRESSION_DAYS = 60;

/**
 * Stages pending recommendations into Change Center change sets and transitions them to approved.
 */
export async function createRecommendationChangeSet(
  pool: Pool,
  workspaceId: string,
  recommendationIds: string[],
): Promise<RecommendationChangeSetResult> {
  const rawIds = recommendationIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (rawIds.length === 0) {
    throw new Error("No recommendation ids provided");
  }
  const ids = [...new Set(rawIds)];
  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const recs = await pool.query<{
    id: string;
    profile_id: string;
    type: string;
    state: string;
    expires_at: string;
    campaign_id: string | null;
    ad_group_id: string | null;
    target_id: string | null;
    search_term: string | null;
    current_value: string | null;
    proposed_value: string | null;
    write_enabled: boolean;
  }>(
    `select r.*, p.write_enabled
     from recommendations r
     join amazon_profiles p on p.id = r.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1 and r.id::text = ANY($2::text[])`,
    [workspaceId, ids],
  );

  const now = new Date();
  const validRecs = recs.rows.filter((r) => {
    if (!r.write_enabled) return false;
    if (
      r.state !== RecommendationState.Pending &&
      r.state !== RecommendationState.Approved
    )
      return false;
    if (new Date(r.expires_at) <= now) return false;
    const actionType =
      recommendationChangeActionType[
        r.type as keyof typeof recommendationChangeActionType
      ];
    if (!actionType) return false;
    if (
      r.type === RecommendationType.WastefulSearchTerm &&
      (!r.campaign_id || !r.search_term)
    )
      return false;
    if (
      (r.type === RecommendationType.ExpensiveTarget ||
        r.type === RecommendationType.ProfitableTarget) &&
      (!r.target_id || !r.proposed_value)
    )
      return false;
    return true;
  });

  if (validRecs.length === 0) {
    throw new Error(
      recs.rows.some((r) => !r.write_enabled)
        ? "Profile is read-only; enable writes before creating change sets"
        : "No valid recommendations found for workspace",
    );
  }

  // Group by profile — each profile gets its own change set
  const byProfile = new Map<string, typeof validRecs>();
  for (const rec of validRecs) {
    const list = byProfile.get(rec.profile_id) ?? [];
    list.push(rec);
    byProfile.set(rec.profile_id, list);
  }

  const results = [];
  const allDraftedRecIds = new Set<string>();

  for (const [profileId, profileRecs] of byProfile.entries()) {
    const actionInserts: changes.ChangeActionInsert[] = [];
    const appliedRecIds = new Set<string>();

    for (const rec of profileRecs) {
      if (
        rec.type === RecommendationType.WastefulSearchTerm &&
        rec.campaign_id &&
        rec.search_term
      ) {
        const campaign = await structure.getCampaign(pool, rec.campaign_id);
        if (campaign) {
          const spec = changeDrafts.campaignNegativeSpec(
            rec.id,
            rec.search_term,
            { id: campaign.id, name: campaign.name },
          );
          actionInserts.push({
            ...spec,
            fingerprint: "",
          });
          appliedRecIds.add(rec.id);
        }
      } else if (
        (rec.type === RecommendationType.ExpensiveTarget ||
          rec.type === RecommendationType.ProfitableTarget) &&
        rec.proposed_value
      ) {
        actionInserts.push({
          recommendationId: rec.id,
          actionType: ChangeActionType.UpdateBid,
          campaignId: rec.campaign_id,
          adGroupId: rec.ad_group_id,
          targetId: rec.target_id,
          searchTerm: null,
          beforeValue: rec.current_value,
          afterValue: rec.proposed_value,
          fingerprint: "",
        });
        appliedRecIds.add(rec.id);
      }
    }

    if (actionInserts.length > 0) {
      const created = await createFingerprintedChangeSet(pool, {
        profileId,
        creatorUserId,
        kind: ChangeSetKind.Recommendation,
        metadata: {
          source: "mcp_agent",
          recommendationCount: appliedRecIds.size,
        },
        actions: actionInserts,
      });

      // Transition only recommendations that actually contributed an action to approved
      for (const recId of appliedRecIds) {
        await recommendations.transitionRecommendationState(
          pool,
          recId,
          RecommendationState.Pending,
          RecommendationState.Approved,
        );
        allDraftedRecIds.add(recId);
      }

      await recordAudit(pool, {
        workspaceId,
        actorUserId: creatorUserId,
        event: AuditEvent.ChangeSetCreate,
        entityId: created.changeSet.id,
        details: {
          actionCount: created.actions.length,
          replayed: !created.created,
          source: "mcp_agent",
        },
      });

      results.push(created);
    }
  }

  const droppedIds = ids.filter((id) => !allDraftedRecIds.has(id));

  return {
    changeSets: results,
    requestedCount: ids.length,
    validCount: allDraftedRecIds.size,
    droppedIds,
  };
}

/**
 * Dismisses or rejects an advisory recommendation and records a 60-day dismissal suppression row.
 */
export async function rejectRecommendation(
  pool: Pool,
  workspaceId: string,
  recommendationId: string,
  reason?: string,
): Promise<RejectRecommendationResult> {
  const rec = await pool.query<{ id: string; state: string }>(
    `select r.id, r.state
     from recommendations r
     join amazon_profiles p on p.id = r.profile_id
     join amazon_connections conn on conn.id = p.connection_id
     where conn.workspace_id = $1 and r.id::text = $2`,
    [workspaceId, recommendationId],
  );
  if (!rec.rows[0]) {
    throw new Error(`Recommendation '${recommendationId}' not found`);
  }
  if (
    rec.rows[0].state !== RecommendationState.Pending &&
    rec.rows[0].state !== RecommendationState.Approved
  ) {
    throw new Error(
      `Recommendation '${recommendationId}' in state '${rec.rows[0].state}' cannot be rejected`,
    );
  }

  const updated =
    (await recommendations.transitionRecommendationState(
      pool,
      recommendationId,
      RecommendationState.Approved,
      RecommendationState.Rejected,
    )) ??
    (await recommendations.transitionRecommendationState(
      pool,
      recommendationId,
      RecommendationState.Pending,
      RecommendationState.Rejected,
    ));

  if (updated) {
    const suppressionDays = REJECTION_SUPPRESSION_DAYS;
    await recommendations.upsertRecommendationDismissal(pool, {
      profileId: updated.profileId,
      type: updated.type,
      campaignId: updated.campaignId,
      adGroupId: updated.adGroupId,
      targetId: updated.targetId,
      searchTerm: updated.searchTerm,
      recommendationId: updated.id,
      dismissedUntil: new Date(
        Date.now() + suppressionDays * 86_400_000,
      ).toISOString(),
    });

    const creatorUserId = await getOwnerUserId(pool, workspaceId);
    await recordAudit(pool, {
      workspaceId,
      actorUserId: creatorUserId,
      event: AuditEvent.RecommendationReject,
      entityType: "recommendation",
      entityId: updated.id,
      details: { reason: reason ?? null },
    });
  }

  return {
    rejected: updated !== null,
    recommendation: updated,
    reason: reason ?? null,
  };
}
