---
name: local-stack
description: Run and troubleshoot the amazon-king app locally (Makefile, Docker PostgreSQL, migrations, dev sign-in). Use when starting the app, when a local request fails with a 500, when sign-in or a magic link does not work, or when the database seems out of date.
whenToUse: When the user wants to run the app locally, or when something is broken on localhost — failed sign-in, "Internal server error", missing data, or a database that will not start
---

Run the whole stack with one command from the repo root:

```bash
make run
```

That installs dependencies, creates `.env` from `.env.example` if missing,
validates required config, starts PostgreSQL via `docker compose`, applies
migrations, then runs api (:3000), worker, and web (:5173) together. Ctrl-C
stops all three. `make help` lists every target; the useful ones day to day are
`setup`, `db-up`, `migrate`, `test`, `typecheck`, `lint`, `check`, `stop`, and
`clean` (which destroys the local data volume).

`make run` fails preflight unless `DATABASE_URL`, `SESSION_SECRET`,
`LWA_CLIENT_ID`, and `LWA_CLIENT_SECRET` are all set in `.env`. The Amazon
credentials only need to be non-empty to boot; they matter when connecting an
account.

PostgreSQL runs as the `amazon-king-db` container (postgres:16-alpine,
`amazon_king` database, port 5432).

## Sign-in on localhost: no email is ever sent

Local development has no SMTP configured, and this is intentional — do not
report it as a bug. `POST /api/session/login` returns the magic link as
`devLoginUrl` in the JSON response, and the API process logs it. The login page
and the re-auth "Confirm it's you" dialog render it as a "Continue sign-in"
link. The behavior lives in `startLogin` in `apps/api/src/services/session.ts`.

Spend-changing actions — apply, rollback, max-cpc, campaign creation — require
an app session created within the last 15 minutes (`RECENT_AUTH_MS` in
`apps/api/src/config.ts`). When it lapses the web app opens the re-auth dialog;
one click on the dev link re-signs in and returns to the same page, because the
link carries the current path as `next`.

## A local 500 usually means a missing migration

**After pulling, or after writing schema changes, run `make migrate`.**

A pending migration surfaces only as a generic "Internal server error" in the
UI, with the real cause in the API logs. If a login or mutation 500s locally,
check in this order:

1. `docker compose ps` — is the database actually up?
2. `make migrate` — are all migrations applied to the running container?
3. The API process output — the underlying SQL error is there.

## Other things that bite

- Changing `.env` requires restarting the affected process; the Makefile exports
  it into each recipe at start time.
- `make clean` deletes the Postgres volume and `.data`. Everything local is
  gone, including your session and any connected Amazon account.
- The web dev server proxies `/api` to `http://localhost:3000`, so the API must
  be running for the dashboard to load data. They are same-origin through the
  proxy, which is why cookies work without CORS configuration.
- To reach the local app from a phone or over HTTPS, use the `expose-localhost`
  skill.
