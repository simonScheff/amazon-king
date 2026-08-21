---
title: Error Codes
description: Every error code returned by the amazon-king API — the error envelope, HTTP status grouping, OAuth redirect errors, and Amazon-side adapter errors.
---

# Error Codes

## Error envelope

Every non-2xx API response carries the same JSON envelope:

```json
{
  "error": {
    "code": "STALE_BEFORE_STATE",
    "message": "…human-readable explanation…",
    "details": {}
  }
}
```

- `code` — stable machine-readable identifier (this page).
- `message` — human-readable explanation; safe to show but not to match on.
- `details` — optional structured context (e.g. zod issues for
  `VALIDATION_ERROR`).

The response also echoes the `x-request-id` header for log correlation.

## 400 — Bad request

| Code               | Meaning | Typical cause | What to do |
| ------------------ | ------- | ------------- | ---------- |
| `BAD_REQUEST`      | The request is malformed beyond schema validation (e.g. an empty `recommendationIds` list). | Client sent a semantically empty request. | Fix the payload; see the endpoint in [API reference](/reference/api). |
| `VALIDATION_ERROR` | The body or query failed its zod schema. `details.issues` holds the zod issue list. | Wrong types, bad money/date format, missing required fields. | Inspect `details.issues`; money is a string decimal `/^-?\d+(\.\d{1,4})?$/`, dates are `YYYY-MM-DD`. |

## 401 — Authentication

| Code              | Meaning | Typical cause | What to do |
| ----------------- | ------- | ------------- | ---------- |
| `UNAUTHENTICATED` | No valid session. | Missing/expired `ak_session` cookie. | Sign in via `POST /api/session/login` + the magic link. |
| `REAUTH_REQUIRED` | The action changes spend and requires a sign-in within the last 15 minutes. | Session is older than the recent-auth window. | Log in again, then retry. Retrying a `failed` change set is exempt. |

## 403 — Forbidden

| Code             | Meaning | Typical cause | What to do |
| ---------------- | ------- | ------------- | ---------- |
| `CSRF_MISMATCH`  | The `x-csrf-token` header is missing or does not match the session-derived token. | Stale session info, or a client that did not echo `csrfToken` from `GET /api/session`. | Fetch `GET /api/session` and send its `csrfToken` on every POST/PATCH/DELETE. |
| `WRITES_DISABLED`| Amazon writes are blocked. | The global kill switch is on (`KILL_SWITCH` not exactly `"false"`), or the profile has `writeEnabled: false`. | Unset the kill switch only after live validation; enable writes per profile via `PATCH /api/profiles/:profileId`. |

## 404 — Not found

| Code        | Meaning | Typical cause | What to do |
| ----------- | ------- | ------------- | ---------- |
| `NOT_FOUND` | The addressed entity does not exist in this workspace. | Unknown campaign, recommendation, sync run, change action, book, or search term. | Re-list the parent collection; ids may have rotated after a re-sync. |

## 409 — Conflict

