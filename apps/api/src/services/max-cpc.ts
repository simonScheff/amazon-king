import type {
  CampaignBidControls,
  CampaignDynamicBidding,
} from "@amazon-king/amazon-ads";
import type { changes } from "@amazon-king/database";

export const SAFE_CAMPAIGN_BIDDING: CampaignDynamicBidding = {
  strategy: "LEGACY_FOR_SALES",
  placements: [],
  audiences: [],
};

export function canonicalBid(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

export function isActiveOptimizationRule(status: string): boolean {
  return !["DISABLED", "PAUSED", "ARCHIVED"].includes(status.toUpperCase());
}

function sameState(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  };
  return stable(left) === stable(right);
}

export type MaxCpcActionDraft = Omit<changes.ChangeActionInsert, "fingerprint">;

/** Build a fail-closed plan: only reductions plus removal of every known multiplier. */
export function buildMaxCpcActionDrafts(input: {
  live: CampaignBidControls;
  campaignPk: string;
  campaignName: string;
  maxCpc: number;
}): MaxCpcActionDraft[] {
  const { live, campaignPk, campaignName, maxCpc } = input;
  const cap = canonicalBid(maxCpc);
  const actions: MaxCpcActionDraft[] = [];
  const base = {
    recommendationId: null,
    campaignId: campaignPk,
    adGroupId: null,
    targetId: null,
    searchTerm: null,
  };

  for (const adGroup of live.adGroups) {
    if (adGroup.defaultBid === null || adGroup.defaultBid <= maxCpc) continue;
    actions.push({
      ...base,
      actionType: "update_ad_group_default_bid",
      amazonEntityId: adGroup.adGroupId,
      entityName: adGroup.name,
      beforeValue: canonicalBid(adGroup.defaultBid),
      afterValue: cap,
    });
  }
  for (const keyword of live.keywords) {
    if (keyword.bid === null || keyword.bid <= maxCpc) continue;
    actions.push({
      ...base,
      actionType: "update_bid",
      amazonEntityId: keyword.keywordId,
      entityName: keyword.keywordText,
      beforeValue: canonicalBid(keyword.bid),
      afterValue: cap,
      beforeState: { entityType: "keyword" },
      afterState: { entityType: "keyword" },
    });
  }
  for (const target of live.targets) {
    if (target.bid === null || target.bid <= maxCpc) continue;
    actions.push({
      ...base,
      actionType: "update_bid",
      amazonEntityId: target.targetId,
      entityName: `Product target ${target.targetId}`,
      beforeValue: canonicalBid(target.bid),
      afterValue: cap,
      beforeState: { entityType: "target" },
      afterState: { entityType: "target" },
    });
  }
  if (!sameState(live.campaign.dynamicBidding, SAFE_CAMPAIGN_BIDDING)) {
    actions.push({
      ...base,
      actionType: "update_campaign_bidding",
      amazonEntityId: live.campaign.campaignId,
      entityName: campaignName,
      beforeValue: null,
      afterValue: null,
      beforeState: live.campaign.dynamicBidding,
      afterState: SAFE_CAMPAIGN_BIDDING,
    });
  }
  for (const rule of live.optimizationRules.filter((item) =>
    isActiveOptimizationRule(item.status),
  )) {
    actions.push({
      ...base,
      actionType: "update_optimization_rule",
      amazonEntityId: rule.optimizationRuleId,
      entityName: rule.name,
      beforeValue: null,
      afterValue: null,
      beforeState: rule.raw,
      afterState: { ...rule.raw, status: "DISABLED" },
    });
  }
  return actions;
}
