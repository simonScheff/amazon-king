import { isAsin } from "@amazon-king/contracts";
import type { Pool } from "./db.js";
import {
  buildChangeActionFingerprint,
  buildChangeSetFingerprint,
} from "./fingerprint.js";
import {
  createChangeSet,
  type ChangeActionInsert,
  type CreatedChangeSet,
} from "./repositories/changes.js";

/**
 * Change-set drafting shared by the API (owner-initiated exclusion) and the
 * worker (exclusion enforcement for future campaigns). It lives in this
 * package because both apps already depend on it for persistence, so neither
 * has to duplicate the spec/fingerprint assembly. Only drafting is shared —
 * the guarded apply path stays in apps/api.
 */

/** Minimal campaign shape a negative spec needs (internal PK + name). */
export interface NegativeDraftCampaign {
  id: string;
  name: string;
}

/**
 * One campaign-level negative spec: block `searchTerm` in `campaign`. ASIN
 * terms (a shopper landed on a product detail page) can only be blocked with
 * a negative product target; text terms use a negative exact keyword.
 */
export function campaignNegativeSpec(
  recommendationId: string | null,
  searchTerm: string,
  campaign: NegativeDraftCampaign,
): Omit<ChangeActionInsert, "fingerprint"> {
  const asinTerm = isAsin(searchTerm);
  return {
    recommendationId,
    actionType: asinTerm ? "add_negative_target" : "add_negative_exact",
    campaignId: campaign.id,
    adGroupId: null,
    targetId: null,
    searchTerm,
    beforeValue: null,
    afterValue: null,
    entityName: campaign.name,
    beforeState: asinTerm
      ? { scope: "campaign", targetType: "ASIN_SAME_AS", present: false }
      : { scope: "campaign", matchType: "NEGATIVE_EXACT", present: false },
    afterState: asinTerm
      ? { scope: "campaign", targetType: "ASIN_SAME_AS", present: true }
      : { scope: "campaign", matchType: "NEGATIVE_EXACT", present: true },
  };
}

/**
 * Draft one per-profile `recommendation` change set blocking `searchTerm` in
 * every given campaign (`metadata.strategy: "search_term_exclusion"`). The
 * API's persistent exclusion action and the worker's enforcement pass both
 * draft through this function so their sets are identical in shape.
 * Fingerprint-idempotent: replaying the same profile + term + campaigns
 * returns the existing set instead of duplicating it.
 */
export async function createSearchTermExclusionSet(
  pool: Pool,
  input: {
    /** Internal amazon_profiles PK. */
    profileId: string;
    creatorUserId: string;
    /** Normalized (trimmed + lowercased) search term. */
    searchTerm: string;
    campaigns: readonly NegativeDraftCampaign[];
  },
): Promise<CreatedChangeSet> {
  const specs = input.campaigns.map((campaign) =>
    campaignNegativeSpec(null, input.searchTerm, campaign),
  );
  const setFingerprint = buildChangeSetFingerprint({
    profileId: input.profileId,
    creatorUserId: input.creatorUserId,
    actions: [
      { kind: "search_term_exclusion", searchTerm: input.searchTerm },
      ...specs,
    ],
  });
  return createChangeSet(pool, {
    profileId: input.profileId,
    creatorUserId: input.creatorUserId,
    fingerprint: setFingerprint,
    kind: "recommendation",
    metadata: {
      strategy: "search_term_exclusion",
      searchTerm: input.searchTerm,
      campaignCount: specs.length,
    },
    actions: specs.map((spec) => ({
      ...spec,
      fingerprint: buildChangeActionFingerprint({
        changeSetId: setFingerprint,
        actionType: spec.actionType,
        targetId: spec.targetId,
        campaignId: spec.campaignId,
        adGroupId: spec.adGroupId,
        searchTerm: spec.searchTerm,
        beforeValue: spec.beforeValue,
        afterValue: spec.afterValue,
        beforeState: spec.beforeState,
        afterState: spec.afterState,
      }),
    })),
  });
}
