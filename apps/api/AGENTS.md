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
per-day `daily` series for the trend chart), and `GET /api/syncs` — the
workspace's recent sync runs, each with per-report-job progress, which the
overview's Sync status card polls while a run is active.

`GET /api/dashboard/summary` returns a `daily` series, `writesDisabled`, and
`previous` — totals for the comparison window, which is the immediately
preceding same-length range for trailing 7/14/30/60d, or prior-month MTD when
`days=mtd`. Those power the period-over-period deltas on the overview KPI cards.

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
`greatest(units, orders)`. KDP pays per copy, so one order of three copies earns
three royalties. The `greatest` degrades to orders on facts imported before the
`units` columns existed, which is safe because Amazon never reports fewer units
than orders.

`GET /api/dashboard/summary` estimates royalty from advertised-product facts
valued with each book's own `book_economics` for that marketplace and metric
date. Never apply one royalty rate per country.

## The `books` product filter

`dashboard/summary`, `dashboard/country-spend`, `campaigns` list and detail,
`recommendations`, and `search-terms` list and detail accept a `books`
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
`campaignNegativeSpec` the cannibalization flow also uses). Terms are deduped
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
Negative ASIN targets are not rollbackable.

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
