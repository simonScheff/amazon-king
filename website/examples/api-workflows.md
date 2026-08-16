---
title: API workflows with curl
description: Copy-pasteable curl workflows against a local amazon-king dev instance — sign-in, reading data, guarded writes, syncs, and rollback.
---

# API workflows with curl

These workflows exercise the HTTP API of a local development instance started
with `make run` (API on `http://localhost:3000`). They are the same calls the
dashboard makes, so they are a good way to explore the system or debug a
deployment. For the full endpoint list see the [API reference](/reference/api);
for every error code see [Error codes](/reference/errors).

Conventions used throughout:

- A cookie jar (`ak.cookies`) carries the `ak_session` session cookie between
  requests.
- Every `POST`/`PATCH`/`DELETE` under `/api` (except login) requires the
  session's CSRF token in the `x-csrf-token` header.
- Money and bid values are string-encoded decimals with up to four fractional
  digits, e.g. `"12.3400"` — floating point never touches monetary data.
- All ids in URLs and payloads are strings. The ids below (`"7001"`,
  `"345678901234567"`, …) are synthetic; substitute real values from your own
  responses.
- Every non-2xx response uses the same error envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Unknown change set",
    "details": null
  }
}
```

## 1. Sign in (Login A)

Sign-in is passwordless: request a magic link, then open it to establish a
session. In development without SMTP configured, the link is returned directly
in the response as `devLoginUrl` (and logged by the API); in production it is
only ever sent by email.

```sh
curl -s -X POST http://localhost:3000/api/session/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
```

```json
{
  "ok": true,
  "devLoginUrl": "http://localhost:3000/api/session/verify?token=AbCdEf..."
}
```

Open the verify URL with the cookie jar. It responds with a redirect to the
web app and sets the `HttpOnly` `ak_session` cookie — a `302` here means
success. The link is single-use and expires after 15 minutes.

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -c ak.cookies -b ak.cookies \
  'http://localhost:3000/api/session/verify?token=AbCdEf...'
# 302
```

Read the session to pick up the CSRF token required by all mutations:

```sh
curl -s -b ak.cookies http://localhost:3000/api/session
```

```json
{
  "userId": "1",
  "workspaceId": "1",
  "email": "you@example.com",
  "expiresAt": "2026-08-23T15:04:12.991Z",
  "csrfToken": "9f2c1e..."
}
```

```sh
CSRF=$(curl -s -b ak.cookies http://localhost:3000/api/session | jq -r .csrfToken)
```

Sessions roll for about 7 days and are extended on use. Note that
spend-changing actions additionally require the session to be younger than
15 minutes — see the apply step below.

## 2. Read data

Dashboard summary for the last 30 days in one market (`days` accepts 1–90,
`country` a two-letter code, default `US`):

```sh
curl -s -b ak.cookies \
  'http://localhost:3000/api/dashboard/summary?days=30&country=US'
```

```json
{
  "dateRange": { "start": "2026-07-18", "end": "2026-08-16" },
  "currency": "USD",
  "totals": {
    "impressions": 184203,
    "clicks": 3917,
    "cost": "812.4400",
    "sales": "2310.9700",
    "orders": 241,
    "acos": 0.3515,
    "estimatedRoyalty": "1204.5000",
    "estimatedAdProfit": "392.0600"
  },
  "economicsMissing": false,
  "dataCurrentThrough": "2026-08-15T00:00:00.000Z",
  "writesDisabled": true
}
```

`estimatedRoyalty` and `estimatedAdProfit` are `null` and `economicsMissing`
is `true` until you enter [book economics](/guide/book-economics) — profit is
never guessed. `writesDisabled` is `true` while the kill switch is on or all
profiles are read-only, which is the safe default.

Campaign list:

```sh
curl -s -b ak.cookies 'http://localhost:3000/api/campaigns?days=30'
```

Pending recommendations:

```sh
curl -s -b ak.cookies \
  'http://localhost:3000/api/recommendations?state=pending'
```

```json
[
  {
    "id": "7001",
    "type": "expensive_target",
    "state": "pending",
    "priority": 2,
    "profileId": "345678901234567",
    "campaignId": "551234567890123",
    "adGroupId": "441234567890123",
    "targetId": "331234567890123",
    "searchTerm": null,
    "currentValue": "0.8500",
    "proposedValue": "0.7225",
    "rationale": "ACoS 61.2% over the 30-day window is above the 35.0% target; lower the bid 15.0%.",
    "confidence": 0.82,
    "evidenceWindow": { "start": "2026-07-17", "end": "2026-08-15" },
    "dataFreshness": "2026-08-16T06:12:44.000Z",
    "ruleVersion": "expensive_target@1",
    "expiresAt": "2026-08-19T06:12:44.000Z",
    "createdAt": "2026-08-16T06:12:44.000Z"
  }
]
```

`state` accepts `pending`, `approved`, `rejected`, `expired`, `applied`,
`protected`; a `type` filter is also available. Data freshness per profile
and dataset:

```sh
curl -s -b ak.cookies http://localhost:3000/api/system/data-freshness
```

```json
[
  {
    "profileId": "345678901234567",
    "dataset": "metrics",
    "lastSuccessAt": "2026-08-16T06:12:44.000Z",
    "completeThrough": "2026-08-15"
  }
]
```

## 3. A guarded write, end to end

The write path is deliberately strict: draft an immutable change set from
recommendations, preview it against a fresh read of Amazon, then apply.
Read [Applying & rolling back changes](/guide/applying-changes) for the
concepts; the calls are:

