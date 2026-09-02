# apps/web — `@amazon-king/web`

The dashboard: a thin control room over the backend. Read the root `AGENTS.md`
first for product boundaries and the binding architectural rules.

## Commands

Run from this directory or with `pnpm --filter @amazon-king/web <script>`.

| Script      | Does                                                                |
| ----------- | ------------------------------------------------------------------- |
| `dev`       | Vite dev server on :5173, proxies `/api` to `http://localhost:3000` |
| `build`     | `vite build`                                                        |
| `typecheck` | `tsc -p tsconfig.json`                                              |
| `test`      | `vitest run --passWithNoTests` (jsdom + Testing Library)            |

The dev server's `/api` proxy target honors `VITE_API_PROXY_TARGET` (default
`http://localhost:3000`) — set it to point a second dev server at a
demo/scratch API.

Stack: Vite + React 19 + TypeScript, TanStack Router (code-based routes) and
Query, Tailwind CSS v4 via `@tailwindcss/vite`, Recharts.

## Boundary rules

- All API types come from `@amazon-king/contracts` (workspace link). Validate
  every response with its Zod schema at the fetch boundary — do not hand-write
  response types.
- The browser never touches Amazon. No Amazon credentials, tokens, or direct
  Amazon API calls belong in this app; everything goes through `/api`.
- Country flags render through the `Flag` component (`src/components/flag.tsx`),
  which uses bundled `flag-icons` SVGs. Never use Unicode flag emoji — several
  platforms do not render them.

## Installable web app (PWA)

`public/` ships a root-scoped manifest and a **network-only** service worker, so
an HTTPS deployment installs in standalone display mode without caching Amazon
data. Keep the worker network-only: cached ad metrics would be both stale and a
data-at-rest question. Development builds deliberately do not register it.

On phones the app is **install-only**. `InstallGate`
(`src/components/install-gate.tsx`) wraps `AppLayout` and replaces every app
route with per-browser install instructions: a native `beforeinstallprompt`
button, iOS Safari's Share → Add to Home Screen, "open in Safari" for other iOS
browsers, and the browser menu otherwise. There is no dismiss — only a
dev-build bypass.

Two constraints that are easy to break:

- Phone detection is user-agent based (`src/lib/install.ts`), **not** viewport
  based, so a narrow desktop window and iPadOS Safari keep browser access.
- `/login` stays outside the gate on purpose. iOS gives an installed web app its
  own storage container and copies Safari's cookies only at the moment the app
  is added to the home screen, so signing in in the browser first is the only
  order that leaves the installed app with a session.

Every later sign-in inside the installed app goes through `PasteLoginLink`
(`src/components/paste-login-link.tsx`), rendered on `/login` and inside
`ReauthDialog` only when `isStandalone()`. An emailed magic link always opens in
the browser, whose session an installed iOS app cannot see, so the link is
pasted back in instead: `parseLoginToken` (`src/lib/login-link.ts`) accepts the
whole link, a copied path, or a bare token, and `redeemLoginToken`
(`src/api/client.ts`) fetches `GET /api/session/verify` so the cookie lands in
this container. Verify answers with a redirect either way, so failure is read
from the URL it lands on (`error=invalid_token`), after which the session is
re-read for the new CSRF token. Without this path an installed iPhone app could
never satisfy the 15-minute recent-auth gate on apply and rollback.

## Global product filter

A multi-select product filter lives in the sidebar footer
(`src/components/product-filter.tsx`, rendered by `Sidebar` in
`src/components/layout.tsx`). It is a checkbox dropdown modeled on
`CountrySelect` that opens upward, or rightward when the sidebar is collapsed to
icons, with options from `useBooks()`.

It writes a `books` comma-separated book-id search param, validated once on the
`appRoute` layout route in `src/router.tsx` and retained across navigation via
`retainSearchParams(["books"])` plus a custom `stringifySearch` that preserves
the `?books=3,7` form. `src/router.test.tsx` proves the retention — keep that
test passing, because the default stringifier silently rewrites the param into a
form the API rejects.

Overview, campaigns, campaign detail, search terms, negatives, and recommendations pass the
selection to their query hooks, and their query keys must include the sorted id
list or the cache will serve another book's numbers. `/changes`, `/settings`,
and `/connect` ignore the filter.

