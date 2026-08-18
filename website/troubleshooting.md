---
title: Troubleshooting
description: Symptom-by-symptom fixes for common amazon-king problems — login email, OAuth errors, empty dashboards, failed applies, and worker issues.
---

# Troubleshooting

Each entry lists the symptom, its likely cause, and the fix. Error codes
referenced below are documented in the [error code reference](/reference/errors);
configuration knobs are in
[environment variables](/reference/environment-variables).

## Sign-in

### The "Check your inbox" email never arrives

**Cause.** The API only sends email when `SMTP_HOST` is configured. In
development without SMTP there is no email at all: the login response contains
`devLoginUrl` and the API logs the magic link. In production, `SMTP_HOST` and
`SMTP_FROM` are required — the server refuses to boot without them.

**Fix.** In development, copy the link from the login response or the API log
line `Magic login link (dev delivery)`. In production, verify your SMTP
settings:

- `SMTP_SECURE` must match the port: `false` (default) for STARTTLS on 587,
  `true` for implicit TLS on 465. `SMTP_PORT` defaults to 587.
- `SMTP_USER` and `SMTP_PASSWORD` must be set together or both omitted (for
  unauthenticated relays); setting only one fails config validation at boot.
- Check the API logs for nodemailer errors (credentials are never logged), and
  check spam folders before assuming delivery failed.

### `/login?error=invalid_token` after opening the magic link

**Cause.** Login tokens are single-use and expire 15 minutes after issue. The
link was already opened (some mail scanners pre-fetch links), it expired, or
it was truncated.

**Fix.** Request a fresh link from the login page and open it promptly, in the
same browser if your mail client uses a different one. Each new request
invalidates nothing — but only the exact link from the latest email you open
first will succeed.

## Connecting Amazon

### The OAuth callback lands on `/connect?error=...`

The error query parameter tells you which check failed:

- **`invalid_callback`** — the callback arrived without a `state` or `code`.
  Usually a mangled `AMAZON_REDIRECT_URI`; start the flow again.
- **`invalid_state`** — the state is unknown, expired (10-minute TTL), or
  replayed. State is marked used *before* the code exchange, so refreshing the
  callback page always produces this. Start the connection flow again.
- **`session_required`** — you reached the callback without an app session.
  Sign in to the app first, then start the Amazon connection; Login A and
  Login B are separate by design.
- **`foreign_state`** — the state was issued to a different signed-in user.
  Sign in as the user who started the flow.
- **`exchange_failed`** — Amazon rejected the code exchange. Check
  `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET`, and that `AMAZON_REDIRECT_URI`
  matches the redirect URI registered on the Login with Amazon app exactly —
  scheme, host, port, and path.
- **`profile_discovery_failed`** — the token exchange succeeded but listing
  profiles failed. Check API logs, then disconnect and reconnect.

### Connection stuck at `reconnect_required`

**Cause.** The stored refresh token is dead — Amazon returned `invalid_grant`
(revoked access, rotated credentials) or an equivalent unrecoverable auth
error. The worker marks the connection `reconnect_required` and dead-letters
its pending jobs so nothing runs against a dead grant.

**Fix.** There is no automatic recovery by design: disconnect the Amazon
connection and connect it again from the dashboard. New syncs must be
requested after reconnecting (queued jobs were failed).

### No profiles after connecting

**Cause.** Profile discovery runs once on connect and then daily
(`profile_discovery`, 24-hour cadence). Also, discovered profiles start
**disabled** — nothing syncs until you opt a profile in.

**Fix.** Open the dashboard and enable the profile
(`PATCH /api/profiles/:profileId` with `{"enabled": true}`), then trigger a
manual sync. If the profile list is still empty minutes after connecting,
check the worker logs for a failed `profile_discovery` job.

## Empty or missing data

### The dashboard is empty

**Cause.** Common reasons, in order of likelihood:

1. The profile is not enabled (they start disabled).
2. Metrics only import once daily after Amazon data settles (05:00 UTC), so a
   freshly connected account has nothing until then.
3. The sync failed.