Draft a change set from one or more recommendation ids:

```sh
curl -s -X POST http://localhost:3000/api/recommendations/change-sets \
  -b ak.cookies -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"recommendationIds":["7001"]}'
```

```json
{
  "id": "501",
  "profileId": "345678901234567",
  "status": "draft",
  "createdAt": "2026-08-16T15:30:02.118Z",
  "kind": "recommendation"
}
```

Creation is idempotent per content fingerprint — re-submitting the same
recommendations returns the existing draft instead of a duplicate. Only
recommendation types with a concrete write (`expensive_target`,
`profitable_target`, `wasteful_search_term`) can enter a change set; the rest
are advisory-only.

Preview re-reads the current Amazon state and re-checks guardrails:

```sh
curl -s -b ak.cookies http://localhost:3000/api/change-sets/501/preview
```

```json
{
  "changeSet": { "id": "501", "profileId": "345678901234567", "status": "previewed" },
  "actions": [
    {
      "id": "9001",
      "changeSetId": "501",
      "actionType": "update_bid",
      "beforeValue": "0.8500",
      "afterValue": "0.7225",
      "entityName": "space opera ebook",
      "campaignName": "SP | Redshift Blues | Auto",
      "amazonCampaignId": "551234567890123",
      "rollbackAvailable": true,
      "status": "pending",
      "amazonRequestId": null
    }
  ],
  "guardrails": []
}
```

Apply:

```sh
curl -s -X POST http://localhost:3000/api/change-sets/501/apply \
  -b ak.cookies -H "x-csrf-token: $CSRF"
```

Two gates to expect before any Amazon call happens:

**Writes are disabled by default.** With the shipped `KILL_SWITCH=true`, or
while the profile is read-only, apply fails closed — this is the expected
safe response on a fresh install:

```json
{
  "error": {
    "code": "WRITES_DISABLED",
    "message": "The global kill switch is enabled; all writes are disabled"
  }
}
```

To go further, set `KILL_SWITCH=false` and enable writes on the profile
(`PATCH /api/profiles/:profileId` with `{"writeEnabled": true}`) — only after
completing the live-validation steps in the
[operations runbook](/guide/operations).

**Recent sign-in.** Apply requires a session younger than 15 minutes. An
older session gets `401` with `REAUTH_REQUIRED`; sign in again (step 1) and
retry. Retrying a `failed` change set is exempt because it replays an
already-approved payload through the same guarded path.

A successful apply returns the set and its per-item results; a batch success
never implies item success, so check each action:

```json
{
  "changeSet": { "id": "501", "status": "applied" },
  "actions": [
    {
      "id": "9001",
      "actionType": "update_bid",
      "beforeValue": "0.8500",
      "afterValue": "0.7225",
      "status": "applied",
      "amazonRequestId": "AK-REQ-9d1f..."
    }
  ]
}
```

If Amazon changed since the draft, apply fails with `409 STALE_BEFORE_STATE`
and the set becomes `blocked` — discard it and draft a fresh set from current
data. Individual item failures produce `partially_applied` with the failing
action's `errorMessage` set.

## 4. Trigger and poll a sync

Request a sync for one profile. The id in the URL is the Amazon profile id
(from `GET /api/profiles`), and the profile must be enabled:

```sh
curl -s -X POST http://localhost:3000/api/profiles/345678901234567/syncs \
  -b ak.cookies -H "x-csrf-token: $CSRF"
```

```json
{
  "id": "88",
  "profileId": "345678901234567",
  "kind": "structure",
  "status": "queued",
  "startedAt": "2026-08-16T15:41:10.402Z",
  "finishedAt": null,
  "error": null
}
```

The sync never runs inside the request: this enqueues a `structure_sync` job
plus a `metrics_sync` job covering the trailing 60 complete UTC days for the
worker. Poll the run until `finishedAt` is set:

```sh
curl -s -b ak.cookies http://localhost:3000/api/syncs/88
```

A successful metrics sync automatically chains a recommendation run, so new
recommendations appear without further calls.

## 5. Roll back an action

Rollback is a compensating Amazon write, not a database undo, and it has the
same gates as apply (kill switch, write-enabled profile, recent sign-in).
Only actions in `applied` state with `rollbackAvailable: true` can be rolled
back — verified negative exact keywords created by the app are rollbackable;
negative ASIN targets and campaign creations are not. Anything else returns
`409 NOT_ROLLBACKABLE`.

```sh
curl -s -X POST http://localhost:3000/api/change-actions/9001/rollback \
  -b ak.cookies -H "x-csrf-token: $CSRF"
```

```json
{
  "changeSet": { "id": "502", "status": "applied", "kind": "rollback" },
  "actions": [
    {
      "id": "9002",
      "actionType": "update_bid",
      "beforeValue": "0.7225",
      "afterValue": "0.8500",
      "status": "applied",
      "amazonRequestId": "AK-REQ-77ab..."
    }
  ]
}
```

The rollback is recorded as its own `rollback` change set that restores the
action's `beforeValue`, keeping the full history auditable.

## Notes

- Rate limits are per bucket: login/OAuth are strictest (10 requests/minute),
  writes 20/minute, previews 120/minute, everything else 200/minute. Exceeding
  one returns `429` with code `RATE_LIMITED`.
- The dev server proxies `/api` through the web app on port 5173, so
  `http://localhost:5173/api/...` works identically to port 3000.