Campaign and search-term list payloads carry `bookIds` (distinct catalog books
linked through ads); those tables and the filter dropdown render cover thumbs
from `GET /api/books`.

## Date ranges

Overview, campaign detail, search-term detail, and the negatives list/detail
pages share
`src/components/timeframe-select.tsx`: 1/7/14/30/60 days plus month-to-date
(`?days=mtd`, UTC 1st of the current month through today). Bare `/` defaults to
`mtd` — the overview passes it as the `resolveTimeframe` fallback; the other
pages keep the 30-day `DEFAULT_TIMEFRAME`. Facts land a day
late (metrics sync imports yesterday), so the read service resolves a 1-day
window to the latest complete day — yesterday, both days equal — not the
empty in-progress today. The campaigns **list** page deliberately hardcodes a
30-day profitability window and has no selector.

## All-market view and display currency

The overview country selector offers **"All markets"** as a peer of the
specific markets (`allMarketsLabel` on `src/components/country-select.tsx` —
same control, no flag). Selecting it sets `?country=all`; the overview
route's `validateSearch` accepts the `all` literal via the contracts
`dashboardCountrySchema` (same acceptance as the API). Bare `/` (no
`?country=`) also lands here once FX rates are synced — the overview gates
that default on `useDataFreshness()` reporting a non-null
`fxRates.latestRateDate`, the same source the API's `ratesAvailable` uses,
and falls back to the US-first `resolveCountry` resolution before the first
rates sync. The option is
disabled with a tooltip pointing at the Sync status card until the summary
response reports `ratesAvailable: true` — that field comes back on every
summary response, so the gate works before the view is ever requested.

With `country=all` the overview converts everything into the single
workspace display currency:

- `useDashboardSummary` and `useCountrySpend` take an optional `currency`
  override; when omitted the API applies the workspace setting. The overview
  passes the summary's returned `currency` to country-spend so the **Spend
  by market** card shows each market's converted spend with the native
  figure in parentheses (`—` / "rates missing" when rates don't cover that
  market).
- A **Currency** picker (`src/components/display-currency-select.tsx`)
  appears in the overview header only while `all` is active; the same picker
  lives in the **Workspace** card on Settings → Profiles. Both PATCH
  `/api/workspace/settings` via `useUpdateWorkspaceSettings` — a local write
  (CSRF, WRITE rate limit, no recent-auth gate). There is no GET endpoint:
  `useWorkspaceSettings` subscribes to a `["workspace-settings"]` cache entry
  (`enabled: false`, never fetches) that the successful PATCH seeds, and
  falls back to USD (the server default) when the cache is empty. The
  mutation then invalidates the dashboard-summary and country-spend queries.
- Query keys carry `country` (including `all`) and `currency` or TanStack
  Query would serve another view's numbers — same rule as `books`.

The Sync status card shows an **FX rates** row (`FxRatesRow` in
`src/components/fx-rates-row.tsx`, shared with the Settings Workspace card)
fed by `useDataFreshness()`, whose response is an envelope
`{ profiles, fxRates }` (the bare-array shape predates FX). Row
states: `syncing…` (last run `running`), `sync failed` with the error,
`not synced yet` (never run), `stale · rates through <date>` (warning tone),
and `up to date through <date>`. FX health is workspace-level, so the row
renders regardless of the selected market. `useDataFreshness` polls every 10s
while `fxRates.lastRunState === "running"` (or while a caller forces polling),
mirroring how the overview polls sync runs.

The Settings Workspace card pairs the row with a **Sync rates now** button
(`useEnqueueFxSync` → `POST /api/fx-rates/sync`): a manual trigger for the
daily rates job, deduped server-side, disabled while a run is active. A
just-triggered sync is invisible in the status until the worker claims the
job, so the card force-polls freshness until the run appears.

Search terms and negatives are the exception: their APIs stay two-letter only, so
those hooks translate `country === "all"` into no country filter
(unfiltered) rather than sending `all` downstream. There is no FX conversion
on either screen.

## Total sales card