**Fix.** Enable the profile, then trigger a manual sync
(`POST /api/profiles/:profileId/syncs`) — it imports the trailing 60 complete
UTC days, covering every optimizer evidence window. Check
`GET /api/system/data-freshness` for `lastSuccessAt` and `completeThrough`
per profile and dataset, and the worker logs for failed `metrics_sync` jobs.

### No recommendations appear

**Cause.** A `recommendation_run` only executes after a successful metrics
sync, and it skips entirely when the latest complete metrics sync is older
than 48 hours (`RECOMMENDATION_FRESHNESS_HOURS`). Rules also require minimum
evidence, and profit-based rules are suppressed — never guessed — for books
without KDP economics entered.

**Fix.** Confirm a recent complete metrics sync via
`GET /api/system/data-freshness`, then request a sync if stale. Enter
[book economics](/guide/book-economics) to unlock the profit rules. If data is
fresh and economics are set, the entities may simply not meet the evidence
thresholds — see [optimization rules](/reference/optimization-rules).

### Recommendations disappeared

**Cause.** Recommendations carry a 3-day staleness expiry. Each
recommendation run first expires stale rows: `pending` becomes `expired`, and
expired rows disappear from the default pending view.

**Fix.** This is normal — fresh drafts are regenerated from current data on
the next run. To inspect them anyway, query
`GET /api/recommendations?state=expired`.

## Applying changes

Apply failures return structured errors; the dashboard surfaces the code. See
[Applying & rolling back changes](/guide/applying-changes) for the full flow.

### Apply fails with `WRITES_DISABLED` (403)

**Cause.** Either the global kill switch is on (`KILL_SWITCH` defaults to
`true`) or the target profile is read-only.

**Fix.** This is the safe default — keep it until live validation is complete.
Then set `KILL_SWITCH=false`, restart the API, and enable writes on the
profile (`{"writeEnabled": true}`), which also requires the profile to be
enabled for syncing.

### Apply fails with `REAUTH_REQUIRED` (401)

**Cause.** Spend-changing actions require authentication within the last 15
minutes; your session is older.

**Fix.** Sign in again (the dashboard opens a re-auth dialog that emails a
magic link returning you to the same page), then retry. Retrying a `failed`
change set is exempt — it replays an already-approved payload through the
guarded path.

### Apply fails with `STALE_BEFORE_STATE` (409)

**Cause.** The pre-write re-read of Amazon no longer matches the change set's
`before` snapshot — someone or something changed the entity since the draft.
The set is moved to `blocked`.

**Fix.** Do not retry the blocked set. Create a fresh change set from current
recommendations and apply it promptly.

### Apply fails with `GUARDRAIL_VIOLATION` (409)

**Cause.** The guardrail re-check at apply time failed — for example a bid
change beyond the ±15% clamp, a cooldown conflict, or stale evidence. The
error's `details` lists each violation as `code: message`; the set is
`blocked`.

**Fix.** Read the violation list, discard the set, and draft a new one that
stays within the guardrails (see
[optimization rules](/reference/optimization-rules) and
[key concepts](/guide/key-concepts)).

### Apply fails with `MAX_CPC_EXCEEDED`

**Cause.** A bid in the change set exceeds the campaign's active Max CPC
ceiling. The set is `blocked`.

**Fix.** Raise the campaign's Max CPC first
(`POST /api/campaigns/:campaignId/max-cpc`, itself a guarded, recent-auth
write) or draft a smaller bid change.

### Apply fails with `DEPENDENCY_NOT_APPLIED` (409)

**Cause.** The change set is a cannibalization resolution whose negative
keywords are locked until the new destination campaign exists on Amazon —
`metadata.dependsOnChangeSetId` points at the creation set.

**Fix.** Apply the referenced campaign-creation change set first; once it is
`applied`, apply the negatives set.

### Apply fails with `APPLY_IN_PROGRESS` (409)

**Cause.** Another apply of the same change set is already running (double
click, concurrent client).

**Fix.** Wait for the in-flight apply to finish, then reload the change set —
a finished set returns its stored result instead of touching Amazon twice.

### Apply fails with `RECOMMENDATION_EXPIRED` (409)

**Cause.** A recommendation in the set passed its 3-day expiry between draft
and apply. The set returns to `previewed`.

