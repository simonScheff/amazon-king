import { isAsin } from "@amazon-king/contracts";
import {
  changeDrafts,
  changes,
  dashboard,
  exclusions,
  profiles,
  structure,
  type Pool,
} from "@amazon-king/database";
import {
  createFingerprintedChangeSet,
  getOwnerUserId,
  recordAudit,
  requireCampaign,
} from "./common.js";
import { AuditEvent, CampaignState, ChangeSetKind } from "./enums.js";
import type { SearchTermExclusionResult } from "./types.js";

/**
 * Stages negative exact keywords or product ASIN targets for a specific campaign.
 */
export async function createCampaignNegativesChangeSet(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  searchTerms: string[],
): Promise<unknown> {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of searchTerms) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  if (terms.length === 0) {
    throw new Error("No search terms provided");
  }
  const campaign = await requireCampaign(pool, workspaceId, campaignId);
  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const clicksRes = await pool.query<{ term: string }>(
    `select distinct lower(trim(search_term)) as term
     from search_term_metrics_daily
     where profile_id = $1 and campaign_id = $2 and clicks > 0
       and lower(trim(search_term)) = ANY($3::text[])`,
    [
      campaign.profile_id,
      campaign.amazon_campaign_id,
      terms.map((t) => t.toLowerCase()),
    ],
  );
  const termsWithClicks = new Set(clicksRes.rows.map((r) => r.term));

  const specs: changes.ChangeActionInsert[] = terms.map((term) => ({
    ...changeDrafts.campaignNegativeSpec(null, term, {
      id: campaign.id,
      name: campaign.name,
    }),
    fingerprint: "",
  }));

  const created = await createFingerprintedChangeSet(pool, {
    profileId: campaign.profile_id,
    creatorUserId,
    kind: ChangeSetKind.Recommendation,
    metadata: {
      strategy: "mcp_campaign_negatives",
      campaignId: campaign.id,
      campaignName: campaign.name,
      termCount: terms.length,
      termsWithHistoricalClicks: terms.filter(
        (t) => isAsin(t) || termsWithClicks.has(t.toLowerCase()),
      ),
    },
    actions: specs,
    extraFingerprintSeed: [{ campaignId: campaign.id, searchTerms: terms }],
  });

  await recordAudit(pool, {
    workspaceId,
    actorUserId: creatorUserId,
    event: AuditEvent.CampaignNegativesCreate,
    entityId: created.changeSet.id,
    details: {
      amazonCampaignId: campaign.amazon_campaign_id,
      searchTerms: terms,
      actionCount: created.actions.length,
      replayed: !created.created,
    },
  });

  return created;
}

/**
 * Adds a persistent workspace-wide exclusion and stages negative exact change sets across serving campaigns.
 */
export async function createSearchTermExclusion(
  pool: Pool,
  workspaceId: string,
  searchTerm: string,
): Promise<SearchTermExclusionResult> {
  const normalized = exclusions.normalizeExclusionTerm(searchTerm);
  if (!normalized) {
    throw new Error("Search term cannot be empty");
  }

  const { created, exclusion } = await exclusions.addExclusion(
    pool,
    workspaceId,
    normalized,
  );

  const creatorUserId = await getOwnerUserId(pool, workspaceId);

  const SERVING_LOOKBACK_DAYS = 30;
  const endDate = new Date(new Date().toISOString().slice(0, 10));
  const startDate = new Date(
    endDate.getTime() - (SERVING_LOOKBACK_DAYS - 1) * 86_400_000,
  );

  const serving = await dashboard.listSearchTermServingCampaigns(
    pool,
    workspaceId,
    normalized,
    startDate.toISOString().slice(0, 10),
    endDate.toISOString().slice(0, 10),
  );

  const servingByProfile = new Map<string, Set<string>>();
  for (const row of serving) {
    const set = servingByProfile.get(row.profilePk) ?? new Set<string>();
    set.add(row.campaignPk);
    servingByProfile.set(row.profilePk, set);
  }

  const profileRows = await profiles.listProfilesByWorkspace(pool, workspaceId);

  const changeSets = [];
  let skippedCampaigns = 0;

  for (const profile of profileRows) {
    if (!profile.enabled) continue;
    const served = servingByProfile.get(profile.id);
    if (!served || served.size === 0) continue;

    const [campaignRows, negativeKeywords, negativeTargets] = await Promise.all(
      [
        structure.listCampaignsByProfile(pool, profile.id),
        structure.listNegativeKeywordsByProfile(pool, profile.id),
        structure.listNegativeTargetsByProfile(pool, profile.id),
      ],
    );

    const blocked = new Set<string>();
    for (const nk of negativeKeywords) {
      if (
        nk.keywordText.trim().toLowerCase() === normalized &&
        nk.state.toUpperCase() === "ENABLED"
      ) {
        blocked.add(nk.campaignId);
      }
    }
    for (const nt of negativeTargets) {
      if (
        nt.expressionAsin.trim().toLowerCase() === normalized &&
        nt.state.toUpperCase() === "ENABLED"
      ) {
        blocked.add(nt.campaignId);
      }
    }

    const servedCampaigns = campaignRows.filter((c) => served.has(c.id));
    const candidates = servedCampaigns.filter(
      (c) =>
        c.state.trim().toLowerCase() === CampaignState.Enabled &&
        !blocked.has(c.id),
    );
    skippedCampaigns += servedCampaigns.length - candidates.length;
    if (candidates.length === 0) continue;

    const draftedSet = await changeDrafts.createSearchTermExclusionSet(pool, {
      profileId: profile.id,
      creatorUserId,
      searchTerm: normalized,
      campaigns: candidates,
    });
    changeSets.push(draftedSet);
  }

  await recordAudit(pool, {
    workspaceId,
    actorUserId: creatorUserId,
    event: AuditEvent.SearchTermExclusionCreate,
    entityType: "search_term_exclusion",
    entityId: exclusion.id,
    details: {
      searchTerm: normalized,
      created,
      changeSetCount: changeSets.length,
      skippedCampaigns,
    },
  });

  return { exclusionAdded: created, searchTerm: normalized, changeSets };
}