The **Organic data** tab of `/kdp-history` renders a single merged card
("Total sales — ads + organic", inline in `src/routes/kdp-history.tsx`) fed
entirely by `useKdpHistory` — there is no separate endpoint or request. It
combines three stat tiles (total units, from ads, organic, the latter two with
shares of the total, computed client-side by `buildSalesTotals`/`unitShare`
over the visible months) with the full-imported-history stacked bar chart
(`SalesMixChart` in `src/components/kdp-history-charts.tsx`: ad `#a078ff` vs.
organic `#34d399`, organic clamped ≥ 0 per book × market × month before
summing). The URL-backed `?book=` selector sits in the card header and drives
tiles and chart together; the current month carries a "month to date" badge
(`currentMonth()` helper) because its KDP side is incomplete. Units are
counts, so summing across books and markets needs no FX conversion.

## Daily profit card

The **Organic data** tab leads with the "Daily profit — ads + organic" card
(`DailyProfitCard` inline in `src/routes/kdp-history.tsx`, chart in
`src/components/kdp-daily-profit-chart.tsx`): one calendar month of per-day
profitability from `useKdpDailyProfit(month, book)` (key
`["kdp-daily-profit", month, book ?? null]` → `GET /api/kdp/daily-profit`).
Stacked bars show the royalty split — estimated ad-attributed (`#a078ff`)
and real organic (`#34d399`, per day `max(0, total − ad)`, the same clamp as
the sales mix) — against the day's ad spend (red line) and a cumulative
profit line (`#d0bcff`, built client-side by `buildDailyProfitPoints`). All
figures are all-markets money converted per day into the workspace display
currency — the endpoint owns the FX conversion (same USD-pivot convention
as `country=all` on the summary) and can answer `ratesAvailable: false`
(empty state) or 409 `FX_RATES_INCOMPLETE`. profit = real KDP royalty −
spend needs no book economics; only the ad/organic split does (missing
economics drop the split with a footnote, profit stays). A month without a
KDP import shows the estimated ad side only, footnoted. The URL-backed
`?month=` selector (first-of-month ISO, validated in `src/router.tsx`) sits
in the card header; options are the imported months plus the current one
(default current, which shows the ad side only until its report lands), and
the page's `?book=` selector filters the card too.

## Settings page

`src/routes/settings.tsx` is split into five URL-backed tabs
(`?tab=profiles|books|kdp|asins|audit`, validated in `src/router.tsx`):
profiles & sync, books & economics, KDP imports, new-ASIN identification,
and the audit log. The KDP imports tab is the operational surface for the
KDP royalty import: the same **Import from KDP report** button as on Books &
economics, plus the read-only import log (period, file, row and suggestion
counts, Applied/Not applied status, imported date) — rows do not link to a
batch review because `GET /api/kdp/imports` returns summaries only. The card
is also a drop zone (`KdpDropZone` in
`src/components/kdp-royalty-import.tsx`): dragging a Royalties Estimator
.xlsx anywhere onto it imports the file, same as the button.
Tab badges surface outstanding setup work (unconfigured economics, new
ASINs). The profiles tab leads with the Workspace card (display currency plus
the FX rates status row and its **Sync rates now** manual trigger — see the
FX section above) and carries the **Excluded search terms** card: the
workspace's persistent exclusion list (`useSearchTermExclusions`) with a
per-term remove (`useDeleteSearchTermExclusion`). Removing a term deletes
only the list entry — negatives already applied on Amazon stay, and open
exclusion drafts are unaffected. Books that still need setup auto-expand;
each market's economics edit in a single table row, with the effective-from
date and notes behind the row's **Details** toggle, and market linking
behind the collapsed **Link another market** section.

The Books & economics card header carries **Import from KDP report**
(`src/components/kdp-royalty-import.tsx`): the owner picks a KDP Royalties
Estimator .xlsx, `src/lib/kdp-report.ts` parses it in the browser
(`read-excel-file`) into the canonical JSON payload, and the review section
shows the derived royalty-per-copy suggestions with per-row checkboxes (low
evidence and >15% deviation are badge-flagged; books without economics are
disabled), the skipped-row reasons, and an effective-from date. Apply goes
through `useApplyKdpRoyaltyImport` and only ever changes royalty per sale.
The same button plus the import log also live on the KDP imports tab (above).

## KDP history page

