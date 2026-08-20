---
title: Commands
description: Every Makefile target, pnpm script, and per-package command for developing, testing, and operating amazon-king.
---

# Commands

All commands run from the repository root unless noted. The Makefile loads
`.env` into every recipe when the file exists, so `DATABASE_URL` and friends
are available to each target.

## Makefile targets

| Target            | Behavior |
| ----------------- | -------- |
| `make help`       | Lists the available targets (the default goal). |
| `make install`    | `pnpm install` — install workspace dependencies. |
| `make setup`      | `install`, then create `.env` from `.env.example` if missing (set `LWA_CLIENT_ID`/`LWA_CLIENT_SECRET` afterwards). |
| `make preflight`  | Fail fast unless `DATABASE_URL`, `SESSION_SECRET`, `LWA_CLIENT_ID`, and `LWA_CLIENT_SECRET` are set in `.env`. |
| `make db-up`      | `docker compose up -d db`, then wait up to 30 s for `pg_isready` on the `amazon-king-db` container. |
| `make migrate`    | Apply database migrations: sources `.env`, then `pnpm exec tsx scripts/migrate.ts`. |
| `make run`        | `setup` → `preflight` → `db-up` → `migrate`, then start api (`http://localhost:3000`), worker, and web (`http://localhost:5173`) together. Ctrl-C stops all three. |
| `make dev`        | Alias for `run`. |
| `make test`       | `pnpm -r test` — every package's tests. |
| `make typecheck`  | `pnpm -r typecheck`. |
| `make lint`       | `pnpm lint` — `prettier --check .`. Fix with `pnpm exec prettier --write .`. |
| `make build`      | `pnpm --filter @amazon-king/web build` — production web build. |
| `make check`      | `pnpm check` — formatting, typechecks, tests, and the production web build. |
| `make prod-config`   | Create `.env.production` from `.env.production.example` if missing (git-ignored; replace every `change-me` value). |
| `make prod-preflight` | Fail unless `.env.production` exists and contains no `change-me` placeholder. |
| `make prod-up`    | `prod-preflight`, then `docker compose --env-file .env.production -f compose.production.yml up -d --build` — build and start the self-hosted stack (db, migrate, api, worker, web). |
| `make prod-logs`  | Follow the production stack logs (`logs -f`). |
| `make prod-stop`  | Stop the production stack (`down`) without deleting persistent data. |
| `make stop`       | Stop local PostgreSQL (`docker compose down`). |
| `make clean`      | `stop`, then `docker compose down -v` and `rm -rf .data` — **destroys all local data** (database volume and downloaded reports). |

## Root pnpm scripts

| Script           | Runs | Notes |
| ---------------- | ---- | ----- |
| `pnpm dev`       | `pnpm -r --parallel --if-present dev` | Starts every workspace dev server/watch process: api, worker, web, and the VitePress docs site (`website/`). |
| `pnpm build`     | `pnpm -r --if-present build` | Every package with a `build` script: web and the docs site (`website/`). |
| `pnpm test`      | `pnpm -r test` | |
| `pnpm typecheck` | `pnpm -r typecheck` | |
| `pnpm lint`      | `prettier --check .` | |
| `pnpm check`     | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | The full pre-submit gate. |

## Per-package scripts

Every package supports `pnpm --filter <name> <script>`:

| Package                    | dev | start | build | test | typecheck |
| -------------------------- | --- | ----- | ----- | ---- | --------- |
| `@amazon-king/api`         | `tsx watch src/index.ts` | `tsx src/index.ts` | — | vitest | tsc |
| `@amazon-king/worker`      | `tsx watch src/index.ts` | `tsx src/index.ts` | — | vitest | tsc |
| `@amazon-king/web`         | `vite` | — | `vite build` | vitest (jsdom + Testing Library) | tsc |
| `@amazon-king/database`    | — | — | — | vitest | tsc |
| `@amazon-king/optimizer`   | — | — | — | vitest | tsc |
| `@amazon-king/amazon-ads`  | — | — | — | vitest | tsc |
| `@amazon-king/contracts`   | — | — | — | vitest | tsc |
| `@amazon-king/crypto`      | — | — | — | vitest | tsc |
| `@amazon-king/observability` | — | — | — | vitest | tsc |

Test scripts use `vitest run --passWithNoTests` (contracts and observability:
plain `vitest run`), so a package without tests never fails the suite. Api,
worker, and package tests need neither network nor a real database — except
the database integration suite below.

## Database migrations

```bash
make migrate
# or directly:
pnpm exec tsx scripts/migrate.ts
```

Requires `DATABASE_URL`. Applies all pending SQL migrations from
`packages/database/migrations` (numbered `NNNN_name.sql`), each in its own
transaction, recording applied files in `schema_migrations`. Prints
`Applied migrations: …` or `Database is up to date — no pending migrations.`

## Database integration tests

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king_test \
  pnpm --filter @amazon-king/database test
```

The suite **drops and recreates the `public` schema** — point it only at a
disposable scratch database, never at real data. Without `TEST_DATABASE_URL`
the integration tests are skipped and the rest of the suite still passes.

## Docs site

The documentation site (VitePress) lives in `website/` and has its own
dependencies:

```bash
cd website
pnpm install
pnpm dev      # local dev server with hot reload
pnpm build    # static build to website/.vitepress/dist
pnpm preview  # serve the production build locally
```

## Related reading

- [Installation](/guide/installation) — first-time setup walkthrough
- [Self-hosting](/guide/self-hosting) — the production compose workflow
- [Operations](/guide/operations) — day-two runbook
