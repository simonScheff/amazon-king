import {
  recommendationChangeActionType,
  type ChangeActionType,
  type Recommendation,
  type RecommendationType,
} from "@amazon-king/contracts";

interface RecommendationActionDetails {
  actionable: boolean;
  label: "Draft change" | "Review only";
  title: string;
  summary: string;
  approvalEffect: string;
  nextStep: string;
  exclusions: string[];
  currentLabel?: string;
  proposedLabel?: string;
}

const advisoryNextSteps: Record<RecommendationType, string> = {
  wasteful_search_term: "",
  expensive_target: "",
  profitable_target: "",
  search_term_harvest:
    "Choose a destination manual campaign, ad group, match type, and starting bid before making this change in Amazon Ads.",
  budget_constrained_winner:
    "Review the campaign economics and decide whether its daily budget should change.",
  high_ctr_poor_conversion:
    "Review the book listing, cover, price, subtitle, and audience fit; the Ads API cannot change the KDP listing.",
  low_impressions:
    "Review relevance, indexing, targeting, and the current bid before deciding on a change.",
  placement_opportunity:
    "Review performance by placement and choose a placement adjustment manually if the evidence is convincing.",
  cannibalization_conflict:
    "Compare the overlapping campaigns and decide whether to consolidate the term or keep separate campaign intent, such as discovery versus exact targeting.",
};

export function getRecommendationActionDetails(
  recommendation: Recommendation,
): RecommendationActionDetails {
  // The shared map is a subset of ChangeActionType; widen so presentation
  // copy below can also cover action types no recommendation maps to yet
  // (currently `add_negative_target`).
  const actionType: ChangeActionType | null =
    recommendationChangeActionType[recommendation.type];

  if (actionType === "update_bid") {
    return {
      actionable: true,
      label: "Draft change",
      title: "Update one target bid",
      summary:
        `Target ${recommendation.targetId ?? "—"}: change the bid from ` +
        `${recommendation.currentValue ?? "—"} to ${recommendation.proposedValue ?? "—"}.`,
      approvalEffect:
        "Approval creates an immutable draft change set for review. It does not contact Amazon or change the live bid.",
      nextStep:
        "In Change center, preview the draft and separately choose “Apply to Amazon.” The app will first re-read the target and re-check guardrails.",
      exclusions: [
        "No campaign will be created, paused, or closed.",
        "No other target or bid will change.",
      ],
      currentLabel: "Current bid",
      proposedLabel: "Proposed bid",
    };
  }

  if (actionType === "add_negative_exact") {
    return {
      actionable: true,
      label: "Draft change",
      title: "Add one negative exact search term",
      summary:
        `Add “${recommendation.searchTerm ?? "—"}” as a negative exact ` +
        `in campaign ${recommendation.campaignId ?? "—"}.`,
      approvalEffect:
        "Approval creates an immutable draft change set for review. It does not contact Amazon or block the term yet.",
      nextStep:
        "In Change center, preview the draft and separately choose “Apply to Amazon.” The app will first re-read the campaign and re-check guardrails.",
      exclusions: [
        "No campaign will be created, paused, or closed.",
        "No keyword, target, or bid will be changed.",
      ],
    };
  }

  if (actionType === "add_negative_target") {
    return {
      actionable: true,
      label: "Draft change",
      title: "Add one negative ASIN target",
      summary:
        `Add “${recommendation.searchTerm ?? "—"}” as a negative ASIN target ` +
        `in campaign ${recommendation.campaignId ?? "—"}.`,
      approvalEffect:
        "Approval creates an immutable draft change set for review. It does not contact Amazon or block the ASIN yet.",
      nextStep:
        "In Change center, preview the draft and separately choose “Apply to Amazon.” The app will first re-read the campaign and re-check guardrails.",
      exclusions: [
        "No campaign will be created, paused, or closed.",
        "No keyword, target, or bid will be changed.",
      ],
    };
  }

  const isCannibalization = recommendation.type === "cannibalization_conflict";
  return {
    actionable: false,
    label: "Review only",
    title: "No automatic Amazon Ads action",
    summary: isCannibalization
      ? "This finding identifies overlapping campaigns, but it does not choose a winner or propose a campaign-level change."
      : "This finding does not contain a concrete Amazon Ads operation that the app can safely apply.",
    approvalEffect:
      "There is no approval step for this finding, and it cannot be added to a change set.",
    nextStep: advisoryNextSteps[recommendation.type],
    exclusions: isCannibalization
      ? [
          "No campaign will be created.",
          "No campaign will be selected, paused, or closed.",
          "No bid, budget, keyword, or target will change.",
          "Nothing will be sent to Amazon from this finding.",
        ]
      : [
          "Nothing will be sent to Amazon from this finding.",
          "No campaign, bid, budget, keyword, or target will change.",
        ],
  };
}
