---
title: HTTP API Reference
description: Complete reference for the amazon-king REST API — authentication, CSRF, rate limits, and every endpoint with request and response schemas.
---

# HTTP API Reference

The API is served by the `api` process (Fastify). In the production compose
stack it sits behind the bundled web proxy, so all endpoints are **same-origin
with the dashboard**. In local development the API listens on
`http://localhost:3000` and the Vite dev server proxies `/api` to it.

## Conventions

### Authentication

Sign-in is passwordless email (Login A). A successful verify sets an
`ak_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` outside development,
~7 day rolling expiry). Every endpoint except `GET /api/health` and the login
start/verify pair requires this cookie; a missing or expired session returns
`401 UNAUTHENTICATED`.

The Amazon OAuth connection (Login B) is a separate flow — the session never
contains an Amazon token and the browser never talks to the Amazon Ads API
directly.

### CSRF

Every `POST`, `PATCH`, and `DELETE` under `/api` requires the
`x-csrf-token` header carrying the per-session token returned by
`GET /api/session` (`csrfToken`). The only exemption is
`POST /api/session/login` (no session exists yet). A missing or mismatched
token returns `403 CSRF_MISMATCH`.

### Recent authentication

Spend-changing actions require a sign-in no older than 15 minutes. Affected
endpoints return `401 REAUTH_REQUIRED` when the session is too old:

- `POST /api/campaigns/:campaignId/max-cpc`
- `POST /api/campaigns/:campaignId/state`
- `POST /api/campaigns/:campaignId/name`
- `POST /api/change-sets/:id/apply` — except when retrying a `failed` change
  set, which replays an already-approved payload through the same guarded path
- `POST /api/change-actions/:actionId/rollback`

Drafting a change set is not gated — `POST /api/recommendations/change-sets`,
`POST /api/recommendations/:id/cannibalization-change-set`, and
`POST /api/campaign-creation-change-sets` only write to the app's own database.
The gate applies at the point spend can change, which is the apply.

### Error envelope