| Code                          | Meaning | Typical cause | What to do |
| ----------------------------- | ------- | ------------- | ---------- |
| `INVALID_STATE`               | The entity is in a state that forbids the operation. | Drafting a change set from a recommendation that is not `pending`. | Only `pending` recommendations can enter a change set. |
| `RECOMMENDATION_EXPIRED`      | The recommendation's evidence went stale (expires 3 days after creation). | Acting on an old finding. | Wait for the next `recommendation_run` (after the next complete metrics sync) to regenerate fresh findings. |
| `RECOMMENDATION_NOT_WRITABLE` | The recommendation type is advisory-only. | Trying to create a change set from e.g. `search_term_harvest`, `budget_constrained_winner`, a diagnostic, or `cannibalization_conflict`. | Only `wasteful_search_term`, `expensive_target`, and `profitable_target` produce automatic actions; resolve others manually or via the dedicated flows. |
| `INVALID_RECOMMENDATION_TYPE` | A type-specific endpoint received the wrong type. | Calling the cannibalization resolution endpoint on a non-cannibalization recommendation. | Use the endpoint matching the recommendation's `type`. |
| `INCOMPLETE_EVIDENCE`         | The finding's stored evidence is incomplete for the requested resolution. | Cannibalization resolution where an affected campaign is no longer present in the finding's profile. | Re-sync structure, then wait for a fresh finding. |
| `STALE_BEFORE_STATE`          | The fresh re-read of Amazon state does not match the recorded before-state. | Someone changed the entity in the Amazon console between preview and apply. | Nothing was written for that action; re-preview the change set and apply again. |
| `GUARDRAIL_VIOLATION`         | One or more guardrails failed at apply time. | Bid change too large, cooldown active, stale evidence, protected entity, exposure/budget limits. | The `details`/preview list the violations (`BID_CHANGE_TOO_LARGE`, `BID_COOLDOWN_ACTIVE`, `STALE_EVIDENCE`, `PROTECTED_ENTITY`, …). Adjust the set or wait out the cooldown. |
| `MAX_CPC_EXCEEDED`            | The proposed bid exceeds the campaign's enforced Max CPC ceiling. | Applying a bid-up recommendation on a campaign with a Max CPC policy. | Raise the ceiling (`POST /api/campaigns/:campaignId/max-cpc`) or drop the action. |
| `APPLY_IN_PROGRESS`           | The change set is already being applied. | Concurrent apply of the same set. | Poll `GET /api/change-sets` until the set leaves `applying`. |
| `CHANGE_SET_BLOCKED`          | The change set is in `blocked` state and cannot be applied. | An earlier validation failure marked it blocked. | Draft a new change set. |
| `DEPENDENCY_NOT_APPLIED`      | The set depends on another change set that is not `applied` yet. | Applying cannibalization negatives before their destination campaign creation set finished. | Apply the referenced creation set first (`dependsOnChangeSetId`). |
| `NOT_ROLLBACKABLE`            | The action has no verified compensating Amazon operation. | Rolling back an action that is not `applied`, a campaign-creation chain, or a negative ASIN target. | Rollback only covers applied `update_bid` and verified `add_negative_exact` actions; undo anything else manually in the Amazon console. |
| `TOO_MANY_ACTIONS`            | The change set exceeds the action limit. | More than 20 actions in one set, or a Max CPC submission on a campaign with more than 5,000 bid controls. | Split the work into smaller sets or smaller campaigns. |
| `BOOK_PROFILE_NOT_LINKED`     | The book is not linked to the requested profile. | Saving economics or creating a campaign for a profile the book's ASIN is not mapped to. | Link the ASIN first (`POST /api/books/:bookId/profile-links`, or `POST /api/books/mappings` for advertised ASINs). |
| `ASIN_ALREADY_LINKED`         | Another catalog book already uses this ASIN in one of the selected markets. | Linking a marketplace ASIN that is already claimed. | Use the book that already owns the ASIN, or pick a different ASIN. |
| `BOOK_PROFILE_ASIN_MISMATCH`  | The book is already linked to a selected profile with a different ASIN. | Retrying a marketplace link with a new ASIN. | Keep the existing marketplace ASIN, or use a market that is not yet linked. |
| `PROFILE_DISABLED`            | The profile is disabled. | Requesting a sync for a profile with `enabled: false`. | Enable the profile via `PATCH /api/profiles/:profileId`. |
| `MIXED_CURRENCY`              | A view would aggregate money across currencies. | Dashboard/search-term query spanning marketplaces with different currencies. | Narrow the query with the `country` parameter — or use `country=all` on the dashboard summary, which converts explicitly. |
| `FX_RATES_INCOMPLETE`         | A requested currency conversion lacks stored FX rates for part of the window. | `country=all` (or an explicit `currency`) on `GET /api/dashboard/summary` while `fx_rates` does not cover every fact date. | Wait for the daily `fx_sync` job (after 17:00 UTC) or check its health on the overview's Sync status card; nothing unconverted is ever returned. |

## 429 — Rate limited

| Code           | Meaning | Typical cause | What to do |
| -------------- | ------- | ------------- | ---------- |
| `RATE_LIMITED` | The per-minute tier for the route was exceeded (global 200/min; STRICT 10/min; WRITE 20/min; PREVIEW 120/min). | Burst of writes or previews. | Back off and retry; the tiers reset each minute. |

## 502 — Amazon write failed

| Code                  | Meaning | Typical cause | What to do |
| --------------------- | ------- | ------------- | ---------- |
| `AMAZON_APPLY_FAILED` | The Amazon call behind an apply failed before a usable result came back. | Amazon outage, unexpected transport failure. | The set is `failed`; retrying it is safe (idempotency fingerprints prevent duplicates) and does not require recent re-auth. |

### Per-action failure codes

When a set applies partially, individual failed actions carry one of these
codes in their result payload (the set ends `partially_applied` or `failed`):

