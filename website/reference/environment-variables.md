---
title: Environment Variables
description: Every environment variable read by the amazon-king API, worker, and crypto package — defaults, validation rules, and production requirements.
---

# Environment Variables

Configuration comes from the process environment only — secrets are never read
from files committed to the repo or stored per-user. Locally, `make setup`
creates `.env` from `.env.example` and the Makefile loads it into every
recipe; the production compose stack loads `.env.production` (see
[Self-hosting](/guide/self-hosting)).

Only the `api` and `worker` processes and the crypto package read environment
variables. The `web` app has no custom environment — it is a static build that
talks to the API on the same origin. The `database`, `optimizer`,
`amazon-ads`, `contracts`, and `observability` packages read no environment of
their own.

## API process (`apps/api`)

Parsed by a zod schema at boot; invalid values abort startup.

| Variable             | Default       | Required            | Notes |
| -------------------- | ------------- | ------------------- | ----- |
| `NODE_ENV`           | `development` | no                  | `development` \| `test` \| `production`. Production turns on the `Secure` cookie flag and the stricter requirements below. |
| `PORT`               | `3000`        | no                  | Positive integer HTTP port. |
| `DATABASE_URL`       | —             | **always**          | PostgreSQL connection URL. |
| `SESSION_SECRET`     | —             | **always**          | HMAC secret for stateless CSRF tokens. Min 16 chars; in production min 32 chars and must not contain `change-me`. |
| `WEB_ORIGIN`         | —             | **always**          | Dashboard origin (URL). Used for CORS and post-login/OAuth redirects. |
| `LWA_CLIENT_ID`      | —             | **always**          | Login With Amazon app credential (Login B). |
| `LWA_CLIENT_SECRET`  | —             | **always**          | Never leaves the server. |
| `AMAZON_REDIRECT_URI`| —             | **always**          | URL registered with LWA; must point at this API's callback route exactly: `<api origin>/api/integrations/amazon/callback`. |
| `KILL_SWITCH`        | `true`        | no                  | Global write kill switch. Only the exact value `"false"` disables it; unset or any other value keeps all Amazon writes disabled. Fail closed. |
| `TRUST_PROXY`        | `false`       | no                  | `"true"` makes Fastify trust `X-Forwarded-*` headers. Set only behind your own reverse proxy. |
| `OWNER_EMAIL`        | —             | **production**      | Single-owner lock: only this email may sign in. |
| `API_PUBLIC_URL`     | —             | **production**      | Public base URL of the API; magic login links point here (verify then redirects to `WEB_ORIGIN`). Falls back to the origin of `AMAZON_REDIRECT_URI` in dev. |
| `SMTP_HOST`          | —             | **production**      | Magic-link delivery. Without SMTP in development, the link is logged and returned as `devLoginUrl`. |
| `SMTP_PORT`          | `587`         | no                  | Integer 1–65535. |
| `SMTP_SECURE`        | `false`       | no                  | `"true"` for implicit TLS. |
| `SMTP_USER`          | —             | with `SMTP_PASSWORD` | The two must be set together or both unset (e.g. a trusted local relay). |
| `SMTP_PASSWORD`      | —             | with `SMTP_USER`    | See above. |
| `SMTP_FROM`          | —             | **production**      | Sender header, e.g. `"amazon-king <no-reply@example.com>"`. |

Derived constants (not configurable): session TTL ~7 days rolling, login token
TTL 15 minutes, OAuth state TTL 10 minutes, recent-auth window 15 minutes.

## Worker process (`apps/worker`)

Every tunable has a safe default; only `DATABASE_URL` is strictly required.
Integer tunables must be positive numbers or the worker refuses to boot. LWA
credentials are needed for token refresh — the worker boots without them so
non-Amazon jobs still run, but any job needing an Amazon access token fails
with a `missing_lwa_credentials` auth error until they are set.

