/**
 * Domain types and models for the MCP guarded write & drafting service.
 */

export * from "./enums.js";

export interface KeywordInput {
  keywordText: string;
  matchType?: "EXACT" | "PHRASE" | "BROAD";
  bid?: string;
}

export interface PlacementMultiplierInput {
  topOfSearchPercentage?: number;
  productPagePercentage?: number;
  restOfSearchPercentage?: number;
}

export interface RecommendationChangeSetResult {
  changeSets: unknown[];
  requestedCount: number;
  validCount: number;
  droppedIds: string[];
}

export interface SearchTermExclusionResult {
  exclusionAdded: boolean;
  searchTerm: string;
  changeSets: unknown[];
}

export interface MaxCpcResult {
  changeSetId: string;
  campaignId: string;
  amazonCampaignId: string;
  campaignName: string;
  maxCpc: string;
  actionsCount: number;
  status: string;
}

export interface RejectRecommendationResult {
  rejected: boolean;
  recommendation: unknown | null;
  reason: string | null;
}

/** Row shape returned by campaign lookups. */
export interface ResolvedCampaign {
  id: string;
  profile_id: string;
  amazon_campaign_id: string;
  name: string;
  state: string;
  raw_json?: {
    dynamicBidding?: {
      strategy?: string;
      placements?: Array<{ name: string; percentage: number }>;
      audiences?: unknown[];
    };
  };
}

/** Placement entry for Amazon dynamic bidding. */
export interface PlacementEntry {
  name: string;
  percentage: number;
}

/**
 * Surface of operations external AI agents can execute via MCP.
 * Every operation commits to the database Change Center; never to Amazon directly.
 */
export interface McpWriteService {
  createRecommendationChangeSet(
    workspaceId: string,
    recommendationIds: string[],
  ): Promise<unknown>;
  createCampaignNegativesChangeSet(
    workspaceId: string,
    campaignId: string,
    searchTerms: string[],
  ): Promise<unknown>;
  createSearchTermExclusion(
    workspaceId: string,
    searchTerm: string,
  ): Promise<unknown>;
  setCampaignMaxCpc(
    workspaceId: string,
    campaignId: string,
    maxCpc: string,
  ): Promise<unknown>;
  updateCampaignState(
    workspaceId: string,
    campaignId: string,
    state: "enabled" | "paused",
  ): Promise<unknown>;
  addKeywordsToCampaign(
    workspaceId: string,
    campaignId: string,
    keywords: KeywordInput[],
    adGroupId?: string,
  ): Promise<unknown>;
  setCampaignPlacementMultiplier(
    workspaceId: string,
    campaignId: string,
    placements: PlacementMultiplierInput,
  ): Promise<unknown>;
  rejectRecommendation(
    workspaceId: string,
    recommendationId: string,
    reason?: string,
  ): Promise<unknown>;
}
