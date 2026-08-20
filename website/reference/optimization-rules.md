---
title: Optimization Rules
description: The nine deterministic optimizer rules of amazon-king — exact trigger thresholds, proposal math, suppression conditions, guardrails, and ranking.
---

# Optimization Rules

The optimizer (`packages/optimizer`) is pure and deterministic: no I/O, no
wall clock (time is injected), money in integer micro-units internally with
string decimals at the boundaries. Every rule is versioned (`<name>@<n>`),
stores its exact inputs as evidence, and expires when data goes stale. Rules
run over 7/14/30/60-day windows after each complete metrics sync.

All thresholds below are the defaults from `DEFAULT_OPTIMIZER_CONFIG`
(`packages/optimizer/src/config.ts`); a deployment or test can override them
via `resolveOptimizerConfig`. Profit-based rules require user-entered
[KDP book economics](/guide/book-economics) and are **disabled — never
guessed — when economics are missing**.

## The nine rules

### 1. `expensive_target` — bid down a losing target

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A target has orders but loses money or runs materially above target ACoS → lower the bid. |
| Trigger    | `clicks ≥ 10` **and** `orders ≥ 1` **and** (`observed ACoS ≥ 1.2 × target ACoS` **or** `estimated ad profit < 0`). When there are no attributed sales, the observed ACoS is treated as `1.2 × target` for the proposal. |
| Proposal   | `proposedBid` (see [Shared math](#shared-math)), floored at `current bid × 0.85` so the cut never exceeds the −15% clamp band. |
| Suppressed | Launch goal mode; missing KDP economics; protected campaign; bid cooldown active on the target. Also rejected when the computed bid is not below the current bid. |
| Impact     | `max(|min(profit, 0)|, max(0, cost − targetAcos × sales))` — the larger of the loss and the excess spend over target. |
| Human review | No. Writable: `update_bid`. |
| Version    | `expensive_target@2` (v2 values royalty per copy sold instead of per order) |

### 2. `profitable_target` — bid up a proven winner

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A target converts profitably with ACoS safely below target → raise the bid cautiously. |
| Trigger    | `clicks ≥ 10` **and** `orders ≥ 2` **and** `observed ACoS ≤ 0.8 × target ACoS` **and** `estimated ad profit > 0`. |
| Proposal   | `proposedBid`, clamped to at most +15% and capped by the profit-ceiling CPC and the book's max bid. Rejected when the result is not above the current bid. |
| Suppressed | Missing KDP economics; protected campaign; bid cooldown active on the target. |
| Impact     | The estimated ad profit over the window. |
| Human review | No. Writable: `update_bid`. |
| Version    | `profitable_target@2` (v2 values royalty per copy sold instead of per order) |

### 3. `wasteful_search_term` — negative a zero-order term

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A shopper term accumulates meaningful clicks with zero orders → add it as a negative exact keyword. |
| Trigger    | `clicks ≥ 20` **and** `orders = 0`. |
| Proposal   | None (no scalar value); the action is `add_negative_exact` for the term. |
| Suppressed | Protected search term; launch goal mode (exploration spend is expected); a negative for this term was already added within the cooldown window; a synced negative keyword or negative ASIN target already blocks this campaign for the term. Does not require economics. |
| Impact     | The term's spend over the window (the stopped waste). |
| Human review | No. Writable: `add_negative_exact`. |
| Version    | `wasteful_search_term@2` (v2 treats a synced negative as already resolved, so historical clicks do not keep proposing the same exclusion) |

### 4. `search_term_harvest` — promote a converting term

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A term converts repeatedly inside auto/broad targeting → add it as an exact keyword in a controlled manual campaign for direct bid control. |
| Trigger    | `orders ≥ 2` from an `auto` or `broad` source, and the term is **not** already exact-targeted in a manual campaign. |
| Proposal   | The estimated break-even CPC (smoothed CVR × royalty) when economics exist; otherwise null and the human sets the starting bid. |
| Suppressed | Source targeting is phrase/exact; term already targeted exactly; a synced negative already blocks this campaign for the term. Does not require economics to fire. |
| Impact     | The term's attributed sales over the window. |
| Human review | **Yes.** Advisory-only — cannot enter a change set automatically. |
| Version    | `search_term_harvest@1` |

### 5. `budget_constrained_winner` — raise a capped budget

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A profitable campaign keeps hitting its daily budget → stop capping the winner. |
| Trigger    | Spend `≥ 90%` of daily budget on `≥ 3` days of the window **and** `estimated ad profit > 0`. |
| Proposal   | `daily budget × 1.2`, capped by the profile's `maxDailyBudget` when configured. Rejected when the capped proposal is not above the current budget. |
| Suppressed | Missing KDP economics (royalty null); protected campaign; budget ≤ 0. |
| Impact     | The estimated ad profit over the window. |
| Human review | No. Advisory-only in the MVP (no automatic budget write). |
| Version    | `budget_constrained_winner@2` (v2 values royalty per copy sold instead of per order) |

### 6. `high_ctr_poor_conversion` — listing problem diagnostic

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | The ad attracts clicks but the book does not sell — flag cover, price, subtitle, listing copy, or audience mismatch. The Ads API cannot fix the KDP listing. |
| Trigger    | `impressions ≥ 1000` **and** `CTR ≥ 0.3%` **and** `CVR < 0.5%`. |
| Proposal   | None — diagnostic only. |
| Suppressed | Remaining unblocked search-term traffic no longer meets the trigger (the wasted clicks are already negatives). No economics needed. |
| Impact     | The spend over the window. |
| Human review | **Yes.** No single Amazon write, but the finding opens a [resolution screen](/guide/recommendations#clicked-but-not-bought) offering a listing checklist with a 30-day snooze, negatives for zero-order terms, a Max CPC ceiling, or pausing the campaign. |
| Version    | `high_ctr_poor_conversion@1` |

### 7. `low_impressions` — no-traffic diagnostic

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | An active target receives almost no traffic → review bid, match type, indexing, and targeting relevance. |
| Trigger    | Target state `enabled`/`active` **and** `impressions < 100` over the window. |
| Proposal   | None — the bid is never raised automatically without relevance evidence. Confidence grows as impressions approach zero (`min(1, 1 − impressions/100 + 0.5)`). |
| Suppressed | Target not enabled/active. |
| Impact     | 0 (diagnostic). |
| Human review | **Yes.** Advisory-only. |
| Version    | `low_impressions@1` |

### 8. `placement_opportunity` — raise a winning placement

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | A placement is consistently profitable with enough volume → suggest a placement bid-modifier increase. |
| Trigger    | `clicks ≥ 20` **and** `orders ≥ 2` **and** `observed ACoS ≤ 0.8 × target ACoS` **and** `estimated ad profit > 0`. |
| Proposal   | `current modifier + 0.10` — a single fixed step, so repeated approvals cannot compound beyond the step in one recommendation. Values are expressed as fractions (e.g. `0.1000`). |
| Suppressed | Missing KDP economics; protected campaign. |
| Impact     | The estimated ad profit over the window. |
| Human review | No. Advisory-only in the MVP. |
| Version    | `placement_opportunity@2` (v2 values royalty per copy sold instead of per order) |

### 9. `cannibalization_conflict` — overlapping campaigns

| Aspect     | Detail |
| ---------- | ------ |
| Purpose    | The same shopper term has spend/orders in `≥ 2` campaigns → campaigns bid against each other; consolidate or separate intent. |
| Trigger    | `campaigns ≥ 2` carrying the same search term, counting only spend/orders **inside the evidence window**. |
| Proposal   | None — resolution is a human decision (route to an existing campaign or create a new one via the [campaign-creation flow](/guide/campaign-tools), which then drafts locked negatives). |
| Suppressed | Campaigns that can no longer serve the term are excluded before the `≥ 2` check, so a conflict you already resolved with a negative stops being raised (see below). No economics needed. |
| Impact     | The combined spend across the still-competing campaigns. |
| Human review | **Yes.** Advisory-only. |
| Version    | `cannibalization_conflict@2` |

**Negative awareness.** Historical spend stays in the 60-day evidence
window long after a negative is applied, so the rule checks the negatives
synced from Amazon (`negative_keywords` and `negative_targets`) rather than
the metrics alone. A campaign counts as blocked when an enabled campaign-level
negative exact or negative phrase matches the term, when an enabled campaign-level
negative ASIN target matches an ASIN-shaped shopper term, or when every ad group
that served the term has a matching ad-group-level negative. Blocked campaigns
are recorded under `excludedCampaigns` in the evidence and do not count toward
the threshold; when that leaves fewer than two competing campaigns, any pending
or approved finding an earlier run raised for the term is expired instead of
re-raised.

## Shared math (`src/calc.ts`)

Ratios return `null` on division by zero — never Infinity/NaN. Genuinely
invalid inputs (negative counts, out-of-range rates) throw, because that
indicates a caller bug.

| Function | Formula |
| -------- | ------- |
| `acos` | `cost / sales`; null when sales = 0. ACoS is ad-spend-over-retail-revenue, **not** author profit. |
| `roas` | `sales / cost`; null when cost = 0. |
| `conversionRate` | `orders / clicks`; null when clicks = 0. |
| `estimatedAdProfit` | `copies × royaltyPerSale − cost`, exact integer micro-units; may be negative. |
| `royaltyCopies` | `max(orders, units)` — the copies a royalty is earned on. KDP pays per copy, so one order of three copies earns three royalties. Facts imported before the `units` columns existed report 0 units, and Amazon never reports fewer units than orders, so this degrades to `orders` there rather than erasing the royalty. |
| `breakEvenCpc` | `smoothed CVR × royaltyPerSale`, rounded half-up to 4 dp — the profit ceiling for a bid. |
| `smoothedConversionRate` | `(orders + 0.05 × 20) / (clicks + 20)` — a beta-style prior (rate 0.05, weight 20). At zero clicks it returns 0.05; with volume it converges to the observed rate. |

### `proposedBid`

```
raw multiplier     = targetAcos / observedAcos
guarded multiplier = clamp(raw, 0.85, 1.15)
profit ceiling CPC = smoothedCvr × royaltyPerSale × safetyFactor (default 1)
proposed bid       = min(current × guarded, ceiling, maxBid?)   — rounded half-up to 4 dp
```

Returns null (the proposal is rejected) when economics are missing
(`royaltyPerSale` or `targetAcos` null), inputs are invalid (non-positive bid,
target, or observed ACoS), the result equals the current bid, or the relative
change is below 1% (`minBidRelativeChange`) — sub-1% moves are treated as
noise.

### Confidence

`evidenceConfidence(observed, required) = min(1, observed / (2 × required))` —
0.5 at exactly the required threshold, growing toward 1.0 at 2× the
requirement. Rules with several evidence dimensions combine them with
`Math.min` (weakest link wins).

### Ranking and priority

Drafts sort by `impactMicros` (absolute estimated profit delta / spend at
stake, in micros), then `confidence`, then deterministically by `ruleVersion`
and entity reference (`targetId`, then `searchTerm`, then `campaignId`) so
equal drafts always order the same way. `priority` maps rank onto the 1–5
contract scale by quintile: the top fifth of a batch is priority 1, the bottom
fifth priority 5.

## Guardrails (`src/guardrails.ts`)

Guardrails run before any write is sent to Amazon — at preview time and again
at apply time. Defaults from `DEFAULT_GUARDRAIL_CONFIG`:

| Guardrail                | Default | Meaning |
| ------------------------ | ------- | ------- |
| `maxBidChangePct`        | 0.15    | Max relative bid change per action within a cooldown period. |
| `bidCooldownDays`        | 7       | A target changed within this window cannot be changed again. |
| `maxDailyBudgetMicros`   | null    | Absolute daily-budget ceiling; null disables the check. |
| `maxBudgetIncreasePct`   | 0.25    | Max single budget increase as a fraction of the current budget. |
| `maxActionsPerChangeSet` | 20      | Max actions in one change set. |
| `maxExposureMicros`      | null    | Max summed monetary exposure per change set; null disables. Exposure = Σ \|bid deltas\| + budget increases. |
| `stalenessDays`          | 3       | Evidence older than this refuses the write. |
| `protectedSearchTerms`   | []      | Lower-cased terms that may never receive a negative. |
| `protectedCampaignIds`   | []      | Campaigns that may never be modified. |

Violation codes: `KILL_SWITCH_ENABLED`, `PROFILE_READ_ONLY`,
`BID_CHANGE_TOO_LARGE`, `BID_COOLDOWN_ACTIVE`, `BUDGET_EXCEEDS_MAX`,
`BUDGET_INCREASE_TOO_LARGE`, `TOO_MANY_ACTIONS`, `EXPOSURE_TOO_LARGE`,
`PROTECTED_ENTITY`, `STALE_EVIDENCE`. Any violation blocks the write; at
preview they surface as `409 GUARDRAIL_VIOLATION` / preview warnings.

## Cooldowns, launch mode, staleness

- **Cooldowns.** After a related write, contradictory rules stay quiet for
  `cooldownDays` (7). A change matches when every field given in the rule's
  match clause (action type, target, campaign, search term) equals the
  change's fields. The apply-time guardrail independently enforces one bid
  change per target per `bidCooldownDays` (7).
- **Launch mode.** With a book's `goalMode` set to `launch`,
  `expensive_target` and `wasteful_search_term` are suppressed entirely —
  exploration spend is expected during launch.
- **Missing economics.** Rules that need profitability
  (`expensive_target`, `profitable_target`, `budget_constrained_winner`,
  `placement_opportunity`) do not fire without royalty and target ACoS.
  `search_term_harvest` still fires but leaves the bid to the human.
- **Staleness and expiry.** A recommendation expires `stalenessDays` (3 days)
  after it is created; the API rejects expired recommendations with
  `409 RECOMMENDATION_EXPIRED`. At apply time, any action whose evidence ends
  more than 3 days ago is refused with `STALE_EVIDENCE` — re-sync before
  writing.

## Related reading

- [Recommendations guide](/guide/recommendations) — reading and acting on findings
- [Applying changes](/guide/applying-changes) — the guarded write flow
- [Architecture: data pipeline](/architecture/data-pipeline) — when rules run