| Variable                         | Default            | Notes |
| -------------------------------- | ------------------ | ----- |
| `DATABASE_URL`                   | — (**required**)   | PostgreSQL connection URL. |
| `REPORT_STORAGE_DIR`             | `./.data/reports`  | Local stand-in for S3-compatible raw report storage (gzip artifacts + sha256). |
| `LOG_LEVEL`                      | `info`             | Pino level. |
| `KILL_SWITCH`                    | `true`             | Same semantics as the API: only `"false"` disables. Wired for the future apply worker; the MVP worker is read-only against Amazon. |
| `LWA_CLIENT_ID`                  | —                  | Needed for token refresh. |
| `LWA_CLIENT_SECRET`              | —                  | Needed for token refresh. |
| `WORKER_POLL_INTERVAL_MS`        | `2000`             | Queue poll interval when no job is available. |
| `WORKER_LEASE_SECONDS`           | `120`              | Lease per claimed job; heartbeats extend it. |
| `WORKER_HEARTBEAT_MS`            | `30000`            | Lease heartbeat interval. |
| `WORKER_REAP_INTERVAL_MS`        | `60000`            | Interval for reaping expired leases. |
| `REPORT_POLL_INITIAL_DELAY_MS`   | `5000`             | First delay when polling a Reporting v3 report. |
| `REPORT_POLL_MAX_DELAY_MS`       | `60000`            | Maximum report-poll backoff. |
| `REPORT_POLL_TIMEOUT_MS`         | `1200000` (20 min) | Overall report-poll timeout. |
| `RECENT_WINDOW_DAYS`             | `14`               | Days re-imported by `recent_window_resync` to absorb attribution lag. |
| `RECOMMENDATION_FRESHNESS_HOURS` | `48`               | Recommendation runs skip when the last complete metrics sync is older than this. |
| `SCHEDULE_TICK_MS`               | `900000` (15 min)  | `schedule_tick` self-rescheduling interval. |

## Token encryption (`packages/crypto`)

Used by both the API (writing tokens) and the worker (refreshing them).

| Variable                | Default | Required | Notes |
| ----------------------- | ------- | -------- | ----- |
| `TOKEN_ENCRYPTION_KEY`  | —       | when a connection exists | AES-256-GCM master key (key version 1) as exactly 64 hex characters (32 bytes). Generate with `openssl rand -hex 32`. |
| `TOKEN_ENCRYPTION_KEY_V2` … | — | no | Rotation: adding `TOKEN_ENCRYPTION_KEY_V<N>` registers key version N. New encryptions use the current version; old rows decrypt via the version embedded in the ciphertext header, so rotation does not require re-encrypting existing rows. |

The variable is read lazily at encrypt/decrypt time, and the process throws if
it is missing or malformed when token work actually happens.

## Compose production stack only

These are consumed by `compose.production.yml` / the Makefile, not by
application code. Set them in `.env.production` (created by
`make prod-config`).

| Variable            | Default          | Notes |
| ------------------- | ---------------- | ----- |
| `POSTGRES_PASSWORD` | — (**required**) | Password for the bundled `postgres:16-alpine` service (user/db `amazon_king`). Compose refuses to start without it. Also interpolated into the services' `DATABASE_URL`. |
| `APP_ENV_FILE`      | `.env.production` | Env file passed to the api/worker/migrate containers. |
| `APP_BIND_ADDRESS`  | `127.0.0.1`      | Bind address for the web proxy port. Keep loopback and terminate HTTPS in your own host reverse proxy. |
| `APP_PORT`          | `8080`           | Host port mapped to the web container's 8080. |

The compose stack also sets `NODE_ENV=production`, `PORT=3000`,
`TRUST_PROXY=true` (api) and `REPORT_STORAGE_DIR=/app/.data/reports` (worker)
itself.

## Test only

| Variable            | Notes |
| ------------------- | ----- |
| `TEST_DATABASE_URL` | Enables the `packages/database` integration tests. **Must point at a disposable database**: the suite drops and recreates the `public` schema. Unset, the integration tests are skipped and `pnpm -r test` still passes. |

## Related reading

- [Configuration guide](/guide/configuration) — what to set and why
- [Self-hosting](/guide/self-hosting) — the production compose stack
- [Commands](/reference/commands) — `make` targets that consume these files
