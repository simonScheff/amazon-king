import { bidPolicies, changes, type Pool } from "@amazon-king/database";
import {
  createFingerprintedChangeSet,
  getOwnerUserId,
  recordAudit,
  requireCampaign,
} from "./common.js";
import {
  AuditEvent,
  BiddingStrategy,
  ChangeActionType,
  ChangeSetKind,
  PlacementName,
} from "./enums.js";
import type { MaxCpcResult, PlacementMultiplierInput } from "./types.js";

/**
 * Stages a campaign Max CPC change set, only adjusting targets/ad groups exceeding the ceiling,
 * and resetting dynamic bidding to safe legacy bidding if non-legacy strategies or multipliers exist.
 */
export async function setCampaignMaxCpc(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  maxCpc: string,
): Promise<MaxCpcResult> {
  const campaign = await requireCampaign(pool, workspaceId, campaignId);
  const creatorUserId = await getOwnerUserId(pool, workspaceId);
  const maxCpcNum = Number(maxCpc);

  const [targetsRes, adGroupsRes] = await Promise.all([
    pool.query<{
      id: string;
      amazon_target_id: string;
      target_kind: string;
      bid: string;
    }>(
      `select id, amazon_target_id, target_kind, bid::text from targets where campaign_id = $1 and bid is not null`,
      [campaign.id],
    ),
    pool.query<{
      id: string;
      amazon_ad_group_id: string;
      name: string;
      default_bid: string;
    }>(
      `select id, amazon_ad_group_id, name, default_bid::text from ad_groups where campaign_id = $1 and default_bid is not null`,
      [campaign.id],
    ),
  ]);

  const actions: changes.ChangeActionInsert[] = [];

  for (const t of targetsRes.rows) {
    if (Number(t.bid) <= maxCpcNum) continue;
    const entityType = t.target_kind === "keyword" ? "keyword" : "target";
    actions.push({
      recommendationId: null,
      actionType: ChangeActionType.UpdateBid,
      campaignId: campaign.id,
      adGroupId: null,
      targetId: t.id,
      searchTerm: null,
      beforeValue: t.bid,
      afterValue: maxCpc,
      amazonEntityId: t.amazon_target_id,
      entityName: campaign.name,
      beforeState: { entityType, bid: t.bid },
      afterState: { entityType, bid: maxCpc },
      fingerprint: "",
    });
  }

  for (const ag of adGroupsRes.rows) {
    if (Number(ag.default_bid) <= maxCpcNum) continue;
    actions.push({
      recommendationId: null,
      actionType: ChangeActionType.UpdateAdGroupDefaultBid,
      campaignId: campaign.id,
      adGroupId: ag.id,
      targetId: null,
      searchTerm: null,
      beforeValue: ag.default_bid,
      afterValue: maxCpc,
      amazonEntityId: ag.amazon_ad_group_id,
      entityName: ag.name || campaign.name,
      beforeState: { defaultBid: ag.default_bid },
      afterState: { defaultBid: maxCpc },
      fingerprint: "",
    });
  }

  // If dynamic bidding has non-legacy strategy or non-zero multipliers, reset to safe legacy strategy
  const currentDynamicBidding = campaign.raw_json?.dynamicBidding;
  if (currentDynamicBidding) {
    const placements = currentDynamicBidding.placements ?? [];
    const hasMultipliers =
      Array.isArray(placements) &&
      placements.some((p) => (p?.percentage ?? 0) > 0);
    const strategy =
      currentDynamicBidding.strategy ?? BiddingStrategy.LegacyForSales;
    if (strategy !== BiddingStrategy.LegacyForSales || hasMultipliers) {
      const safeBidding = {
        strategy: BiddingStrategy.LegacyForSales,
        placements: [],
        audiences: [],
      };
      actions.push({
        recommendationId: null,
        actionType: ChangeActionType.UpdateCampaignBidding,
        campaignId: campaign.id,
        adGroupId: null,
        targetId: null,
        searchTerm: null,
        beforeValue: null,
        afterValue: null,
        amazonEntityId: campaign.amazon_campaign_id,
        entityName: campaign.name,
        beforeState: currentDynamicBidding,
        afterState: safeBidding,
        fingerprint: "",
      });
    }
  }

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.MaxCpc,
    metadata: {
      campaignId: campaign.id,
      amazonCampaignId: campaign.amazon_campaign_id,
      maxCpc,
    },
    actions,
    extraFingerprintSeed: [
      { kind: ChangeSetKind.MaxCpc, campaignId: campaign.id, maxCpc },
    ],
  });

  const policy = await bidPolicies.upsertPendingCampaignBidPolicy(pool, {
    campaignId: campaign.id,
    maxCpc,
    changeSetId: created.changeSet.id,
  });

  await recordAudit(pool, {
    workspaceId,
    actorUserId: creatorUserId,
    event: AuditEvent.CampaignMaxCpcCreate,
    entityId: created.changeSet.id,
    details: {
      campaignId: campaign.amazon_campaign_id,
      maxCpc,
      actionCount: actions.length,
      replayed: !created.created,
    },
  });

  return {
    changeSetId: created.changeSet.id,
    campaignId: campaign.id,
    amazonCampaignId: campaign.amazon_campaign_id,
    campaignName: campaign.name,
    maxCpc: policy.maxCpc,
    actionsCount: actions.length,
    status: policy.status,
  };
}

