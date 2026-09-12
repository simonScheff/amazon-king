import { type Pool, changes } from "@amazon-king/database";
import {
  createFingerprintedChangeSet,
  getOwnerUserId,
  recordAudit,
  requireCampaign,
  resolveAdGroupId,
} from "./common.js";
import {
  AuditEvent,
  CampaignState,
  ChangeActionType,
  ChangeSetKind,
  KeywordMatchType,
} from "./enums.js";
import type { KeywordInput } from "./types.js";

/**
 * Drafts a state change (e.g. enable/pause) for a campaign into Change Center.
 */
export async function updateCampaignState(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  state: "enabled" | "paused",
): Promise<unknown> {
  const campaign = await requireCampaign(pool, workspaceId, campaignId);
  const creatorUserId = await getOwnerUserId(pool, workspaceId);
  const targetState = state.toUpperCase();

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.CampaignUpdate,
    metadata: {
      campaignId: campaign.id,
      amazonCampaignId: campaign.amazon_campaign_id,
      campaignName: campaign.name,
      state: targetState,
    },
    actions: [
      {
        actionType: ChangeActionType.UpdateCampaignState,
        campaignId: campaign.id,
        amazonEntityId: campaign.amazon_campaign_id,
        entityName: campaign.name,
        beforeState: { state: campaign.state.toLowerCase() },
        afterState: { state: targetState.toLowerCase() },
        fingerprint: "",
      },
    ],
    extraFingerprintSeed: [
      {
        kind: ChangeSetKind.CampaignUpdate,
        campaignId: campaign.id,
        targetState,
      },
    ],
  });

  await recordAudit(pool, {
    workspaceId,
    actorUserId: creatorUserId,
    event: AuditEvent.CampaignUpdateCreate,
    entityId: created.changeSet.id,
    details: {
      campaignId: campaign.amazon_campaign_id,
      state: targetState,
      actionCount: 1,
      replayed: !created.created,
    },
  });

  return created;
}

/**
 * Drafts new keywords for an existing campaign into Change Center.
 */
export async function addKeywordsToCampaign(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  keywordsList: KeywordInput[],
  adGroupId?: string,
): Promise<unknown> {
  if (keywordsList.length === 0) {
    throw new Error("No keywords provided");
  }
  const campaign = await requireCampaign(pool, workspaceId, campaignId);
  const resolvedAdGroupId = await resolveAdGroupId(
    pool,
    campaign.id,
    adGroupId,
  );
  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const actions: changes.ChangeActionInsert[] = keywordsList.map((kw) => {
    const keywordText = kw.keywordText.trim();
    const matchType = (
      kw.matchType ?? KeywordMatchType.Exact
    ).toUpperCase() as KeywordMatchType;
    const bid = kw.bid ?? "0.35";
    return {
      recommendationId: null,
      actionType: ChangeActionType.CreateKeyword,
      campaignId: campaign.id,
      adGroupId: resolvedAdGroupId,
      targetId: null,
      searchTerm: keywordText,
      beforeValue: null,
      afterValue: bid,
      amazonEntityId: null,
      entityName: campaign.name,
      beforeState: null,
      afterState: {
        keywordText,
        matchType,
        bid,
        state: CampaignState.Enabled,
      },
      fingerprint: "",
    };
  });

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.CampaignUpdate,
    metadata: {
      strategy: "add_keywords",
      keywordCount: actions.length,
      campaignId: campaign.id,
      campaignName: campaign.name,
    },
    actions,
    extraFingerprintSeed: [{ kind: "add_keywords", campaignId: campaign.id }],
  });

  await recordAudit(pool, {
    workspaceId,
    actorUserId: creatorUserId,
    event: AuditEvent.CampaignUpdateCreate,
    entityId: created.changeSet.id,
    details: {
      campaignId: campaign.amazon_campaign_id,
      strategy: "add_keywords",
      keywordCount: actions.length,
      replayed: !created.created,
    },
  });

  return created;
}
