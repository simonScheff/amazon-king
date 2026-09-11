# apps/api — `@amazon-king/api`

The browser-facing backend and OAuth callback. Read the root `AGENTS.md` first
for the binding architectural rules, especially **guarded writes** and the
**two separate logins**.

## Commands

`dev` (`tsx watch src/index.ts`), `start`, `typecheck`, `test`.

Stack: Fastify 5 with `@fastify/cookie`, `cors`, and `rate-limit`.

## Structure

Route handlers are thin wrappers over injectable services declared in
`src/services/types.ts`; the handlers themselves hold no logic and no SQL. Tests
use the SQL-matching in-memory `FakeDb` (`src/test/fake-db.ts`), so a new
repository query must be understood by `FakeDb` to be testable here.

The route surface includes `GET /api/change-sets`, cannibalization comparison,
campaign-level
negative-exact and negative-target draft creation, `csrfToken` on the session
response, `amazonConsoleUrl` on campaign list/detail payloads (built from the
profile's `account_id` entity id, null when absent), `negativeTargets` on
`GET /api/campaigns/:id` (synced `ASIN_SAME_AS` exclusions, same book-filter
semantics as `negativeKeywords`), the cross-campaign search-term screens
`GET /api/search-terms` and `GET /api/search-terms/:term` (detail includes a
per-day `daily` series for the trend chart, zero-filled through the term's
latest fact since Amazon only reports days with impressions; a term with no
facts in the window but facts all-time returns zeroed totals from
`listSearchTermPresence` — 404 is reserved for terms that never served), the
workspace negatives inventory
`GET /api/negatives` and `GET /api/negatives/:kind/:value` (`kind` is
`keyword` | `product`), and `GET /api/syncs` — the
workspace's recent sync runs, each with per-report-job progress, which the
overview's Sync status card polls while a run is active.

`GET /api/dashboard/summary` returns a `daily` series, `writesDisabled`, and
`previous` — totals for the comparison window, which is the immediately
preceding same-length range for trailing 7/14/30/60d, or prior-month MTD when
`days=mtd`. Those power the period-over-period deltas on the overview KPI cards.

`GET /api/spend/breakdown` and `GET /api/spend/tree` feed the /spend explorer
(read-only). The breakdown takes `grain=market|campaign|searchTerm` (default
`campaign`) plus the summary's `days`/`country`/`currency` conventions and
returns the top 12 entities by window spend with zero-filled per-day series,
an `other` fold, and previous-window spend per entity and in totals; the tree
returns a two-level hierarchy for the treemap (market → campaigns with
`country=all`, campaign → search terms for a single country, children capped
at 10 plus an "Other" fold). Both share the all-market posture: empty
fx_rates → zeroed figures with `ratesAvailable: false`, partial coverage →
409 `FX_RATES_INCOMPLETE`, and single-country views refuse mixed currencies.

## All-market view and display currency

`GET /api/dashboard/summary` accepts `country=all` plus an optional `currency`
(default: `workspaces.display_currency`). With `all`, the read service uses the
converting queries in `repositories/dashboard.ts` (`convertedDailyTotals`,
`convertedDailySeries`, `convertedRoyaltySeries`) that cross-rate each fact
through the USD pivot at its own metric date; the response carries `currency`
and `ratesAvailable` (returned for single-country views too, so the client can
gate the option). An empty `fx_rates` table yields zeroed totals with
`ratesAvailable: false`; partial coverage is a 409 `FX_RATES_INCOMPLETE` —
never silently unconverted numbers. Single-country behavior is unchanged.
`GET /api/dashboard/country-spend` takes an optional `currency` and then adds
`convertedSpend` per market (null when uncovered). `GET
/api/system/data-freshness` returns `{ profiles, fxRates }` — FX health is
workspace-level. `PATCH /api/workspace/settings` writes the display currency:
local write, CSRF + WRITE rate limit, no recent-auth gate.
`POST /api/fx-rates/sync` is the manual FX-rates trigger: it enqueues one
`fx_sync` job deduped via `enqueueIfNotQueued` (a pending/running job means no
duplicate), audits `fx_sync.request`, and returns the current `fxRates` status
plus a `queued` flag. Same guard posture as the settings write (CSRF + WRITE
rate, no recent-auth) — it is a read-only upstream fetch with no `sync_runs`
row, since that table is per-profile.

## Royalty is valued per copy, not per order

Every royalty query in `repositories/dashboard.ts` values
`greatest(units_sold_clicks14d, purchases14d)`. KDP pays per copy, so one order
of three copies earns three royalties. The 14-day pair matches the
browser-facing conversion window (the Amazon Ads console default); the
`greatest` degrades to orders on facts imported before the `units` columns
existed, which is safe because Amazon never reports fewer units than orders.

`GET /api/dashboard/summary` estimates royalty from advertised-product facts
valued with each book's own `book_economics` for that marketplace and metric
date. Never apply one royalty rate per country.

## The `books` product filter

`dashboard/summary`, `dashboard/country-spend`, `campaigns` list and detail,
`recommendations`, `search-terms` list and detail, `negatives` list and
detail, and `kdp/daily-profit` accept a `books`
comma-separated book-id query param.

Ids are resolved to internal PKs per request via `requireBookPks`, which 404s on
an unknown or foreign book, and forwarded to the repositories. Repositories
filter with an `EXISTS (ad_groups → ads.asin → book_profile_links)` predicate
and `book_id = any($n)`. The semantics are include-all at ad-group grain, union
across selected books, and null or empty means unfiltered.

`POST /api/books/:bookId/profile-links` attaches an existing catalog book to
marketplaces that do not yet have ads (owner-confirmed ASIN). It is a local
catalog write — CSRF + WRITE rate, no recent-auth, no Amazon call.
`POST /api/books/mappings` remains the ads-derived identification path.

## KDP royalty imports

`POST /api/kdp/imports` accepts the browser-parsed rows of a KDP Royalties
Estimator workbook (JSON + Zod; there is no multipart anywhere — the xlsx is
parsed client-side) and derives per-book/per-market royalty-per-copy
suggestions from standard-rate sales only; expanded-distribution rows (40%/50%)
are excluded from the math and reported as context. Idempotent per file
content: a repeat upload returns the existing batch (`alreadyExisted: true`).
`GET /api/kdp/imports` lists recent batches.
`POST /api/kdp/imports/:id/apply` writes the selected suggestions into
effective-dated `book_economics`, preserving every other field from the latest
economics row — books without economics are skipped, never guessed. A batch
applies once (`409 KDP_IMPORT_ALREADY_APPLIED` after that). All three are
settings-level writes: CSRF + WRITE rate limit, no recent-auth gate, no Amazon
call; the audit trail is `kdp.royalty_import.create/apply` plus one
`books.economics` event per applied row.

A new (non-replayed) import also populates the phase-2 history table:
verbatim `kdp_sale_transactions`, with catalog ids whenever the ASIN link
resolves even if the group is skipped for a currency mismatch. The merge is
additive — rows identical to an incoming one are replaced, everything else is
left alone — because every KDP file carries a tail of previous-month orders
and must never destroy another import's data (the 2026-08-29 incident: the
old delete-covered-months model wiped July when the August file arrived).
The batch also stores the normalized report rows (`kdp_royalty_imports.rows`)
so the history can be rebuilt without the original file
(`scripts/rebuild-kdp-history.ts`). Monthly aggregates are not stored: they
derive from the transactions at read time, grouped by KDP report month
(royalty_date, matching the KDP dashboard's display). Two read endpoints
serve the `/kdp-history` page, plain session-authenticated GETs:
`GET /api/kdp/history` returns per book × marketplace monthly series (KDP
units from the derived aggregates, ad-attributed units computed at query time from
the fact tables, `royaltyPerSale` from the effective-dated economics history)
plus per-marketplace fulfillment stats (median/average order→ship days,
standard-rate rows only), and `GET /api/kdp/transactions` is the per-sale
browser (`bookId`/`profileId`/`month`/`limit`/`offset` query params, limit
capped at 1000 with a 500 default, newest order date first, book title joined
in when linked) returning `{ transactions, total }` — one page plus the
filtered total across all pages, which drives the table's pagination.
`GET /api/kdp/daily-profit` (`month` first-of-month ISO XOR a ≤ 93-day
`start`/`end` range, optional `books` list and `country`)
serves the organic tab's daily profit chart and the overview card: per
royalty posting day of the
month (how the KDP dashboard itself displays the data),
the ad spend and estimated ad-attributed royalty (the converting dashboard
queries) next to the real summed KDP royalty (`listKdpDailyRoyalty` over the
verbatim transactions, unlinked-ASIN rows included unless a book filter is
given). The all-market view (absent `country`) converts per day into the
workspace display currency —
empty `fx_rates` returns `ratesAvailable: false`, partial coverage a 409
`FX_RATES_INCOMPLETE`; a specific `country` scopes both sides to that market
(KDP side by KDP report marketplace strings, so unlinked rows match too) and
answers in its native currency via the non-converting series
(`dailySeries`/`overviewRoyaltySeries`/`listKdpDailyRoyaltyNative`), with a
409 `MIXED_CURRENCY` if currencies disagree — the single-country summary's
posture.
organic = max(0, total − ad) avoids double counting
ad-driven sales; profit = total − spend needs no book economics — only the
split does (`economicsMissing` flags days without it). Days are zero-filled
over the month, the current month capped at today; an unimported month
returns null KDP figures with `kdpImported: false`.

## Campaign creation

`POST /api/campaign-creation-change-sets` is human-approved campaign creation.
It drafts one `campaign_creation` change set per profile holding
create_campaign → create_ad_group →
create_product_ad / create_keyword / create_target actions. Product targets are
ASINs via `ASIN_SAME_AS` expressions with an optional bid.

Keywords and targets are MANUAL-only, enforced by the contract schema: Amazon
creates the default auto targets itself and rejects manual targeting clauses in
auto campaigns, so an AUTO campaign carries no manual targeting actions.

Apply resolves the creation chain, treats an existing same-name campaign as
already satisfied, verifies created ids against a fresh structure read, then
enqueues a `structure_sync`. Creation sets are **not** rollbackable.

When the payload carries `cannibalization.recommendationId`, the service also
validates the finding (it must cover the conflict's profile) and drafts a second
`recommendation`-kind change set adding the term as a campaign-level negative
exact keyword — or a negative ASIN target when the term is an ASIN — in every
conflicting campaign, with `metadata.dependsOnChangeSetId` pointing at the
creation set. `applyLoadedSet` rejects such a set with `DEPENDENCY_NOT_APPLIED`
until the referenced set is `applied`, so the term is never blocked in every
campaign at once, which would strand the traffic with nowhere to land. A
verified apply of those negatives (or of `add_negative_exact`) enqueues a
`structure_sync` and moves the finding `approved → applied`.

## Conversion findings

`high_ctr_poor_conversion` has no single Amazon write, so instead of one
approval it gets a context endpoint plus the campaign actions the app already
guards.

`GET /api/recommendations/:id/conversion-context` returns the campaign by
Amazon id and name, its console URL, the metrics stored in
`recommendation_evidence.inputs`, the books its ads map to (title, marketplace
ASIN, cover), and the campaign's zero-order shopper terms over the evidence
window, ranked by spend, excluding terms a synced negative already blocks.
`metrics.suggestedMaxCpc` is presentation only — a cut below the observed
average CPC, never a computed break-even, which would need a conversion rate
the finding does not have.

`POST /api/campaigns/:campaignId/negatives` takes `{ searchTerms }` and drafts
one `recommendation`-kind change set adding a campaign-level negative exact per
term (a negative ASIN target when the term is an ASIN, via the shared
`campaignNegativeSpec` in `@amazon-king/database`'s `change-drafts.ts`, which
the cannibalization and exclusion flows also use). Terms are deduped
case-insensitively because Amazon matches negatives that way. Drafting writes
nothing to Amazon, so it is not recent-auth gated; the apply in Change center
keeps the gate.

`POST /api/search-terms/:term/negatives` is the bulk variant: it takes
`{ campaignIds }` (Amazon ids), resolves the term's per-campaign rows exactly
like `GET /api/search-terms/:term` (same `days`/`books`/`country` query
params), and drafts one negatives change set per requested campaign that runs
the term and is enabled, via `createCampaignNegativesChangeSet`. Unknown or
non-enabled ids come back in `skippedCampaignIds` — never an error. Same
guard posture: CSRF + WRITE rate limit, no recent-auth gate.

`POST /api/search-terms/:term/exclusion` is the persistent, all-market
variant. `createSearchTermExclusion` normalizes the term (trimmed +
lowercased), upserts it into `search_term_exclusions`, then drafts one
negatives change set per enabled profile covering the campaigns that
actually served the term — resolved from search-term facts over the trailing
30 days via `dashboard.listSearchTermServingCampaigns`, the same serving
resolution the bulk-negatives route gets through the search-term detail —
and are enabled and not already blocking it. Campaigns that never served the
term get no action and are not counted in `skippedCampaigns` (that counts
only serving campaigns needing no action); campaigns that start serving it
later are covered by the worker's enforcement pass. Drafting goes through
`createSearchTermExclusionSet` in `@amazon-king/database`'s
`change-drafts.ts` (`metadata.strategy: "search_term_exclusion"`,
fingerprint-idempotent) and audits `search_term.exclusion.create`.
`DELETE /api/search-terms/:term/exclusion` removes only the list entry —
negatives already applied on Amazon stay (the per-campaign removal flow
re-includes them) and open drafts are unaffected.
`GET /api/search-terms/exclusions` lists the workspace's exclusions through
the read service (`listSearchTermExclusions`). All three sit next to the
bulk-negatives route with the same guard posture (CSRF + WRITE rate, no
recent-auth) because they only draft; applying the sets still goes through
the guarded apply flow.

`POST /api/recommendations/:id/reject` accepts an optional
`{ snoozeDays: 1–365 }`, which shortens the default 60-day dismissal
suppression so a finding the owner intends to fix returns to confirm the fix
worked.

## One-click campaign updates

`POST /api/campaigns/:campaignId/state` (pause/enable) and
`POST /api/campaigns/:campaignId/name` (rename) each draft a single-action
`campaign_update` change set (`update_campaign_state` /
`update_campaign_name`) and immediately run the guarded apply. Both are
rollbackable by restoring the before-state, and a verified apply writes through
to the local `campaigns` mirror via `structure.updateCampaignAttributes`.

## Guarded write flow

`src/services/changes.ts` is the only path to Amazon writes: fingerprint-
idempotent create, preview, re-read Amazon and compare against the before-state,
guardrails, per-item apply, then verify. Rollback is a compensating API action
— never a DB undo — and covers verified app-created negative exact keywords.
Negative ASIN targets are not rollbackable. A verified negative removal
(`remove_negative_exact` / `remove_negative_target`) writes through to the
local mirror (deletes the `negative_keywords` / `negative_targets` row) and,
like negative additions, enqueues a `structure_sync`, so the dashboard stops
showing the exclusion immediately instead of waiting for the next sync.

## Authentication

Passwordless email login. In development no SMTP is configured and the magic
link is returned as `devLoginUrl` plus logged; see the `local-stack` skill.

- The login token records the allowlisted browser origin it was started from
  (`login_tokens.origin`), so the magic link and post-verify redirect work on
  localhost and a cloudflared tunnel interchangeably.
- An optional same-origin `next` path (`login_tokens.next_path`) returns the
  user to the page that required re-auth.
- CSRF is stateless HMAC per session. OAuth state is single-use and marked used
  **before** the code exchange.
- Refresh tokens are envelope-encrypted via `@amazon-king/crypto` and never
  reach the browser.
- Recent auth (15 minutes, `RECENT_AUTH_MS` in `src/config.ts`) is required for
  apply and rollback. The one exception is retrying a `failed` change set, which
  replays an already-approved payload through the same guarded path and so skips
  the gate.