`src/routes/kdp-history.tsx` (`/kdp-history`, sidebar "KDP history" between
Negatives and Spend) is the analytics surface for KDP royalty
imports (phase 2 of `docs/kdp-royalty-import-plan.md`, decision 10). The page
is split into four URL-backed tabs (`?tab=organic|royalty|fulfillment|transactions`,
validated in `src/router.tsx`, same tab-bar idiom as Settings; bare
`/kdp-history` lands on `organic`):

- **Organic data** — the Daily profit card (see its section above) plus the
  Total sales card: monthly ad-vs-organic unit sales as stat tiles plus a
  full-history stacked bar chart. The URL-backed `?book=` selector drives
  both cards; `?month=` picks the daily-profit month.
- **Royalty trend** — the royalty-per-sale trend (one line per book × market,
  each labeled with its own currency — lines are never converted or summed)
  rendered as gradient areas with the y-axis zoomed to the data range,
  compact legend chips, and a latest-value stat tile per series with the
  month-over-month delta.
- **Fulfillment** — median and average order→ship days per marketplace,
  standard-rate sales only.
- **Individual sales** — the transaction browser (book/marketplace/month
  filters plus a computed ship-lag column).

Months on this page are **KDP report months** — the month of `royalty_date`,
matching the KDP dashboard's own display (an order placed July 31 whose
royalty posted August 2 counts as August). The Daily profit card follows the
same convention, summing royalty per royalty posting date; the only
exception is the Fulfillment card, which groups the order→ship lag by order
month.

The empty state (no KDP imports at all) replaces the tabs and links to
Settings.

Data comes from `useKdpHistory` (key `["kdp-history"]` →
`GET /api/kdp/history`), `useKdpSaleTransactions` (key
`["kdp-sale-transactions", bookId, profileId, month, page]` →
`GET /api/kdp/transactions`), and `useKdpDailyProfit` (key
`["kdp-daily-profit", month, book ?? null]` → `GET /api/kdp/daily-profit`). The transaction browser is server-side
paginated at `KDP_SALES_PAGE_SIZE` (50) rows: the hook sends
`limit`/`offset`, the API answers `{ transactions, total }`, and the card
renders Previous/Next controls once the filtered total exceeds one page —
changing any filter resets to page 0. Ad units are computed at query time from
advertised-product facts via the linked ASIN — never snapshotted — so a
re-synced ad account rewrites the mix. The import create/apply mutations
invalidate all three keys.

## Spend explorer page

`src/routes/spend.tsx` (`/spend`, sidebar "Spend" between KDP history and
Change center) shows where the ad money goes, in three URL-backed tabs
(`?tab=composition|movers|map`, validated in `src/router.tsx`, same tab-bar
idiom as KDP history; bare `/spend` lands on `composition`). A shared toolbar
carries the breakdown grain (`?grain=market|campaign|searchTerm`, default
`campaign` — hidden on the map tab, which builds its own hierarchy), the
`TimeframeSelect` (30-day default), and a `CountrySelect` with "All markets"
gated on FX rates like the overview. The page does not use the `books`
product filter.

Data comes from `useSpendBreakdown` (key
`["spend-breakdown", grain, days, country, currency]` →
`GET /api/spend/breakdown`) and `useSpendTree` (key
`["spend-tree", days, country, currency]` → `GET /api/spend/tree`); only the
active tab's query is enabled. The breakdown response carries the top 12
entities with zero-filled per-day series, an `other` fold, and
previous-window spend per entity; the tree response is a two-level
market → campaign (`country=all`) or campaign → search-term hierarchy with
children capped at 10 plus an "Other" fold. Both honor the summary's
country/currency conventions (`country=all` converts per fact date), so the
workspace display-currency PATCH invalidates both keys.

Tab views: Composition (`src/components/spend-composition.tsx`) is a
100%-stacked Recharts AreaChart (`stackOffset="expand"`) of daily spend
share, top 8 entities plus a gray "Everything else" band; Movers
(`src/components/spend-movers.tsx`) buckets the daily series into ISO weeks
client-side (`src/lib/spend.ts` — tested in `src/lib/spend.test.ts`) for a
weekly rank bump chart and a this-vs-previous table with 14-day sparklines
and New/Rising/Fading/Stable badges (±10% threshold), and replaces its
content with a notice under 14 days; Spend map
(`src/components/spend-treemap.tsx`) is a Recharts Treemap sized by spend
and colored by ACoS bucket (<30% green, 30–60% amber, >60% or null red),
and clicking a campaign node navigates to `/campaigns/$id`.

