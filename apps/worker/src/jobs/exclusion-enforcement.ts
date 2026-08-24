import {
  blockedCampaignIds,
  keywordSpecsFromNegativeTargets,
  normalizeTerm,
} from "@amazon-king/optimizer";
import type { Logger } from "pino";
import type { JobDeps } from "./types.js";
import type { DailyFact, ProfileRecord, StructureData } from "../store.js";

/**
 * Search-term exclusion enforcement (migration 0018). The owner excludes a
 * term once; this pass keeps the exclusion effective for campaigns that start
 * serving it afterwards — created via the in-app wizard or directly on Amazon
 * (they appear here after the structure sync that precedes the recommendation
 * run). A campaign is only drafted for when the freshly loaded search-term
 * facts show it actually served the term; campaigns that never ran the term
 * get nothing. Every gap becomes an approval-gated draft change set through
 * the same shared drafting core the API's exclusion action uses; nothing is
 * ever written to Amazon silently.
 */

export interface ExclusionEnforcementSummary {
  /** Newly drafted per-profile change sets (one per uncovered term). */
  draftedSets: number;
  /** Campaigns covered by those drafts. */
  draftedCampaigns: number;
  /** Campaign+term pairs skipped because an open draft already covers them. */
  skippedOpenDrafts: number;
}

export async function enforceSearchTermExclusions(
  deps: JobDeps,
  input: {
    profile: ProfileRecord;
    structure: StructureData;
    /** Freshly loaded search-term facts (serving-ad-group evidence). */
    searchTermFacts: readonly DailyFact[];
    /** Normalized excluded terms from search_term_exclusions. */
    excludedTerms: readonly string[];
    logger: Logger;
  },
): Promise<ExclusionEnforcementSummary> {
  const { profile, structure, excludedTerms, logger } = input;
  const summary: ExclusionEnforcementSummary = {
    draftedSets: 0,
    draftedCampaigns: 0,
    skippedOpenDrafts: 0,
  };
  if (excludedTerms.length === 0) return summary;

  const ownerUserId = await deps.store.getWorkspaceOwnerUserId(
    profile.workspaceId,
  );
  if (!ownerUserId) {
    logger.warn(
      { profileId: profile.id },
      "Skipping exclusion enforcement: no workspace owner on record",
    );
    return summary;
  }

  const enabledCampaigns = structure.campaigns.filter(
    (campaign) => campaign.state.trim().toLowerCase() === "enabled",
  );
  if (enabledCampaigns.length === 0) return summary;

  const allNegatives = [
    ...structure.negativeKeywords,
    ...keywordSpecsFromNegativeTargets(structure.negativeTargets),
  ];
  const campaignByAmazonId = new Map(
    structure.campaigns.map((campaign) => [
      campaign.amazonCampaignId,
      campaign,
    ]),
  );
  const targetByAmazonId = new Map(
    structure.targets.map((target) => [target.amazonTargetId, target]),
  );

  for (const term of excludedTerms) {
    // Campaigns that actually served the term, plus their serving ad groups,
    // from the same facts the wasteful-term evaluation reads. A campaign is
    // only blocked when every ad group that served the term negatives it (or
    // a campaign-level negative matches); a campaign that never served the
    // term is not a candidate at all.
    const servedCampaignIds = new Set<string>();
    const servingAdGroups = new Map<string, Set<string>>();
    for (const fact of input.searchTermFacts) {
      if (fact.subKey === null) continue;
      if (normalizeTerm(fact.subKey) !== normalizeTerm(term)) continue;
      const campaign = campaignByAmazonId.get(fact.campaignAmazonId);
      if (!campaign) continue;
      servedCampaignIds.add(campaign.id);
      const adGroupId = targetByAmazonId.get(fact.entityKey)?.adGroupId;
      if (!adGroupId) continue;
      const set = servingAdGroups.get(campaign.id) ?? new Set<string>();
      set.add(adGroupId);
      servingAdGroups.set(campaign.id, set);
    }
    if (servedCampaignIds.size === 0) continue;
    const blocked = blockedCampaignIds(term, allNegatives, servingAdGroups);

    const uncovered: { id: string; name: string }[] = [];
    for (const campaign of enabledCampaigns) {
      if (!servedCampaignIds.has(campaign.id)) continue;
      if (blocked.has(campaign.id)) continue;
      // An open (draft/previewed/applying) exclusion set covering this
      // campaign+term makes a repeat draft pointless; the change-set
      // fingerprint is the backstop for terminal states.
      if (
        await deps.store.openExclusionSetCoversCampaign(
          profile.id,
          campaign.id,
          term,
        )
      ) {
        summary.skippedOpenDrafts += 1;
        continue;
      }
      uncovered.push({ id: campaign.id, name: campaign.name });
    }
    if (uncovered.length === 0) continue;

    const drafted = await deps.store.draftExclusionChangeSet({
      profileId: profile.id,
      creatorUserId: ownerUserId,
      searchTerm: term,
      campaigns: uncovered,
    });
    if (drafted.created) {
      summary.draftedSets += 1;
      summary.draftedCampaigns += uncovered.length;
    }
  }
  return summary;
}
