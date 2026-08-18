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

Overview, campaigns, campaign detail, search terms, and recommendations pass the
selection to their query hooks, and their query keys must include the sorted id
list or the cache will serve another book's numbers. `/changes`, `/settings`,
and `/connect` ignore the filter.

Campaign and search-term list payloads carry `bookIds` (distinct catalog books
linked through ads); those tables and the filter dropdown render cover thumbs
from `GET /api/books`.

## Date ranges

Overview, campaign detail, and search-term detail share
`src/components/timeframe-select.tsx`: 7/14/30/60 days plus month-to-date
(`?days=mtd`, UTC 1st of the current month through today). Campaign and
search-term **list** pages deliberately hardcode a 30-day profitability window
and have no selector.

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

The cannibalization resolution screen
(`src/components/cannibalization-resolution.tsx`) offers "Create a new campaign"
as a destination. It links here with `recommendationId` / `searchTerm` /
`country` search params (validated in `src/router.tsx`) that prefill the market,
campaign name, MANUAL targeting, and the term as an EXACT keyword, and are
submitted as `cannibalization.recommendationId` on the payload.

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

## Re-authentication

Spend-changing mutations can fail with `REAUTH_REQUIRED`. Route that failure to
the shared `ReauthDialog` (`src/components/reauth-dialog.tsx`) rather than a
generic error toast: one click emails a magic link carrying the current path as
`next`, and the post-verify redirect lands the user back on the same page. Any
new guarded mutation needs the same wiring.
