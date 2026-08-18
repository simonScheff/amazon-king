---
name: add-optimizer-rule
description: Add or change a recommendation rule in packages/optimizer, including versioning, evidence requirements, and threshold tests. Use when adding a new finding type or modifying the thresholds or logic of an existing rule.
whenToUse: When work touches packages/optimizer/src/rules, or when changing how a recommendation is produced, ranked, suppressed, or expired
---

Rules are deterministic and pure. Read `packages/optimizer/AGENTS.md` for the
purity contract and `docs/plan.md` §9 and §10 for rule and guardrail
specifications.

## Non-negotiables

- **No I/O and no wall clock.** Time is injected. A rule that reads
  `Date.now()` is a bug, not a shortcut — determinism is what makes these rules
  auditable and testable.
- **Money is integer micro-units** internally, with string decimals only at the
  boundaries. Never do floating-point arithmetic on money.
- **Every rule is versioned** with a `*_RULE_VERSION` constant and is referenced
  as `rule_name@N`.
- **Store exact inputs.** A recommendation must carry the evidence it was
  computed from, so a human can audit why it was raised.
- **Require minimum evidence** before firing, and use smoothed conversion rates
  rather than raw ratios on small samples.
- **Clamp bid changes** to ±10–15% per cooldown period via the shared
  `proposedBid` formula. Do not introduce a second clamp.
- **Expire when data goes stale.**
- **Profit rules require real economics.** When KDP economics are missing, the
  rule must be suppressed, never run on guessed numbers. ACoS is
  ad-spend-over-retail-revenue and is not author profit.
- **Value royalty on copies.** Profit rules pass
  `royaltyCopies(orders, units)` — `max(orders, units)` — to
  `estimatedAdProfit`, because KDP pays per copy sold.

## When to bump the version instead of editing in place

Bump `*_RULE_VERSION` whenever the change would make the rule produce a
different verdict from the same inputs — new or moved thresholds, a changed
formula, or different evidence requirements. Pending recommendations and
cooldowns are keyed by rule version, so silently changing behavior under the
same version mixes old and new findings together. Pure refactors that cannot
change output do not need a bump.

## Steps

1. Add the rule under `packages/optimizer/src/rules/` and export it from
   `rules/index.ts`.
2. Define its identity tuple carefully. The worker dedupes on it and
   `recommendation_dismissals` is keyed by the same tuple, so a rejected finding
   is not raised again.
3. Add ranking behavior in `rank.ts` if the finding competes for attention with
   existing ones.
4. Check interaction with suppression: guardrails (`guardrails.ts`), cooldowns,
   launch mode, protected campaigns, and — for anything search-term related —
   `negatives.ts`, which decides which campaigns a synced negative already
   blocks.
5. Wire it into `recommendation_run` in `apps/worker/src/jobs/`, which runs
   rules over 7/14/30/60-day windows.
6. Add the contract type in `packages/contracts` and the web rendering, so the
   finding is explainable in the UI rather than appearing as an unknown type.
7. Test at **threshold boundaries** — just under, exactly at, and just over —
   plus the suppression cases: launch mode, protected, cooldown, missing
   economics, and stale data.