Every non-2xx response has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request failed validation",
    "details": { "issues": [] }
  }
}
```

`details` is optional. See [Errors](/reference/errors) for the full code list.

### Rate limits

Limits are per client, per minute. Exceeding any tier returns
`429 RATE_LIMITED`.

| Tier    | Limit    | Applies to                                                                        |
| ------- | -------- | --------------------------------------------------------------------------------- |
| Global  | 200/min  | Every route without an explicit tier                                              |
| STRICT  | 10/min   | Login start/verify, Amazon OAuth start/callback                                   |
| WRITE   | 20/min   | Sync requests, mappings, cover, cannibalization/max-CPC/creation sets, apply, rollback |
| PREVIEW | 120/min  | `GET /api/change-sets/:id/preview`                                                |

### Request IDs

An `x-request-id` request header is propagated when present, otherwise one is
generated. The value is echoed on every response as `x-request-id` and appears
in server logs.

### Field formats

| Type        | Format                                             | Example        |
| ----------- | -------------------------------------------------- | -------------- |
| Money / bid | String decimal, signed: `/^-?\d+(\.\d{1,4})?$/`    | `"12.3400"`    |
| Money (non-negative) | `/^\d+(\.\d{1,4})?$/`                     | `"0.45"`       |
| Date        | `YYYY-MM-DD`                                       | `"2026-08-01"` |
| Timestamp   | ISO 8601 with timezone offset                      | `"2026-08-16T15:49:56.726Z"` |
| Currency    | ISO 4217, `/^[A-Z]{3}$/`                           | `"USD"`        |

Monetary values are always string-encoded decimals; floating point never
appears in payloads. Values are never aggregated across currencies — mixing
currencies in one view returns `409 MIXED_CURRENCY`.

---

## Health

| Method | Path          | Auth | Response            |
| ------ | ------------- | ---- | ------------------- |
| GET    | `/api/health` | none | `{ "status": "ok" }` |

---

## Session

### `POST /api/session/login`

Starts the passwordless email flow. Always returns 200, even for unknown
emails, so the endpoint never reveals whether an address is allowed.

- **Auth:** none (CSRF-exempt). **Rate:** STRICT.

| Field  | Type   | Constraints                                             |
| ------ | ------ | ------------------------------------------------------- |
| email  | string | Valid email address                                     |
| next   | string | Optional. Same-origin path `/^\/[^/\\]/`, max 500 chars; the post-verify redirect lands here |

Response `200`:

```json
{ "ok": true }
```

In development, when SMTP is not configured, the magic link is also returned
as `devLoginUrl` and logged; with SMTP configured the link is only emailed.

### `GET /api/session/verify?token=`

Completes login. Not a JSON endpoint.

- **Auth:** none. **Rate:** STRICT.
- Success: `302` to the web origin (plus the `next` path when one was stored
  at login start), setting the `ak_session` cookie.
- Failure: `302` to `{WEB_ORIGIN}/login?error=invalid_token`.

### `POST /api/session/logout`

- **Auth:** session + CSRF.
- Response `204`; clears the cookie and invalidates the session server-side.

### `GET /api/session`

Returns the current session and a fresh CSRF token.

```json
{
  "userId": "1",
  "workspaceId": "1",
  "email": "owner@example.com",
  "expiresAt": "2026-08-23T15:49:56.726Z",
  "csrfToken": "..."
}
```

---

## Amazon connection (OAuth)

### `POST /api/integrations/amazon/start`

- **Auth:** session + CSRF. **Rate:** STRICT.
- Response `200`: `{ "url": "https://www.amazon.com/ap/oa?..." }` — navigate
  the browser to `url` to authorize the `advertising::campaign_management`
  scope. State is single-use and expires after 10 minutes.

### `GET /api/integrations/amazon/callback?state&code`

OAuth redirect target (`AMAZON_REDIRECT_URI` must point here). Not a JSON
endpoint.

- **Auth:** session cookie if present (its absence becomes a redirect error).
  **Rate:** STRICT.
- Success: `302` to `{WEB_ORIGIN}/connect?connected=1`.
- Failure: `302` to `{WEB_ORIGIN}/connect?error=<code>` with one of
  `invalid_callback`, `invalid_state`, `session_required`, `foreign_state`,
  `exchange_failed`, `profile_discovery_failed` (see
  [Errors](/reference/errors#oauth-redirect-errors)).

### `GET /api/integrations/amazon/status`

```json
{
  "status": "connected",
  "grantedAt": "2026-08-01T10:00:00.000Z",
  "lastErrorCode": null
}
```

`status` is `connected`, `reconnect_required`, or `disconnected`.

### `POST /api/integrations/amazon/disconnect`

- **Auth:** session + CSRF.
- Response `204`. Removes the stored (encrypted) refresh token and marks the
  connection disconnected.

---

## Profiles & syncs

### `GET /api/profiles`

Returns every Amazon Ads profile mirrored into the workspace:

| Field        | Type                         | Notes                                   |
| ------------ | ---------------------------- | --------------------------------------- |
| profileId    | string                       | Amazon profile id, used in paths        |
| accountId    | string \| null               | Amazon account entity id                |
| region       | `"NA" \| "EU" \| "FE"`       |                                         |
| countryCode  | string                       | e.g. `"US"`                             |
| currencyCode | string                       | ISO 4217                                |
| timezone     | string \| null               |                                         |
| accountType  | string \| null               |                                         |
| enabled      | boolean                      | Included in syncs and dashboards        |
| writeEnabled | boolean                      | Owner opt-in for guarded writes         |

### `PATCH /api/profiles/:profileId`

- **Auth:** session + CSRF.

| Field        | Type    | Required |
| ------------ | ------- | -------- |
| enabled      | boolean | no       |
| writeEnabled | boolean | no       |

Response `200`: the updated profile (same shape as `GET /api/profiles` rows).
`404 NOT_FOUND` for an unknown profile.

### `POST /api/profiles/:profileId/syncs`

Requests a manual sync. The work runs in the worker, never in the request: a
`structure_sync` job plus a `metrics_sync` job covering the trailing 60
complete UTC days are enqueued.

- **Auth:** session + CSRF. **Rate:** WRITE.
- Response `200`: a SyncRun (below).
- Errors: `409 PROFILE_DISABLED` when the profile is not enabled,
  `404 NOT_FOUND` for an unknown profile.

### `GET /api/syncs/:syncId`

Response `200`: SyncRun; `404 NOT_FOUND` when unknown.

| Field      | Type                                   |
| ---------- | -------------------------------------- |
| id         | string                                 |
| profileId  | string (Amazon profile id)             |
| kind       | `"structure" \| "metrics" \| "backfill"` |
| status     | string (`running`, `complete`, `failed`, …) |
| startedAt  | timestamp                              |
| finishedAt | timestamp \| null                      |
| error      | string \| null                         |

---

## Dashboard & metrics

All endpoints here take a shared `days` query parameter: integer 1–90
(trailing inclusive UTC days, default `30`) or the sentinel `mtd` (calendar
month-to-date: 1st of the current UTC month through today). They also accept a
shared `books` query parameter: a
comma-separated list of book ids (e.g. `?books=3,7`) restricting the view to
ad groups that advertise any of the selected books (union; a multi-book ad
group contributes its whole numbers). Absent or empty means all products. An
unknown book id fails the whole request with `404 NOT_FOUND`.

### `GET /api/dashboard/summary?days&country&books`

`country` is a two-letter country code (`/^[A-Za-z]{2}$/`, upper-cased),
default `US`.

Response `200` (DashboardSummary):

| Field              | Type              | Notes                                              |
| ------------------ | ----------------- | -------------------------------------------------- |
| dateRange          | `{start, end}`    | ISO dates                                          |
| currency           | string            |                                                    |
| totals             | object            | `impressions`, `clicks`, `orders` (ints); `cost`, `sales` (money); `acos` (number \| null); `estimatedRoyalty`, `estimatedAdProfit` (money \| null) |
| economicsMissing   | boolean           | True when no KDP economics exist for the view      |
| dataCurrentThrough | timestamp         |                                                    |
| writesDisabled     | boolean, optional | Kill switch on, or every profile read-only         |
| daily              | array, optional   | Per-day `{date, cost, sales, orders, estimatedRoyalty}` series |
| previous           | object            | `{dateRange, totals}` for period-over-period: trailing windows use the immediately preceding same-length range; `days=mtd` uses the same day-of-month range in the previous calendar month (clamped if that month is shorter) |

Errors: `409 MIXED_CURRENCY` when the selected window spans currencies.

### `GET /api/campaigns?days&books`

Response `200`: array of campaign rows.

| Field            | Type           | Notes                                                    |
| ---------------- | -------------- | -------------------------------------------------------- |
| profileId        | string         |                                                          |
| campaignId       | string         | Amazon campaign id — the key for all campaign routes     |
| name, state      | string         |                                                          |
| totals           | object         | `impressions`, `clicks`, `cost`, `sales`, `orders`       |
| amazonConsoleUrl | string \| null | Campaign Manager link; null when no account id on file   |
| bookIds          | string[]       | Distinct catalog books advertised by the campaign; empty if unmapped |
| profitability    | object         | `{dateRange, currency, estimatedRoyalty, estimatedAdProfit, economicsMissing, dataCurrentThrough}`; money fields null when economics are missing |

### `GET /api/campaigns/:id?days&books`

Response `200` (CampaignDetail); `404 NOT_FOUND` when unknown.

| Field            | Type      | Notes                                                              |
| ---------------- | --------- | ------------------------------------------------------------------ |
| dateRange        | object    | `{start, end}`                                                     |
| currency         | string    |                                                                    |
| campaign         | object    | List row plus `acos`, `estimatedRoyalty`, `estimatedAdProfit` in `totals` |
| economicsMissing | boolean   |                                                                    |
| dataCurrentThrough | timestamp |                                                                  |
| daily            | array     | Per-day `{date, cost, sales, estimatedRoyalty, estimatedAdProfit}` |
| adGroups         | array     | `{id, name, state, totals}`                                        |
| targets          | array     | Same shape                                                         |
| searchTerms      | array     | Same shape plus `estimatedRoyalty`, `estimatedAdProfit`, `economicsMissing` per term |
| negativeKeywords | array     | `{id, keywordText, matchType, level: "campaign" \| "ad_group", adGroupId, adGroupName, state}` |

---

## Search terms

Cross-campaign views over shopper search terms. Royalty and profit fields are
null — never guessed — when book economics are missing.

### `GET /api/search-terms?days&books`

| Param | Type   | Notes                                  |
| ----- | ------ | -------------------------------------- |
| days  | int \| `"mtd"` | 1–90 (default 30), or `mtd` for UTC month-to-date |
| books | string | Optional comma-separated book ids; restricts the aggregate to ad groups advertising any of them (union semantics) |

Response `200`: array of rows — `{searchTerm, campaignCount, countryCodes[],
currency, totals (with acos), estimatedRoyalty, estimatedAdProfit,
economicsMissing, dataCurrentThrough, bookIds[]}`. `bookIds` are the distinct
catalog books whose ad groups contributed to the term (empty if unmapped).

### `GET /api/search-terms/:term?days&books&country`

Per-term drill-down. `country` (two-letter code) selects the marketplace view.

Response `200` (SearchTermDetail); `404 NOT_FOUND` when the term has no data.

| Field                 | Type   | Notes                                            |
| --------------------- | ------ | ------------------------------------------------ |
| searchTerm            | string |                                                  |
| countryCode           | string | Marketplace selected for this view               |
| availableCountryCodes | string[] | Markets with data in the window (min 1)        |
| dateRange, currency, totals, economicsMissing, dataCurrentThrough | — | As dashboard |
| daily                 | array  | Per-day `{date, cost, sales, estimatedRoyalty, estimatedAdProfit}` for the trend chart, in the selected market |
| campaigns             | array  | Per-campaign `{profileId, campaignId, name, state, totals, estimatedRoyalty, estimatedAdProfit, economicsMissing}` |

Errors: `409 MIXED_CURRENCY` when aggregating across currencies.

---

## Books & economics

### `GET /api/books`

Response `200`: array of books — `{id, asin, title, format, status,
coverImageUrl | null, profileIds[], marketplaceAsins: [{profileId, asin}],
economics: [...]}`. Each economics entry has `profileId`, `effectiveFrom`
(date), `currency`, `listPrice`, `estimatedRoyaltyPerSale`, `targetAcos`
(0–1 fraction or null), `goalMode`, `maxSpendWithoutSale`, `maxBid`,
`maxDailyBudget`, `notes`.

### `GET /api/books/unmapped-products`

Response `200`: array of advertised ASINs not yet linked to the catalog —
`{profileId, asin, countryCode, currencyCode, adCount}`.

### `POST /api/books/mappings`

Confirms catalog metadata and links an advertised ASIN to one or more
profiles.

- **Auth:** session + CSRF. **Rate:** WRITE.
- Response `201`: the created/updated book.

| Field         | Type     | Constraints                                          |
| ------------- | -------- | ---------------------------------------------------- |
| profileIds    | string[] | 1–100 entries, deduplicated                          |
| asin          | string   | 1–64 chars (trimmed)                                 |
| title         | string   | 1–500 chars (trimmed)                                |
| format        | enum     | `paperback`, `hardcover`, `kindle`, `other`          |
| coverImageUrl | string   | Optional URL, max 2048 chars                         |

### `POST /api/books/:bookId/economics`

Sets user-entered KDP royalty economics (effective-dated).

- **Auth:** session + CSRF.
- Response `204`.

| Field                   | Type           | Constraints                              |
| ----------------------- | -------------- | ---------------------------------------- |
| profileId               | string         | Profile this economics row applies to    |
| effectiveFrom           | date           | `YYYY-MM-DD`                             |
| currency                | string         | ISO 4217                                 |
| listPrice               | money (≥0)     |                                          |
| estimatedRoyaltyPerSale | money (≥0)     | Royalty per attributed sale              |
| targetAcos              | number \| null | 0–1 fraction                             |
| goalMode                | enum           | `profit`, `balanced`, `launch`, `visibility` |
| maxSpendWithoutSale     | money (≥0)     | Optional                                 |
| maxBid                  | money (≥0)     | Optional                                 |
| maxDailyBudget          | money (≥0)     | Optional                                 |
| notes                   | string         | Optional                                 |

Errors: `409 BOOK_PROFILE_NOT_LINKED` when the book is not linked to the given
profile.

### `PUT /api/books/:bookId/cover`

- **Auth:** session + CSRF. **Rate:** WRITE.
- Body: `{ "coverImageUrl": "https://…" }` or `null` to clear (URL, max 2048
  chars).
- Response `204`.

---

## Recommendations

### `GET /api/recommendations?type&state&books`

| Param | Type | Values                                                                                                            |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| type  | enum | `wasteful_search_term`, `expensive_target`, `profitable_target`, `search_term_harvest`, `budget_constrained_winner`, `high_ctr_poor_conversion`, `low_impressions`, `placement_opportunity`, `cannibalization_conflict` |
| state | enum | `pending`, `approved`, `rejected`, `expired`, `applied`, `protected`                                               |
| books | string | Optional comma-separated book ids; keeps findings whose campaign/ad group advertises any of them |

Response `200`: array of Recommendation:

| Field                            | Type              | Notes                                     |
| -------------------------------- | ----------------- | ----------------------------------------- |
| id, type, state                  | string / enums    |                                           |
| priority                         | int 1–5           | 1 = highest impact                        |
| profileId, campaignId, adGroupId, targetId | string \| null | Entity grain depends on the rule; these are internal row ids |
| campaign                         | object \| null    | `{campaignId, name, state}` — the **Amazon** campaign id, for display and links |
| searchTerm                       | string \| null    |                                           |
| currentValue, proposedValue      | money \| null     | Null for diagnostics and negative keywords |
| rationale                        | string            | Human-readable explanation                |
| confidence                       | number 0–1        |                                           |
| evidenceWindow                   | `{start, end}`    | ISO dates                                 |
| dataFreshness, expiresAt, createdAt | timestamp      |                                           |
| ruleVersion                      | string            | e.g. `expensive_target@2`                 |

### `GET /api/recommendations/:id`

Response `200`: one Recommendation. `404 NOT_FOUND` when unknown.

### `GET /api/recommendations/:id/cannibalization-context`

Evidence for resolving one `cannibalization_conflict` finding.

Response `200`: `{recommendationId, profileId, searchTerm, currency,
confidence, evidenceWindow, dataFreshness, expiresAt, totalSpend, campaigns}`
where `campaigns` (min 2) holds `{campaignId, name, state, targetingType,
spend, orders}` — Amazon campaign ids, never internal keys. `404 NOT_FOUND`
when unknown.

### `GET /api/recommendations/:id/conversion-context`

Everything needed to act on one `high_ctr_poor_conversion` finding.

Response `200`: `{recommendationId, profileId, countryCode, currency,
confidence, evidenceWindow, dataFreshness, expiresAt, campaign, metrics,
books, wastefulTerms}` where:

| Field | Notes |
| --- | --- |
| campaign | `{campaignId, name, state, targetingType, amazonConsoleUrl, writeEnabled}` — Amazon campaign id, never an internal key |
| metrics | `{impressions, clicks, orders, ctr, cvr, spend, averageCpc, suggestedMaxCpc}` from `recommendation_evidence.inputs` |
| books | `{bookId, title, asin, coverImageUrl}` per book the campaign's ads map to; empty when none is mapped |
| wastefulTerms | Up to 20 `{searchTerm, impressions, clicks, orders, spend}` with clicks and zero orders, highest spend first |

`suggestedMaxCpc` is a display suggestion — a cut below the observed average
CPC — not a computed break-even bid, which would require a conversion rate.

Errors: `404 NOT_FOUND`, `409 INVALID_RECOMMENDATION_TYPE` (not a conversion
finding), `409 INCOMPLETE_EVIDENCE` (evidence or campaign missing; re-sync).

### `POST /api/recommendations/:id/reject`

- **Auth:** session + CSRF.
- Body (optional): `{ "snoozeDays": 30 }` — 1–365. Shortens the default
  60-day dismissal suppression, so the finding returns sooner.
- Response `200`: the Recommendation in state `rejected`. `404 NOT_FOUND`
  when unknown.

### `POST /api/recommendations/change-sets`

Drafts one immutable change set from selected recommendations.

- **Auth:** session + CSRF.
- Body: `{ "recommendationIds": ["…"] }` (array, min 1, deduplicated).
- Response `200`: the created ChangeSet `{id, profileId, status, createdAt,
  kind, dependsOnChangeSetId}`.
- Errors: `400 BAD_REQUEST` (empty list), `409 INVALID_STATE` (recommendation
  not pending), `409 RECOMMENDATION_EXPIRED`, `409 RECOMMENDATION_NOT_WRITABLE`
  (advisory-only type, or a profile whose writes are off),
  `409 TOO_MANY_ACTIONS` (more than 20 actions).

Only three recommendation types are writable in the MVP:
`wasteful_search_term` → `add_negative_exact`, `expensive_target` →
`update_bid`, `profitable_target` → `update_bid`. All others are advisory and
cannot enter a change set.

### `POST /api/recommendations/:id/cannibalization-change-set`

Resolves a cannibalization finding by drafting negative-exact keywords (or a
negative ASIN target when the term is an ASIN) in the conflicting campaigns,
keeping `destinationCampaignId` as the surviving target.

- **Auth:** session + CSRF. **Rate:** WRITE.
- Body: `{ "destinationCampaignId": "…" }`.
- Response `200`: the created ChangeSet.
- Errors: `409 INVALID_RECOMMENDATION_TYPE` (not a cannibalization finding),
  plus the recommendation state errors above.

---

## Campaign negatives

### `POST /api/campaigns/:campaignId/negatives`

Blocks shopper terms in one campaign. Offered by the conversion resolution
screen, but campaign-scoped rather than finding-scoped.

- **Auth:** session + CSRF. **Rate:** WRITE. No recent-auth gate — drafting
  sends nothing to Amazon; the apply in Change center keeps the gate.
- Body: `{ "searchTerms": ["tractor colouring book"] }` — 1–50 terms, trimmed
  and deduplicated case-insensitively (Amazon matches negatives that way).
- Response `200`: the created draft ChangeSet. Each term becomes a
  campaign-level `add_negative_exact`, or `add_negative_target` when the term
  is an ASIN. Re-submitting the same terms replays the existing set.
- Errors: `404 NOT_FOUND` (unknown campaign), `400 BAD_REQUEST` (no usable
  terms).

---

## Campaign Max CPC

### `GET /api/campaigns/:campaignId/max-cpc`

Response `200` (CampaignMaxCpc):

| Field                                        | Type            | Notes                                             |
| -------------------------------------------- | --------------- | ------------------------------------------------- |
| campaignId, profileId, currency              | string          |                                                   |
| maxCpc                                       | money (≥0) \| null | Configured ceiling                             |
| status                                       | enum            | `not_configured`, `pending`, `covered`, `drifted`, `unsupported` |
| strategy                                     | enum \| null    | `LEGACY_FOR_SALES`, `AUTO_FOR_SALES`, `MANUAL`, `RULE_BASED` |
| adjustments                                  | array           | `{type: "placement" \| "audience", name, percentage}` |
| activeBidRules                               | array           | `{id, name, category, subcategory, status}`       |
| coverageIssues                               | string[]        | Why the campaign is not `covered`                 |
| currentMaxBaseBid, currentMaxAdjustedBid     | money \| null   |                                                   |
| counts                                       | object          | `{adGroups, explicitTargetBids, bidsAboveCeiling}` |
| writeEnabled                                 | boolean         |                                                   |
| sourceReadAt, enforcedAt                     | timestamp \| null |                                                 |

### `POST /api/campaigns/:campaignId/max-cpc`

Drafts a change set that enforces the ceiling (clamps base bids, switches the
bidding strategy to `LEGACY_FOR_SALES`, neutralizes placement/audience
adjustments and bid rules).

- **Auth:** session + CSRF + **recent-auth**. **Rate:** WRITE.
- Body: `{ "maxCpc": "0.85" }` — non-negative decimal, must be greater than 0.
- Response `200`: `{changeSet, controls, actionsCreated}` (`controls` is the
  CampaignMaxCpc shape above).
- Errors: `403 WRITES_DISABLED` (kill switch or read-only profile),
  `409 TOO_MANY_ACTIONS` (campaign has more than 5,000 bid controls),
  `401 REAUTH_REQUIRED`.

---

## Campaign state & rename

One-click guarded updates from the campaign detail page. Each call drafts a
single-action `campaign_update` change set (`update_campaign_state` /
`update_campaign_name`) and immediately runs the guarded apply (fresh Amazon
re-read, before-state compare, guardrails, post-write verification); the
verified change is written through to the local mirror. Both action types are
rollbackable (the before-state is restored). There is no campaign delete:
Amazon only offers terminal `ARCHIVED`, which the app deliberately does not
expose.

### `POST /api/campaigns/:campaignId/state`

- **Auth:** session + CSRF + **recent-auth**. **Rate:** WRITE.
- Body: `{ "state": "enabled" | "paused" }`.
- Response `200`: `{changeSet, actions}` (the applied set).
- Errors: `403 WRITES_DISABLED`, `404 NOT_FOUND` (unknown campaign),
  `409 STALE_BEFORE_STATE` (campaign state changed on Amazon since the last
  sync; the set is `blocked`), `401 REAUTH_REQUIRED`.

### `POST /api/campaigns/:campaignId/name`

- **Auth:** session + CSRF + **recent-auth**. **Rate:** WRITE.
- Body: `{ "name": "…" }` — trimmed, 1–128 chars.
- Response `200`: `{changeSet, actions}` (the applied set).
- Errors: same as above.

---

## Campaign creation

### `POST /api/campaign-creation-change-sets`

Drafts one `campaign_creation` change set per profile, each holding an ordered
`create_campaign` → `create_ad_group` → `create_product_ad` /
`create_keyword` / `create_target` action chain. Nothing is created on Amazon
until the sets are applied.

- **Auth:** session + CSRF (no recent-auth — the wizard only drafts; the apply
  is gated). **Rate:** WRITE.

| Field                  | Type     | Constraints                                                   |
| ---------------------- | -------- | ------------------------------------------------------------- |
| profileIds             | string[] | Min 1; one change set per profile                             |
| campaign.name          | string   | Min 1 char                                                    |
| campaign.dailyBudget   | money (≥0) |                                                             |
| campaign.targetingType | enum     | `AUTO`, `MANUAL`                                              |
| campaign.startDate     | date     | `YYYY-MM-DD`                                                  |
| campaign.state         | enum     | `enabled` or `paused` (default `paused`)                      |
| adGroup.name           | string   | Min 1 char                                                    |
| adGroup.defaultBid     | money (≥0) |                                                             |
| bookId                 | string   | Provides the per-marketplace ASINs for the product ads        |
| keywords               | array    | `{text, matchType: EXACT\|PHRASE\|BROAD, bid}`; default `[]`  |
| targets                | array    | Optional `{asin, bid?}`; ASIN matches `/^B0[A-Z0-9]{8}$/i`, applied as `ASIN_SAME_AS` product targets |
| cannibalization        | object   | Optional `{recommendationId}` — see below                     |

At least one keyword or product target is required for `MANUAL` campaigns
(`400 VALIDATION_ERROR` otherwise). `AUTO` campaigns must not carry keywords
or product targets at all — Amazon creates the default auto targets itself
and rejects manual targeting clauses in auto campaigns
(`400 VALIDATION_ERROR` when the combination is submitted).

Response `200`: `{ "changeSets": [ChangeSet, …] }`.

When `cannibalization.recommendationId` is set, the API validates the finding
and additionally drafts a `recommendation`-kind change set that adds the term
as a campaign-level negative exact keyword (or negative ASIN target) in every
conflicting campaign, with `dependsOnChangeSetId` pointing at the creation
set. Applying that set before the creation set is `applied` fails with
`409 DEPENDENCY_NOT_APPLIED`, so the term is never blocked everywhere at once.

Errors: `404 NOT_FOUND` (unknown book), `409 BOOK_PROFILE_NOT_LINKED` (book
not linked to a requested profile), `403 WRITES_DISABLED`,
`401 REAUTH_REQUIRED`.

---

## Change sets & guarded writes

### `GET /api/change-sets`

Response `200`: array of ChangeSet `{id, profileId, status, createdAt, kind?,
dependsOnChangeSetId?}`. `status` is one of `draft`, `previewed`, `applying`,
`applied`, `partially_applied`, `failed`, `blocked`; `kind` is one of
`recommendation`, `max_cpc`, `rollback`, `campaign_creation`.

### `GET /api/change-sets/:id/preview`

Re-evaluates guardrails without writing anything; moves `draft` sets to
`previewed`.

- **Auth:** session. **Rate:** PREVIEW.
- Response `200`: `{changeSet, actions, guardrails}` where `guardrails` is an
  array of `"CODE: message"` strings (empty when clean) and each action is a
  ChangeAction (below).

### `POST /api/change-sets/:id/apply`

Executes the guarded write: re-reads Amazon state, compares it against the
recorded before-state, re-runs guardrails, applies each action, and verifies
with a post-write read.

- **Auth:** session + CSRF + **recent-auth** (not required when retrying a
  `failed` set). **Rate:** WRITE.
- Response `200`: `{changeSet, actions}` with per-action results.
- Errors: `403 WRITES_DISABLED` (kill switch or read-only profile),
  `409 APPLY_IN_PROGRESS`, `409 CHANGE_SET_BLOCKED`,
  `409 DEPENDENCY_NOT_APPLIED`, `409 STALE_BEFORE_STATE`,
  `409 GUARDRAIL_VIOLATION`, `409 MAX_CPC_EXCEEDED`,
  `409 RECOMMENDATION_EXPIRED`, `502 AMAZON_APPLY_FAILED`. Individual failed
  actions carry `AMAZON_HTTP_<status>`, `AMAZON_RESPONSE_INVALID`,
  `AMAZON_NETWORK_ERROR`, `PARENT_FAILED`, or `MISSING_RESULT` in their
  result payload (see [Errors](/reference/errors#per-action-failure-codes)).

### `POST /api/change-actions/:actionId/rollback`

Creates and applies a compensating change set (`update_bid` restores the
before bid; `add_negative_exact` removes the verified negative). Rollback is
a compensating Amazon action, never a database undo.

- **Auth:** session + CSRF + **recent-auth**. **Rate:** WRITE.
- Response `200`: `{changeSet, actions}` for the rollback set; on success the
  original action moves to `rolled_back`.
- Errors: `404 NOT_FOUND`, `409 NOT_ROLLBACKABLE` (action not `applied`, or no
  verified compensating operation exists — campaign-creation chains and
  negative ASIN targets are not rollbackable), `403 WRITES_DISABLED`.

ChangeAction shape (preview/apply/rollback responses):

| Field                                             | Type             | Notes                                   |
| ------------------------------------------------- | ---------------- | --------------------------------------- |
| id, changeSetId                                   | string           |                                         |
| actionType                                        | enum             | `update_bid`, `update_ad_group_default_bid`, `update_campaign_bidding`, `update_optimization_rule`, `add_negative_exact`, `remove_negative_exact`, `create_campaign`, `create_ad_group`, `create_product_ad`, `create_keyword`, `create_target`, `add_negative_target` |
| beforeValue, afterValue                           | money \| null    |                                         |
| entityName, searchTerm, campaignName, amazonCampaignId, beforeDetail, afterDetail | string \| null | Optional context         |
| rollbackAvailable                                 | boolean          | Optional                                |
| status                                            | enum             | `pending`, `applied`, `partially_applied`, `failed`, `verification_failed`, `rolled_back` |
| amazonRequestId                                   | string \| null   | For Amazon support traces               |
| errorMessage                                      | string \| null   |                                         |

---

## Audit & system

### `GET /api/audit-events`

Response `200`: the 100 most recent audit events —
`{id, actor, event, entityType, entityId | null, createdAt, details}`.

### `GET /api/system/data-freshness`

Response `200`: per-profile, per-dataset freshness —
`{profileId, dataset, lastSuccessAt | null, completeThrough | null (date)}`.

---

## Related reading

- [Errors](/reference/errors) — every error code and redirect error
- [Examples: API workflows](/examples/api-workflows) — end-to-end call sequences
- [Applying changes](/guide/applying-changes) — the guarded write flow in the UI
- [Security architecture](/architecture/security) — why the browser never sees Amazon tokens