## New-campaign wizard

`src/routes/campaign-new.tsx` is the multi-step wizard, entered from
"+ New campaign" on `/campaigns`: pick markets (enabled profiles),
campaign/ad-group settings, a book with per-market ASINs, then keywords, and
submit one draft change set per market via
`POST /api/campaign-creation-change-sets`.

Entering a keyword or ASIN product target switches the campaign to MANUAL
targeting automatically. This is not a UX preference: Amazon rejects manual
targeting clauses in AUTO campaigns and creates the default auto targets itself,
so an AUTO campaign must submit no keywords or targets at all.

The Book step lists books that already have a marketplace ASIN in every
selected market. Catalog books missing a selected market are offered below
the dropdown so the owner can confirm the ASIN and `POST
/api/books/:bookId/profile-links` without leaving the wizard. That write is
local catalog only; Amazon still validates the ASIN when the draft is
applied. Settings has the same “Add to …” control. Do not invent a UK (or
any) listing — KDP enrollment stays outside the app.

The cannibalization resolution screen
(`src/components/cannibalization-resolution.tsx`) offers "Create a new campaign"
as a destination. It links here with `recommendationId` / `searchTerm` /
`country` search params (validated in `src/router.tsx`) that prefill the market,
campaign name, MANUAL targeting, and the term as an EXACT keyword, and are
submitted as `cannibalization.recommendationId` on the payload.

## Recommendation resolution screens

`src/routes/recommendation-detail.tsx` renders the generic finding layout and
branches by type: `cannibalization_conflict` to
`src/components/cannibalization-resolution.tsx`, `high_ctr_poor_conversion` to
`src/components/conversion-resolution.tsx`.

Never print `recommendation.campaignId` — it is an internal database row id
that matches nothing in Amazon and cannot address `/campaigns/$id`. Use
`recommendation.campaign` (Amazon id, name, state) through
`src/components/campaign-link.tsx`, which both the list and the detail page use.

The conversion screen is fed by
`GET /api/recommendations/:id/conversion-context` and offers four responses,
because this finding has no single Amazon write: the listing checklist with
"remind me in 30 days" (`snoozeDays` on the reject endpoint), drafting negatives
for zero-order shopper terms that are not already excluded, the embedded
`CampaignMaxCpc` prefilled with `metrics.suggestedMaxCpc`, and a confirmed pause
via `useUpdateCampaignState` with the usual `ReauthDialog` wiring. Only the
pause writes immediately; negatives and the CPC ceiling go to Change center as
drafts.

## Campaign detail header and guarded actions

`src/components/campaign-header.tsx` orders the header in four tiers: a
truncating title (flag, name, state badge) with the date-range selector; a
bordered toolbar pairing the profit verdict and amount with the guarded actions;
then window, freshness, market, currency, and profile as small print (the
profile id is shortened, with the full value in a `title` tooltip).

It takes the actions as a `controls` slot. The page fills it with
`src/components/campaign-controls.tsx`: pause/enable and rename, each drafting
and immediately applying a `campaign_update` change set via
`POST /api/campaigns/:campaignId/state` or `/name`.

Amazon has no campaign delete — only terminal `ARCHIVED` — and the app
deliberately does not expose it.

Breakdown tabs on `src/routes/campaign-detail.tsx` include **Negative
products** (`negativeTargets`): campaign- and ad-group-level `ASIN_SAME_AS`
exclusions from structure sync, with an Amazon retail link per ASIN. Do not
route that tab through `MetricsTable`. The active tab is URL-backed
(`?tab=`, validated in `src/router.tsx`) — see the Re-authentication section
for why.