**Fix.** Create a fresh change set from current pending recommendations.

### Apply partially failed (`partially_applied`)

**Cause.** Amazon rejected individual items in the batch; a batch-level
success never implies item success. Per-item failures are recorded with
`errorMessage`, and post-write verification failures mark actions
`verification_failed`.

**Fix.** Inspect the set's actions to see which items failed and why. Retrying
the `failed` set is idempotent (fingerprint-checked) and skips the recent-auth
gate; actions already `applied` are not re-sent.

## Worker and jobs

### The worker is not processing jobs

**Cause.** Several possibilities:

- A failing job exhausts its attempts and is marked `dead` (default
  `max_attempts` is 5); dead jobs are never retried.
- The worker was killed mid-job: the 120-second lease expires and is reaped
  every 60 seconds (`WORKER_REAP_INTERVAL_MS`), returning the job to pending —
  so a stuck job self-heals within a couple of minutes.
- `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` missing on the worker: token refresh
  fails with `missing_lwa_credentials` and Amazon-touching jobs fail.

**Fix.** Check the worker logs for `Job failed` / `dead` entries and
`Reaped expired job leases` warnings. Fix the root cause, then re-trigger work
(manual sync, or wait for the 15-minute `schedule_tick`). Confirm the worker
has the full environment from `.env`.

### A metrics sync keeps retrying

**Cause.** Amazon report generation failed or polling timed out
(`REPORT_POLL_TIMEOUT_MS`, default 45 minutes). A timeout keeps the report
`polling` so the retry resumes the same `amazon_report_id`; a report Amazon
reports as `FAILURE` becomes `retryable` and is re-requested. After 5 attempts
the job is dead-lettered with `Report <family> exhausted 5 attempts`.

Amazon needs roughly 19–21 minutes per daily report, and the worker runs one
job at a time, so a full pass over many marketplaces takes hours. If metric
columns look stale for one country, check whether its reports have completed
before assuming a bug:

```sql
select report_type, date_start, date_end, status, attempts
  from report_jobs
 where profile_id = $1
 order by id desc
 limit 12;
```

**Fix.** Check the worker logs for the underlying Amazon error (rate limits,
region outages). Once the cause clears, request a new sync. Persistent
`429`s mean the polling/backoff is working — give it time.

### The API or worker fails to boot with a config validation error

**Cause.** `loadConfig` parses the environment with zod and throws on the
first invalid combination, listing every offending variable.

**Fix.** Read the error output — it names each invalid variable and
constraint. Production adds extra requirements: `OWNER_EMAIL`,
`API_PUBLIC_URL`, `SMTP_HOST`, `SMTP_FROM`, and a `SESSION_SECRET` of at
least 32 non-default characters.

### Database integration tests are skipped

**Cause.** They only run when `TEST_DATABASE_URL` points at a PostgreSQL
database.

**Fix.** Set `TEST_DATABASE_URL` to a **disposable, scratch database** — the
integration suite drops and recreates the `public` schema. Never point it at
a database containing data you care about.

## Environment

### Port already in use (3000, 5173, or 5432)

**Cause.** Another process occupies the API (3000), web dev server (5173), or
PostgreSQL (5432) port.

**Fix.** Find the listener with `lsof -i :3000` (etc.) and stop it, or
override: `PORT` for the API, `pnpm --filter @amazon-king/web dev -- --port
NNNN` for Vite, and the `db` port mapping in `docker-compose.yml` for
PostgreSQL. `make stop` cleans up the project's own processes.

### Cookies do not stick in production

**Cause.** The session cookie is `Secure` outside development — browsers drop
it over plain HTTP. Behind a reverse proxy without `TRUST_PROXY=true`, the
API also mis-detects the connection.

**Fix.** Serve the deployment over HTTPS (see
[self-hosting](/guide/self-hosting)), set `TRUST_PROXY=true` when running
behind your own proxy, and make sure `API_PUBLIC_URL` and `WEB_ORIGIN` use
the public `https://` origins. `OWNER_EMAIL` and `API_PUBLIC_URL` are
required in production — the server refuses to boot without them.
