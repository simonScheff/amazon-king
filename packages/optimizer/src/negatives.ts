/**
 * Negative keyword matching (docs/plan.md §9). Pure and deterministic: given a
 * shopper search term and the negatives currently synced from Amazon, decide
 * which campaigns can no longer serve that term. Rules use this so a conflict
 * the owner already resolved with a negative keyword or negative ASIN target
 * stops being recommended.
 */

/** One Amazon negative keyword as mirrored locally; `adGroupId` null = campaign level. */
export interface NegativeKeywordSpec {
  campaignId: string;
  adGroupId: string | null;
  keywordText: string;
  /** Amazon match type, e.g. `NEGATIVE_EXACT` / `negativePhrase`. */
  matchType: string;
  state: string;
}

/** One Amazon negative product target as mirrored locally. */
export interface NegativeTargetSpec {
  campaignId: string;
  adGroupId: string | null;
  asin: string;
  state: string;
}

/**
 * Exact negatives synthesized from ASIN_SAME_AS product exclusions so the
 * same blocked-campaign logic covers ASIN shopper terms.
 */
export function keywordSpecsFromNegativeTargets(
  targets: readonly NegativeTargetSpec[],
): NegativeKeywordSpec[] {
  return targets.map((target) => ({
    campaignId: target.campaignId,
    adGroupId: target.adGroupId,
    keywordText: target.asin,
    matchType: "NEGATIVE_EXACT",
    state: target.state,
  }));
}

/** Trim, lowercase, and collapse internal whitespace so terms compare stably. */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Amazon spells match types as `NEGATIVE_EXACT`, `negativeExact`, or plain
 * `exact` depending on the endpoint; reduce them all to `exact` / `phrase`.
 */
function normalizeMatchType(matchType: string): string {
  return matchType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "")
    .replace(/^negative/, "");
}

/** Only enabled negatives block traffic; paused/archived ones do not. */
function isActive(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "enabled" || normalized === "active";
}

/** True when `phrase` appears in `term` as a contiguous run of whole words. */
function containsPhrase(term: string, phrase: string): boolean {
  if (phrase === "") return false;
  const termWords = term.split(" ");
  const phraseWords = phrase.split(" ");
  if (phraseWords.length > termWords.length) return false;
  for (let start = 0; start <= termWords.length - phraseWords.length; start++) {
    if (phraseWords.every((word, i) => termWords[start + i] === word)) {
      return true;
    }
  }
  return false;
}

/**
 * True when `negative` blocks `term`. Exact negatives block only the identical
 * term; phrase negatives block any term containing the phrase in order. Other
 * match types are ignored — Sponsored Products has no negative broad.
 */
export function matchesNegative(
  term: string,
  negative: NegativeKeywordSpec,
): boolean {
  if (!isActive(negative.state)) return false;
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm === "") return false;
  const normalizedKeyword = normalizeText(negative.keywordText);
  switch (normalizeMatchType(negative.matchType)) {
    case "exact":
      return normalizedTerm === normalizedKeyword;
    case "phrase":
      return containsPhrase(normalizedTerm, normalizedKeyword);
    default:
      return false;
  }
}

/**
 * Campaigns that can no longer serve `term`. A campaign is blocked when a
 * campaign-level negative matches, or when every ad group that actually served
 * the term has a matching ad-group-level negative — a negative on one of
 * several serving ad groups leaves the campaign able to spend on the term.
 *
 * `servingAdGroupsByCampaign` maps campaign id to the ad group ids observed in
 * the search-term facts for this term. A campaign with no known serving ad
 * groups can only be blocked at campaign level.
 */
export function blockedCampaignIds(
  term: string,
  negatives: readonly NegativeKeywordSpec[],
  servingAdGroupsByCampaign: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const matching = negatives.filter((negative) =>
    matchesNegative(term, negative),
  );
  const blocked = new Set<string>();
  const blockedAdGroups = new Map<string, Set<string>>();
  for (const negative of matching) {
    if (negative.adGroupId === null) {
      blocked.add(negative.campaignId);
      continue;
    }
    const set = blockedAdGroups.get(negative.campaignId) ?? new Set<string>();
    set.add(negative.adGroupId);
    blockedAdGroups.set(negative.campaignId, set);
  }
  for (const [campaignId, adGroupIds] of servingAdGroupsByCampaign) {
    if (blocked.has(campaignId) || adGroupIds.size === 0) continue;
    const negated = blockedAdGroups.get(campaignId);
    if (!negated) continue;
    if ([...adGroupIds].every((adGroupId) => negated.has(adGroupId))) {
      blocked.add(campaignId);
    }
  }
  return blocked;
}
