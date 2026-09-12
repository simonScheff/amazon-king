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
  if (campaign.state.toLowerCase() === state.toLowerCase()) {
    throw new Error(`Campaign '${campaign.name}' is already ${state}`);
  }
  const creatorUserId = await getOwnerUserId(pool, workspaceId);
  const targetState = state.toUpperCase();

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.CampaignUpdate,
    metadata: {
      campaignPk: campaign.id,
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
export const DEFAULT_KEYWORD_BID = "0.35";

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
  if (campaign.targeting_type === "AUTO") {
    throw new Error(
      `Cannot add keywords to campaign '${campaign.name}': AUTO targeting campaigns do not support manual keywords`,
    );
  }
  const resolvedAdGroupId = await resolveAdGroupId(
    pool,
    campaign.id,
    adGroupId,
  );
  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const uniqueKeywords: KeywordInput[] = [];
  const seen = new Set<string>();
  for (const kw of keywordsList) {
    const text = kw.keywordText.trim();
    if (!text) {
      throw new Error("Keyword text cannot be empty");
    }
    const matchType = (
      kw.matchType ?? KeywordMatchType.Exact
    ).toUpperCase() as KeywordMatchType;
    const key = `${text.toLowerCase()}|${matchType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueKeywords.push({ keywordText: text, matchType, bid: kw.bid });
  }

  const actions: changes.ChangeActionInsert[] = uniqueKeywords.map((kw) => {
    const keywordText = kw.keywordText;
    const matchType = (
      kw.matchType ?? KeywordMatchType.Exact
    ).toUpperCase() as KeywordMatchType;
    const bid = kw.bid ?? DEFAULT_KEYWORD_BID;
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
      campaignPk: campaign.id,
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