| Code                     | Meaning |
| ------------------------ | ------- |
| `AMAZON_HTTP_<status>`   | Amazon returned that HTTP status (e.g. `AMAZON_HTTP_400`); `details` holds the sanitized Amazon response and `amazonRequestId` the support trace id. |
| `AMAZON_RESPONSE_INVALID`| Amazon's response did not match the adapter schema (missing/wrong-typed required fields). |
| `AMAZON_NETWORK_ERROR`   | Network-level failure (DNS, socket, timeout) before any HTTP status. |
| `PARENT_FAILED`          | A creation-chain action was skipped because an earlier phase (e.g. the campaign) failed, orphaning the dependent action. |
| `MISSING_RESULT`         | Amazon's batch response contained no result entry for a requested entity (adapter-level). |
| `NO_RESULT`              | The apply pipeline found no per-item result to record for an action. |
| `ALREADY_PRESENT` / `ALREADY_ABSENT` | Verification found the desired end state already in place (e.g. the negative already exists); treated as satisfied, not an error. |

## 5xx — Server errors

| Code       | Meaning | Typical cause | What to do |
| ---------- | ------- | ------------- | ---------- |
| `INTERNAL` | Unhandled server-side failure. | Database outage, invariant violation. | Check the api logs with the echoed `x-request-id`; report persistent cases with the id. |

Unexpected non-API errors below 500 (e.g. malformed JSON bodies rejected by
the framework) use the generic code `REQUEST_ERROR` with the original status.

## OAuth redirect errors

The OAuth callback (`GET /api/integrations/amazon/callback`) and session
verify never return JSON — failures redirect the browser instead.

`{WEB_ORIGIN}/connect?error=<code>`:

| Code                       | Meaning | What to do |
| -------------------------- | ------- | ---------- |
| `invalid_callback`         | The callback query was malformed (no usable `state`/`code`). | Restart the connection from the dashboard. |
| `invalid_state`            | The state is unknown, expired (10-minute TTL), or already used (single-use, marked used before code exchange). | Restart the connection; do not reuse or bookmark the Amazon URL. |
| `session_required`         | No valid app session accompanied the callback. | Sign in first, then connect Amazon. |
| `foreign_state`            | The state belongs to a different user/session. | Sign in as the same user who started the connection and retry. |
| `exchange_failed`          | The authorization-code exchange with LWA failed. | Retry; check `LWA_CLIENT_ID`/`LWA_CLIENT_SECRET` and that `AMAZON_REDIRECT_URI` matches the LWA app registration exactly. |
| `profile_discovery_failed` | Token exchange succeeded but the profile list could not be fetched/imported. | Check the api logs; verify the Amazon account has Advertising profiles. |

Login verify failures redirect to `{WEB_ORIGIN}/login?error=invalid_token`:
the magic link is unknown, expired (15-minute TTL), or already consumed —
request a fresh link.

## Amazon-side adapter errors

These originate in `packages/amazon-ads` and surface in api/worker logs and
connection status rather than as API response codes.

| Error / code                | Meaning | Consequence |
| --------------------------- | ------- | ----------- |
| `AmazonAuthError` `invalid_grant`, `revoked`, `unauthorized_client` | The refresh grant is dead (unrecoverable). | The connection is marked `reconnect_required` and its pending jobs are dead-lettered; the owner must reconnect Amazon. |
| `AmazonAuthError` `reconnect_required` | Token refresh attempted on a connection already marked reconnect-required, or the circuit breaker is open. | Jobs fail fast until the owner reconnects. |
| `AmazonAuthError` `missing_lwa_credentials` | The worker has no `LWA_CLIENT_ID`/`LWA_CLIENT_SECRET`. | Recoverable: jobs needing tokens fail until the credentials are configured. No reconnect is forced. |
| `AmazonAuthError` `token_request_failed`, `invalid_token_response`, `missing_refresh_token` | Transient or malformed LWA token responses. | Retried with backoff by the token manager. |
| `AmazonApiError` | Amazon returned an HTTP error status; carries `status`, `requestId`, `retryable`, sanitized `details`. | 429 honors `Retry-After`; other retryables use exponential backoff with full jitter. |
| `AmazonNetworkError` | DNS/socket/timeout before any HTTP status; always retryable. | Retried with backoff. |
| `AdapterValidationError` | An Amazon payload failed strict schema validation at the gateway boundary; carries `context` and `issues`. | The sync/job fails loudly instead of importing corrupt data. |

## Related reading

- [API reference](/reference/api) — endpoint-by-endpoint error listings
- [Troubleshooting](/troubleshooting) — operational fixes
- [Architecture: security](/architecture/security) — the guarded-write design behind these codes