/**
 * Stages a placement multiplier change set, preserving current strategy and audiences.
 */
export async function setCampaignPlacementMultiplier(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  placements: PlacementMultiplierInput,
): Promise<unknown> {
  if (
    placements.topOfSearchPercentage === undefined &&
    placements.productPagePercentage === undefined &&
    placements.restOfSearchPercentage === undefined
  ) {
    throw new Error(
      "At least one placement multiplier percentage must be specified",
    );
  }

  const campaign = await requireCampaign(pool, workspaceId, campaignId);
  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const currentDynamicBidding = campaign.raw_json?.dynamicBidding;
  if (!currentDynamicBidding) {
    throw new Error(
      `Campaign '${campaignId}' lacks dynamic bidding snapshot in raw_json; sync campaign first`,
    );
  }

  const strategy =
    currentDynamicBidding.strategy ?? BiddingStrategy.LegacyForSales;
  const audiences = currentDynamicBidding.audiences ?? [];

  const existingPlacements = new Map<string, number>();
  if (Array.isArray(currentDynamicBidding.placements)) {
    for (const p of currentDynamicBidding.placements) {
      if (p && typeof p.name === "string") {
        existingPlacements.set(p.name, p.percentage ?? 0);
      }
    }
  }

  if (placements.topOfSearchPercentage !== undefined) {
    existingPlacements.set(
      PlacementName.PlacementTop,
      placements.topOfSearchPercentage,
    );
  }
  if (placements.productPagePercentage !== undefined) {
    existingPlacements.set(
      PlacementName.PlacementProductPage,
      placements.productPagePercentage,
    );
  }
  if (placements.restOfSearchPercentage !== undefined) {
    existingPlacements.set(
      PlacementName.PlacementRestOfSearch,
      placements.restOfSearchPercentage,
    );
  }

  const placementAdjustments = Array.from(existingPlacements.entries()).map(
    ([name, percentage]) => ({
      name,
      percentage,
    }),
  );

  const dynamicBiddingState = {
    strategy,
    placements: placementAdjustments,
    audiences,
  };

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.CampaignUpdate,
    metadata: {
      strategy: "set_placement_multiplier",
      campaignId: campaign.id,
      campaignName: campaign.name,
      topOfSearchPercentage: placements.topOfSearchPercentage,
      productPagePercentage: placements.productPagePercentage,
      restOfSearchPercentage: placements.restOfSearchPercentage,
    },
    actions: [
      {
        recommendationId: null,
        actionType: ChangeActionType.UpdateCampaignBidding,
        campaignId: campaign.id,
        adGroupId: null,
        targetId: null,
        searchTerm: null,
        beforeValue: null,
        afterValue: null,
        amazonEntityId: campaign.amazon_campaign_id,
        entityName: campaign.name,
        beforeState: currentDynamicBidding,
        afterState: dynamicBiddingState,
        fingerprint: "",
      },
    ],
    extraFingerprintSeed: [
      {
        kind: "set_placement_multiplier",
        campaignId: campaign.id,
        dynamicBiddingState,
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
      strategy: "set_placement_multiplier",
      actionCount: 1,
      replayed: !created.created,
    },
  });

  return created;
}
