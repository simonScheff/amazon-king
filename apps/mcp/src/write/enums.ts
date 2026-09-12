/**
 * Domain enums for MCP guarded write & drafting operations.
 * Eliminates magic strings and provides centralized, typed identifiers.
 */

export enum RecommendationType {
  WastefulSearchTerm = "wasteful_search_term",
  ExpensiveTarget = "expensive_target",
  ProfitableTarget = "profitable_target",
  SearchTermHarvest = "search_term_harvest",
  BudgetConstrainedWinner = "budget_constrained_winner",
  HighCtrPoorConversion = "high_ctr_poor_conversion",
  LowImpressions = "low_impressions",
  PlacementOpportunity = "placement_opportunity",
  CannibalizationConflict = "cannibalization_conflict",
}

export enum RecommendationState {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected",
  Expired = "expired",
  Applied = "applied",
  Protected = "protected",
}

export enum ChangeActionType {
  AddNegativeExact = "add_negative_exact",
  UpdateBid = "update_bid",
  UpdateAdGroupDefaultBid = "update_ad_group_default_bid",
  UpdateCampaignBidding = "update_campaign_bidding",
  UpdateCampaignState = "update_campaign_state",
  CreateKeyword = "create_keyword",
  CreateTarget = "create_target",
  AddNegativeTarget = "add_negative_target",
  RemoveNegativeTarget = "remove_negative_target",
  UpdateCampaignName = "update_campaign_name",
}

export enum ChangeSetKind {
  Recommendation = "recommendation",
  CampaignUpdate = "campaign_update",
  MaxCpc = "max_cpc",
  CampaignCreation = "campaign_creation",
  Rollback = "rollback",
}

export enum CampaignState {
  Enabled = "enabled",
  Paused = "paused",
  Archived = "archived",
}

export enum KeywordMatchType {
  Exact = "EXACT",
  Phrase = "PHRASE",
  Broad = "BROAD",
}

export enum BiddingStrategy {
  LegacyForSales = "LEGACY_FOR_SALES",
  AutoForSales = "AUTO_FOR_SALES",
  Manual = "MANUAL",
  RuleBased = "RULE_BASED",
}

export enum PlacementName {
  PlacementTop = "PLACEMENT_TOP",
  PlacementProductPage = "PLACEMENT_PRODUCT_PAGE",
  PlacementRestOfSearch = "PLACEMENT_REST_OF_SEARCH",
}

export enum AuditEvent {
  ChangeSetCreate = "change_set.create",
  CampaignNegativesCreate = "campaign.negatives.create",
  CampaignUpdateCreate = "campaign.update.create",
  SearchTermExclusionCreate = "search_term.exclusion.create",
  RecommendationReject = "recommendation.reject",
  CampaignMaxCpcCreate = "campaign.max_cpc.create",
}