The **Targets** tab uses its own `TargetsTable` (not `MetricsTable`): the
read side derives each row's identity from the stored `targets.expression` —
keyword text with a `Keyword · <match type>` badge, the ASIN for product
targets (leading with the catalog book title when the ASIN is one of the
owner's books, plus an Amazon retail link), and an "Auto · …" label for
automatic predicates — and carries the synced `bid` as its own column.

The **Search terms** tab adds a per-row **Exclude** action
(`src/components/exclude-search-term.tsx`, a `MetricsTable` `renderAction`
cell shown only while the campaign is not archived): one click drafts a
campaign-level negative exact for the term — a negative ASIN target when the
term is an ASIN — via `useCreateCampaignNegatives`, then links to Change
center for review and apply. Terms an enabled synced negative already blocks
(keyword text case-insensitively, ASINs uppercased, from the detail payload's
`negativeKeywords`/`negativeTargets`) render as "Excluded" with no action.

**Exclude everywhere** (`src/components/exclude-search-term-global.tsx`) is
the persistent, all-market action: a per-row action on the `/search-terms`
and `/negatives` lists and the header control on search-term and keyword
negative detail pages. It confirms,
then POSTs `/api/search-terms/:term/exclusion` via
`useCreateSearchTermExclusion` — recording the term in the workspace
exclusion list and drafting one negatives change set per market for the
enabled campaigns that actually served the term (trailing-30-day
search-term facts) and do not already block it — and links to Change center
for review and apply. Those pages fetch `useSearchTermExclusions`; a term
already on the list renders an "Excluded everywhere" badge with no action.
The single-market `POST /api/search-terms/:term/negatives` route still
exists (its `useCreateSearchTermNegatives` hook remains) but no longer has a
UI entry point.

`/negatives` (`src/routes/negatives.tsx`) is the workspace inventory of synced
negative keywords and product ASINs. A Blocking count of 0 always means the
negative is dormant — carried only by paused campaigns or paused negatives —
so the cell adds a **Paused** badge with that explanation (the API's
`pausedCampaignCount` disambiguates it), and the **dormant** insight chip
filters to rows where nothing blocks and nothing serves. `/negatives/$kind/$value`
(`src/routes/negative-detail.tsx`, `kind` is `keyword` | `product`) is the
working view: search-term evidence for that value plus two campaign tables —
"Negative applied on" (campaigns carrying the negative, with a **This term**
column that says Blocking or why not: campaign paused, negative paused, or
partial ad-group coverage) and "Term can still serve on" (campaigns that
served the term in the window with no negative). Re-include uses the existing
`ReincludeNegative` draft path; coverage-gap Exclude uses `ExcludeSearchTerm`.
Amazon does not expose a creation date — `firstSeenAt` is our first sync
(`created_at`) and the UI labels it that way.

## Re-authentication

Spend-changing mutations can fail with `REAUTH_REQUIRED`. Route that failure to
the shared `ReauthDialog` (`src/components/reauth-dialog.tsx`) rather than a
generic error toast: one click emails a magic link carrying the current path as
`next`, and the post-verify redirect lands the user back on the same page. Any
new guarded mutation needs the same wiring.

The dialog also resumes the action it interrupted, because the 15-minute window
is usually spent on the review that precedes an apply, so the gate fires on
almost every real session. `/changes` passes `next="/changes?apply=<id>"` and,
on arrival, expands that set and reopens its confirmation (the write still needs
the click — it is a URL param, not an instruction). `ChangesPage` strips the
param after capturing it so a reload does not ask again. The installed-app paste
flow never navigates, so `onReauthenticated` re-runs the blocked mutation
directly instead.

The campaign detail tabs are URL-backed (`?tab=maxCpc`, validated in
`src/router.tsx` like the Settings and KDP-history tabs) so the magic-link
return lands on the same tab. The embedded `CampaignMaxCpc` goes further: its
`next` adds the typed ceiling (`?maxCpc=`) and an open review (`?draft=<change
set id>`); on arrival it prefills the input, reopens the review, and re-runs an
interrupted "Review ceiling" once the fresh session (and CSRF token) is in
place — drafting only re-reads Amazon state, the write still needs the Apply
click. Both params are captured on mount and stripped from the URL.

A fully expired session takes a different path: `SessionGate` in
`src/components/layout.tsx` redirects to `/login?next=<current path+search>`
(validated on the login route, same same-origin allowlist the API enforces),
`LoginPage` forwards `next` in the login request, and its paste flow reloads to
`next` instead of `/`.
