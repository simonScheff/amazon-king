export * from "./types.js";
export * from "./wasteful-search-term.js";
export * from "./expensive-target.js";
export * from "./profitable-target.js";
export * from "./search-term-harvest.js";
export * from "./budget-constrained-winner.js";
export * from "./high-ctr-poor-conversion.js";
export * from "./low-impressions.js";
export * from "./placement-opportunity.js";
export * from "./cannibalization-conflict.js";

import { WASTEFUL_SEARCH_TERM_RULE_VERSION } from "./wasteful-search-term.js";
import { EXPENSIVE_TARGET_RULE_VERSION } from "./expensive-target.js";
import { PROFITABLE_TARGET_RULE_VERSION } from "./profitable-target.js";
import { SEARCH_TERM_HARVEST_RULE_VERSION } from "./search-term-harvest.js";
import { BUDGET_CONSTRAINED_WINNER_RULE_VERSION } from "./budget-constrained-winner.js";
import { HIGH_CTR_POOR_CONVERSION_RULE_VERSION } from "./high-ctr-poor-conversion.js";
import { LOW_IMPRESSIONS_RULE_VERSION } from "./low-impressions.js";
import { PLACEMENT_OPPORTUNITY_RULE_VERSION } from "./placement-opportunity.js";
import { CANNIBALIZATION_CONFLICT_RULE_VERSION } from "./cannibalization-conflict.js";

/** All current rule versions, keyed by recommendation type. */
export const RULE_VERSIONS = {
  wasteful_search_term: WASTEFUL_SEARCH_TERM_RULE_VERSION,
  expensive_target: EXPENSIVE_TARGET_RULE_VERSION,
  profitable_target: PROFITABLE_TARGET_RULE_VERSION,
  search_term_harvest: SEARCH_TERM_HARVEST_RULE_VERSION,
  budget_constrained_winner: BUDGET_CONSTRAINED_WINNER_RULE_VERSION,
  high_ctr_poor_conversion: HIGH_CTR_POOR_CONVERSION_RULE_VERSION,
  low_impressions: LOW_IMPRESSIONS_RULE_VERSION,
  placement_opportunity: PLACEMENT_OPPORTUNITY_RULE_VERSION,
  cannibalization_conflict: CANNIBALIZATION_CONFLICT_RULE_VERSION,
} as const;
