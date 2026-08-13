import type { CampaignBidControls } from "@amazon-king/amazon-ads";
import { describe, expect, it } from "vitest";
import { buildMaxCpcActionDrafts, SAFE_CAMPAIGN_BIDDING } from "./max-cpc.js";

function controls(): CampaignBidControls {
  return {
    profileId: "profile-pk-1",
    retrievedAt: "2026-08-13T08:00:00.000Z",
    campaign: {
      campaignId: "campaign-1",
      name: "Book launch",
      state: "ENABLED",
      dailyBudget: 10,
      startDate: null,
      endDate: null,
      targetingType: "MANUAL",
      dynamicBidding: {
        strategy: "AUTO_FOR_SALES",
        placements: [{ name: "PLACEMENT_TOP", percentage: 50 }],
        audiences: [],
      },
      raw: {},
    },
    adGroups: [
      {
        adGroupId: "group-high",
        campaignId: "campaign-1",
        name: "High group",
        state: "ENABLED",
        defaultBid: 1.2,
        raw: {},
      },
      {
        adGroupId: "group-low",
        campaignId: "campaign-1",
        name: "Low group",
        state: "ENABLED",
        defaultBid: 0.4,
        raw: {},
      },
    ],
    keywords: [
      {
        keywordId: "keyword-high",
        campaignId: "campaign-1",
        adGroupId: "group-high",
        keywordText: "tractor book",
        matchType: "EXACT",
        state: "ENABLED",
        bid: 0.9,
        raw: {},
      },
      {
        keywordId: "keyword-low",
        campaignId: "campaign-1",
        adGroupId: "group-low",
        keywordText: "farm book",
        matchType: "EXACT",
        state: "ENABLED",
        bid: 0.3,
        raw: {},
      },
    ],
    targets: [
      {
        targetId: "target-high",
        campaignId: "campaign-1",
        adGroupId: "group-high",
        state: "ENABLED",
        bid: 1.1,
        expressionType: "MANUAL",
        raw: {},
      },
    ],
    optimizationRules: [
      {
        optimizationRuleId: "rule-1",
        name: "Weekend boost",
        ruleCategory: "BID",
        ruleSubCategory: "SCHEDULE",
        status: "ENABLED",
        raw: {
          optimizationRuleId: "rule-1",
          name: "Weekend boost",
          ruleCategory: "BID",
          ruleSubCategory: "SCHEDULE",
          status: "ENABLED",
        },
      },
    ],
  };
}

describe("Max CPC action planning", () => {
  it("covers every bid layer without raising values already below the cap", () => {
    const actions = buildMaxCpcActionDrafts({
      live: controls(),
      campaignPk: "campaign-pk-1",
      campaignName: "Book launch",
      maxCpc: 0.75,
    });

    expect(actions.map((action) => action.actionType)).toEqual([
      "update_ad_group_default_bid",
      "update_bid",
      "update_bid",
      "update_campaign_bidding",
      "update_optimization_rule",
    ]);
    expect(actions.map((action) => action.amazonEntityId)).not.toContain(
      "group-low",
    );
    expect(actions.map((action) => action.amazonEntityId)).not.toContain(
      "keyword-low",
    );
    expect(
      actions
        .filter((action) => action.afterValue !== null)
        .every((action) => Number(action.afterValue) <= 0.75),
    ).toBe(true);
    expect(
      actions.find((action) => action.actionType === "update_campaign_bidding")
        ?.afterState,
    ).toEqual(SAFE_CAMPAIGN_BIDDING);
    expect(
      actions.find((action) => action.actionType === "update_optimization_rule")
        ?.afterState,
    ).toMatchObject({ status: "DISABLED" });
  });

  it("creates no Amazon actions when all layers already honor the ceiling", () => {
    const live = controls();
    live.campaign.dynamicBidding = SAFE_CAMPAIGN_BIDDING;
    live.adGroups.forEach((item) => (item.defaultBid = 0.5));
    live.keywords.forEach((item) => (item.bid = 0.5));
    live.targets.forEach((item) => (item.bid = 0.5));
    live.optimizationRules[0]!.status = "DISABLED";

    expect(
      buildMaxCpcActionDrafts({
        live,
        campaignPk: "campaign-pk-1",
        campaignName: "Book launch",
        maxCpc: 0.75,
      }),
    ).toEqual([]);
  });
});
