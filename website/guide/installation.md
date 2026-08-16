---
title: Installation
description: Install Amazon King for local development with Node.js, pnpm, Docker, and Make — one command starts PostgreSQL, the API, the worker, and the dashboard.
---

# Installation

This gets the whole stack running locally: PostgreSQL in Docker, the API on
port 3000, the background worker, and the dashboard on port 5173.

## Prerequisites

- **Node.js ≥ 20** — the API and worker are Node + TypeScript.
- **pnpm 10.12.4** — the repo pins the package manager via the
  `packageManager` field in `package.json`; with Corepack enabled
  (`corepack enable`), the correct version is used automatically.
- **Docker** (with the Compose plugin) — local PostgreSQL runs as a container;
  nothing else is installed on your host.
- **GNU Make** — the Makefile is the single entry point for setup, running,
  testing, and the production stack.

## Clone and set up

```bash
git clone https://github.com/simonScheff/amazon-king.git
cd amazon-king
make setup
```

`make setup` installs workspace dependencies and creates `.env` from
`.env.example` if one doesn't exist.

## Configure `.env`

Open `.env` and review the values. What each one is for in local dev:

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | API, worker, migrations | Default points at the Docker database: `postgres://postgres:postgres@localhost:5432/amazon_king`. |
| `SESSION_SECRET` | API | Signs app session cookies. Minimum 16 characters; the example value is fine for local dev only. |
| `WEB_ORIGIN` | API | `http://localhost:5173` — used for CORS and post-login redirects. |
| `AMAZON_REDIRECT_URI` | API | `http://localhost:3000/api/integrations/amazon/callback` — must end in `/api/integrations/amazon/callback` and match your LWA app registration. |
| `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` | API (boot), worker (Amazon calls) | The API refuses to boot without them — validation requires a non-empty value even in dev, so **dummy values are fine** for pure local UI work. The worker boots without them, but any Amazon call fails with `missing_lwa_credentials` until real values are set. |
| `TOKEN_ENCRYPTION_KEY` | API, worker | 64 hex chars; encrypts Amazon refresh tokens at rest. The all-zeros example is dev-only. |
| `REPORT_STORAGE_DIR` | Worker | Local stand-in for S3 report storage; defaults to `./.data/reports`. |
| `KILL_SWITCH` | API, worker | Defaults to `true` (fail closed). Leave it `true` until live validation is done. |
| `OWNER_EMAIL` | Production only | Optional in dev — any email can sign in locally. |
| `SMTP_*` | Production only | Optional in dev. Without SMTP, login links are returned in the API response and logged instead of emailed. |

::: warning
The API validates its environment at boot and exits on any missing required
value. If startup fails, the error names the variable — check `.env` first.
`make run` also runs a `preflight` check for `DATABASE_URL`,
`SESSION_SECRET`, and the two LWA variables before starting anything.
:::

For the full list including production-only variables, see the
[environment variables reference](/reference/environment-variables).

## Run

```bash
make run
```

This one target chains everything: `setup` → `preflight` → `db-up` (starts
PostgreSQL via `docker compose` and waits for readiness) → `migrate` (applies
SQL migrations) → starts all three processes. Ctrl-C stops them together.

Three processes run side by side:

- **API** (`http://localhost:3000`) — the Fastify backend: auth, the guarded
  write service, and the OAuth callback.
- **Worker** — the background job loop: syncs, report imports, recommendation
  runs. Read-only against Amazon in the MVP.
- **Web** (`http://localhost:5173`) — the Vite dev server for the dashboard;
  it proxies `/api` to the API on port 3000, so the browser only ever talks
  to one origin.

Open `http://localhost:5173` and you're at the sign-in screen.

## Signing in during development

Enter any email address (there is no `OWNER_EMAIL` lock in dev). With no SMTP
configured, the magic link can't be emailed, so the API does two things:

- returns the link in the login response, which the dashboard surfaces as a
  **"Continue sign-in"** link, and
- logs the full link to the API console.

![Sign-in screen showing the dev "Continue sign-in" link after submitting an email](/screenshots/login.png)

Click the link (or paste it from the logs) and you're signed in. Login links
are single-use and expire after 15 minutes; the session lasts 7 days, rolling.

## Stopping and cleaning up

```bash
make stop    # stop local PostgreSQL
make clean   # also delete the database volume and ./.data (destroys local data)
```

## All Make targets

`make help` prints the current list:

| Target | What it does |
| --- | --- |
| `help` | Show available targets |
| `install` | Install workspace dependencies |
| `setup` | Install deps and create `.env` from `.env.example` if missing |
| `preflight` | Validate required local configuration before starting services |
| `db-up` | Start local PostgreSQL (docker compose) |
| `migrate` | Apply database migrations |
| `run` | Run the entire application (db + api + worker + web) |
| `dev` | Alias for `run` |
| `test` | Run all tests |
| `typecheck` | Typecheck all packages |
| `lint` | Check formatting |
| `build` | Build the web app |
| `check` | Formatting, typechecks, tests, and the production web build |
| `prod-config` | Create the ignored production environment file if missing |
| `prod-preflight` | Reject missing or placeholder production configuration |
| `prod-up` | Build and start the self-hosted production stack |
| `prod-logs` | Follow production stack logs |
| `prod-stop` | Stop the production stack without deleting persistent data |
| `stop` | Stop local PostgreSQL |
| `clean` | Stop db and delete its data volume (destroys local data) |

## Next steps

- [Quickstart](/guide/quickstart) — a guided first session through the dashboard
- [Connecting Amazon Ads](/guide/connecting-amazon) — when you're ready for real data
- [Self-hosting in production](/guide/self-hosting) — the `prod-*` targets in detail
