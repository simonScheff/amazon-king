# amazon-king

Amazon Ads Optimizer for KDP Authors — a private, single-owner application that
connects to your own Amazon Ads account, imports Sponsored Products data,
produces deterministic, evidence-backed recommendations, and applies changes
through the Amazon Ads API **only after explicit human approval**.

The authoritative specification is [`docs/plan.md`](docs/plan.md). Engineering
conventions and architecture rules are in [`AGENTS.md`](AGENTS.md).

## Quickstart

Prerequisites: Node.js 23+, pnpm 10, Docker (for local PostgreSQL).

```sh
make run
```

This single command:

1. installs dependencies (`pnpm install`),
2. creates `.env` from `.env.example` if missing,
3. starts PostgreSQL via `docker compose` and waits for it,
4. applies database migrations,
5. starts the **api** (http://localhost:3000), the **worker**, and the **web**
   dashboard (http://localhost:5173) together. Ctrl-C stops all three.

Then open http://localhost:5173, sign in with your email (the magic login link
is printed to the **api process log** in development — no SMTP is configured),
and connect Amazon Ads.

To actually connect Amazon you need Login with Amazon credentials (plan §2):
set `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, and `AMAZON_REDIRECT_URI` in `.env`.
Set `OWNER_EMAIL` to restrict sign-in to yourself.

Other make targets: `make help`, `setup`, `db-up`, `migrate`, `test`,
`typecheck`, `lint`, `build`, `stop`, `clean`.

## Repository layout

```text
apps/
  web/        dashboard (React 19, Vite, TanStack Router/Query, Tailwind v4, Recharts)
  api/        browser-facing Fastify backend + Amazon OAuth callback
  worker/     job queue consumer: sync pipeline, recommendation runs
packages/
  contracts/    shared zod schemas for every API boundary
  database/     SQL migrations, repositories, FOR UPDATE SKIP LOCKED job queue
  optimizer/    deterministic rules engine (pure, no I/O) + guardrails
  amazon-ads/   LWA OAuth, token manager, regional gateway, Reporting v3 + SP v3 adapters
  observability/ pino logging with secret redaction
  crypto/       AES-256-GCM envelope encryption for Amazon refresh tokens
scripts/
  migrate.ts    migration CLI (make migrate)
```

## Testing

```sh
pnpm -r test        # ~300 unit/contract tests, no network or DB needed
pnpm -r typecheck
pnpm lint
```

Database integration tests are skipped unless `TEST_DATABASE_URL` points at a
scratch Postgres database:

```sh
make db-up
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king \
  pnpm --filter @amazon-king/database test
```

## Safety defaults

- Read-only per profile until you explicitly enable writes; global `KILL_SWITCH`
  env disables all Amazon writes immediately.
- Recommendations are deterministic rules (no LLM decisions), versioned, with
  stored evidence; profit rules stay disabled until you enter KDP royalty
  economics per book.
- Applying a change re-reads live Amazon state, compares it to the approved
  before-snapshot, re-runs guardrails, maps per-item results, and verifies the
  post-write state. Rollback is a compensating API action.
- The browser never sees Amazon tokens or the LWA client secret; refresh tokens
  are stored encrypted and decrypted only just before a token refresh.
