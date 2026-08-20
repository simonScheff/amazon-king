# packages/optimizer — `@amazon-king/optimizer`

The deterministic recommendation engine. Read the root `AGENTS.md` for the
**deterministic optimizer** rule, which this package exists to enforce.

## Purity contract

Pure and deterministic: no I/O, no network, no database, and no wall clock —
time is injected. Money is integer micro-units internally, with string decimals
only at the boundaries. Anything that breaks purity belongs in the worker, not
here.

## Layout

All nine plan §9 rules live under `src/rules/`, each with a `*_RULE_VERSION`
constant. Alongside them: `proposedBid` per the plan formula with its ±15%
clamp, guardrails in `guardrails.ts` (`checkGuardrails`, plan §10), ranking in
`rank.ts`, and smoothed conversion rates in `calc.ts`.

To add or change a rule, use the `add-optimizer-rule` skill.

## Two subtleties that the tests exist to protect

**Negatives suppress already-resolved search-term findings.** `src/negatives.ts`
decides which campaigns a synced negative keyword or negative ASIN target blocks
for a given shopper term — exact and phrase keywords, enabled only, and an
ad-group negative blocks a campaign only when every serving ad group is negated.
ASIN shopper terms use `keywordSpecsFromNegativeTargets` so campaign-level
`ASIN_SAME_AS` exclusions count the same way. `cannibalization_conflict@2`
excludes those campaigns before its `minCampaigns` check, and
`wasteful_search_term@2` does not propose another negative for a term the
campaign can no longer serve. Historical search-term clicks stay in the evidence
window after a negative is applied; the block flag is what stops the finding.

**Profit is earned per copy, not per order.** `estimatedAdProfit` takes copies.
The four profit rules — `expensive_target@2`, `profitable_target@2`,
`budget_constrained_winner@2`, `placement_opportunity@2` — pass
`royaltyCopies(orders, units)`, which is `max(orders, units)`. A multi-copy
order therefore earns a royalty per copy, and windows whose units were never
imported fall back to orders.

Coverage is expected at threshold boundaries and for launch-mode, protected, and
cooldown suppression.
