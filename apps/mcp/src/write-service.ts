import type { Pool } from "@amazon-king/database";
import {
  setCampaignMaxCpc,
  setCampaignPlacementMultiplier,
} from "./write/bidding.js";
import {
  addKeywordsToCampaign,
  updateCampaignState,
} from "./write/campaigns.js";
import {
  createCampaignNegativesChangeSet,
  createSearchTermExclusion,
} from "./write/negatives.js";
import {
  createRecommendationChangeSet,
  rejectRecommendation,
} from "./write/recommendations.js";
import type { McpWriteService } from "./write/types.js";

export * from "./write/types.js";

/**
 * Creates the MCP guarded write & drafting service.
 * External AI agents use this service to stage immutable draft change sets
 * into Change Center and perform local mutations (dismissals, exclusions).
 *
 * It NEVER contacts the Amazon Ads API directly; applying to Amazon always
 * requires human owner review and execution via the dashboard.
 */
export function createMcpWriteService(pool: Pool): McpWriteService {
  return {
    createRecommendationChangeSet(workspaceId, recommendationIds) {
      return createRecommendationChangeSet(
        pool,
        workspaceId,
        recommendationIds,
      );
    },

    createCampaignNegativesChangeSet(workspaceId, campaignId, searchTerms) {
      return createCampaignNegativesChangeSet(
        pool,
        workspaceId,
        campaignId,
        searchTerms,
      );
    },

    createSearchTermExclusion(workspaceId, searchTerm) {
      return createSearchTermExclusion(pool, workspaceId, searchTerm);
    },

    setCampaignMaxCpc(workspaceId, campaignId, maxCpc) {
      return setCampaignMaxCpc(pool, workspaceId, campaignId, maxCpc);
    },

    updateCampaignState(workspaceId, campaignId, state) {
      return updateCampaignState(pool, workspaceId, campaignId, state);
    },

    addKeywordsToCampaign(workspaceId, campaignId, keywords, adGroupId) {
      return addKeywordsToCampaign(
        pool,
        workspaceId,
        campaignId,
        keywords,
        adGroupId,
      );
    },

    setCampaignPlacementMultiplier(workspaceId, campaignId, placements) {
      return setCampaignPlacementMultiplier(
        pool,
        workspaceId,
        campaignId,
        placements,
      );
    },

    rejectRecommendation(workspaceId, recommendationId, reason) {
      return rejectRecommendation(pool, workspaceId, recommendationId, reason);
    },
  };
}
