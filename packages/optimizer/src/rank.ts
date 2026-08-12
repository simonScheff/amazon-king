import type { RecommendationDraft } from "./rules/types.js";

export interface RankedRecommendation extends RecommendationDraft {
  /** 1-based position after ranking (1 = highest impact). */
  rank: number;
  /** 1–5 priority matching the contracts Recommendation schema (1 = top). */
  priority: number;
}

/**
 * Rank recommendation drafts by expected economic impact (absolute
 * estimated profit delta / spend at stake, in micros), then by confidence,
 * then deterministically by rule version and entity refs so equal-impact
 * drafts always order the same way. Input array is not mutated.
 *
 * Priority maps rank onto the contracts 1–5 scale: the top fifth of a batch
 * is priority 1, the bottom fifth priority 5.
 */
export function rankRecommendations(
  drafts: readonly RecommendationDraft[],
): RankedRecommendation[] {
  const sorted = [...drafts].sort((a, b) => {
    if (b.impactMicros !== a.impactMicros)
      return b.impactMicros - a.impactMicros;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.ruleVersion !== b.ruleVersion) {
      return a.ruleVersion < b.ruleVersion ? -1 : 1;
    }
    const aKey = a.targetId ?? a.searchTerm ?? a.campaignId ?? "";
    const bKey = b.targetId ?? b.searchTerm ?? b.campaignId ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const total = sorted.length;
  return sorted.map((draft, index) => {
    const rank = index + 1;
    const priority =
      total === 0 ? 1 : Math.min(5, 1 + Math.floor((5 * (rank - 1)) / total));
    return { ...draft, rank, priority };
  });
}
