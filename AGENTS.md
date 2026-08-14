# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project status

**The foundation is implemented.** The monorepo is scaffolded and the core
codebase exists: `packages/contracts`, `packages/observability`, `packages/crypto`,
`packages/database` (full §7 schema + repositories + job queue), `packages/optimizer`
(all nine §9 rules + guardrails), `packages/amazon-ads` (OAuth, token manager,
regional gateway, Reporting v3 + SP v3 adapters), `apps/api` (auth, CSRF, OAuth,
guarded change service), `apps/worker` (job loop, sync pipeline, recommendation
runs), and `apps/web` (all §12 screens). `docs/plan.md` remains the authoritative
specification — read it before changing behavior.

Not yet done: no end-to-end run against real Amazon credentials has happened
(Phase 1 spike), and production hardening remains incomplete. CI runs the full
suite with PostgreSQL, but local database integration tests still require a
disposable `TEST_DATABASE_URL`. Follow the phases in `docs/plan.md` §16; do not
jump ahead to automation before earlier phases are validated live.

## Project overview

The product is **Amazon Ads Optimizer for KDP Authors** ("amazon-king"): an
open-source, self-hosted, single-owner application that connects to the owner's own Amazon Ads
account, imports Sponsored Products campaign data, analyzes performance against
real KDP book economics (royalty per sale, target ACoS), produces prioritized
recommendations with evidence, and applies changes through the Amazon Ads API
**only after explicit human approval**.

Key product facts from `docs/plan.md`:

- It is an **advisory system with human approval**, not an autonomous ad bot.
  Automation is a later phase gated on weeks of observed results.
- The system is **mostly backend**: data pipeline, database, optimization engine,
  job worker, and a guarded Amazon write service. The dashboard is a thin
  control room over that backend.
- The MVP boundary is: one owner / one workspace, Sponsored Products only,
  read-only by default, deterministic recommendations, manual approval for bid
  changes and negative exact keywords. No SaaS features (no multi-client
  tenancy, billing, or team roles beyond owner).

## Established technology stack

The stack below is implemented and follows `docs/plan.md` §4. New code should
fit these boundaries unless an accepted design proposal changes them:

| Layer       | Planned choice                                                                   |
| ----------- | -------------------------------------------------------------------------------- |
| Web app     | React + Vite + TypeScript, TanStack Router, TanStack Query                       |
| UI          | Tailwind CSS + a small accessible component system                               |
| Charts      | Apache ECharts or Recharts                                                       |
| Backend API | Node.js LTS + TypeScript + Fastify                                               |
| Validation  | Zod or TypeBox at every API boundary                                             |
| Database    | Managed PostgreSQL (optionally Supabase), SQL migrations + typed query layer     |
| Jobs        | PostgreSQL-backed job queue with dedicated worker processes (no Redis initially) |
| Raw reports | S3-compatible object storage (compressed artifacts out of the DB)                |
| Secrets     | Cloud secret manager + KMS-backed envelope encryption for tokens                 |

Architecture is a **modular monolith** in a monorepo:

```text
apps/
  web/                 dashboard
  api/                 browser-facing backend and OAuth callback
  worker/              imports, reports, analysis, and scheduled jobs
packages/
  amazon-ads/          OAuth client, regional routing, API adapters (gateway)
  optimizer/           calculations and deterministic rules
  database/            migrations, queries, and repositories
  contracts/           shared validated request/response types
  observability/       logging, metrics, and error reporting
```

The web server and worker run as separate processes but remain one deployable
product.

## Build and test commands

Established so far (run from the repo root unless noted):

- Install: `pnpm install`
- Lint/format: `pnpm lint` (prettier --check); `pnpm exec prettier --write .` to fix
- Per package: `pnpm --filter <pkg> typecheck | test | build`

`apps/web` (`@amazon-king/web`) is scaffolded: Vite + React 19 + TypeScript,
TanStack Router (code-based routes) and Query, Tailwind CSS v4 via
`@tailwindcss/vite`, Recharts. Country flags use bundled `flag-icons` SVGs via
the `Flag` component (`src/components/flag.tsx`) instead of Unicode flag emoji,
which do not render on all platforms. Commands: `dev` (Vite dev server, proxies
`/api` to `http://localhost:3000`), `build` (`vite build`), `typecheck`
(`tsc -p tsconfig.json`), `test` (`vitest run --passWithNoTests`, jsdom +
Testing Library). It imports `@amazon-king/contracts` (workspace link) for API
types and validates responses with the Zod schemas at the fetch boundary.

`packages/database` (`@amazon-king/database`) is implemented: plain SQL
migrations under `migrations/` (numbered `NNNN_name.sql`, applied by
`src/migrate.ts` inside per-file transactions and recorded in
`schema_migrations`), a thin `pg` pool wrapper (`src/pool.ts`), explicit
repository modules under `src/repositories/` with parameterized SQL only, and
the PostgreSQL job queue in `src/queue.ts` (`FOR UPDATE SKIP LOCKED` + leases).
Commands: `typecheck`, `test` (vitest). Integration tests in
`src/integration.test.ts` run only when `TEST_DATABASE_URL` points at a
scratch Postgres database; otherwise they are skipped.

`apps/worker` (`@amazon-king/worker`) is implemented: the background job
worker (read-only against Amazon in the MVP). `src/loop.ts` is the
poll-claim-execute loop (one job at a time, 120 s lease heartbeated every
30 s, lease reaping, graceful SIGTERM/SIGINT shutdown). Job handlers live in
`src/jobs/` behind a type→handler map: `profile_discovery`, `structure_sync`,
`metrics_sync` (Reporting v3 orchestration: fingerprint-deduped specs, poll
resume via persisted `amazon_report_id` + the gateway `reportOwner` callback,
streaming download to `REPORT_STORAGE_DIR` with sha256, reconciliation, then
transactional fact upserts; success chains `recommendation_run`),
`recent_window_resync`, `recommendation_run` (loads structure/metrics/
economics/cooldowns and runs `@amazon-king/optimizer` over 7/14/30/60-day
windows; skips when no fresh complete metrics sync; profit rules suppressed
without KDP economics), `connection_health`, and the self-rescheduling
`schedule_tick` (15 min; cadence per plan §8, deduped via
`enqueueIfNotQueued`). Handlers depend on the `WorkerStore` interface in
`src/store.ts` (production: repositories + worker-specific SQL; tests:
in-memory fake), an injected gateway/storage/clock, and never read the wall
clock directly. Token refresh wiring is in `src/tokens.ts` (decrypt →
TokenManager → re-encrypt; dead grants mark the connection
`reconnect_required` and dead-letter its pending jobs). Commands: `dev`
(`tsx watch src/index.ts`), `start`, `typecheck`, `test` (vitest, no network
or real DB).

`apps/api` (`@amazon-king/api`) is implemented: Fastify 5 + @fastify/cookie,
cors, rate-limit. All §11 routes plus the frontend's contract extensions
(`GET /api/change-sets`, cannibalization comparison + campaign-level
negative-exact draft creation, `csrfToken` on the session response, dashboard
`daily` series + `writesDisabled`, and the cross-campaign search-term
screens: `GET /api/search-terms` + `GET /api/search-terms/:term`). Passwordless email login (magic link is **logged in
dev only**), stateless HMAC CSRF per session, single-use OAuth state marked used
before code exchange, refresh tokens envelope-encrypted via
`@amazon-king/crypto`, recent-auth (15 min) required for apply/rollback, and the
guarded write flow in `src/services/changes.ts` (fingerprint-idempotent create,
preview → re-read Amazon + before-state compare → guardrails → per-item apply →
verify; rollback is a compensating action, including verified app-created
negative exact keywords). Route handlers are thin wrappers
over injectable services (`src/services/types.js`); tests use the SQL-matching
in-memory `FakeDb` (`src/test/fake-db.ts`). Commands: `dev` (`tsx watch
src/index.ts`), `start`, `typecheck`, `test`.

`packages/optimizer` (`@amazon-king/optimizer`) is implemented: pure,
deterministic — no I/O, no wall clock (time is injected). Money is integer
micro-units internally with string decimals at boundaries. All nine §9 rules
under `src/rules/` with `*_RULE_VERSION` constants, `proposedBid` per the plan
formula (±15% clamp), guardrails (`checkGuardrails`, §10), ranking, and
smoothed conversion rates. Heavily unit-tested (146 tests) including threshold
boundaries and launch-mode/protected/cooldown suppression.

`packages/amazon-ads` (`@amazon-king/amazon-ads`) is implemented: LWA OAuth
client, `TokenManager` (serialized per-connection refresh, 5-min early skew,
circuit breaker → `reconnect_required`), regional transport honoring
`Retry-After` + full-jitter backoff, the §6 `AmazonAdsGateway` (profiles,
Reporting v3 request/poll/stream-download, SP v3 structure lists, keyword bid
updates + negative keywords with per-item 207 mapping), and strict zod
validation at the boundary. Contract fixtures live in `test/fixtures/`; tests
use injected fetch — no network.

`packages/crypto` (`@amazon-king/crypto`) is implemented: AES-256-GCM envelope
encryption for Amazon refresh tokens (dev stand-in for KMS). Master key from
`TOKEN_ENCRYPTION_KEY` (64 hex chars); versioned via `TOKEN_ENCRYPTION_KEY_V2`
etc. for rotation; ciphertext format embeds the key version.

The **Makefile** runs the whole app locally: `make run` installs deps, creates
`.env` from `.env.example`, starts PostgreSQL via `docker compose` (see
`docker-compose.yml`), applies migrations (`scripts/migrate.ts`), then starts
api (:3000), worker, and web (:5173) together. Other targets: `make setup`,
`db-up`, `migrate`, `test`, `typecheck`, `lint`, `build`, `stop`, `clean`.

## Key architectural rules (from the plan)

These are binding design constraints; code should follow them:

- **Two separate logins.** Login A: app sign-in (passwordless email/passkey,
  `HttpOnly`/`Secure`/`SameSite=Lax` session cookie, CSRF protection, rate
  limiting). Login B: Amazon OAuth connection (`advertising::campaign_management`
  scope, one-time hashed expiring state, server-side code exchange). Never mix
  the two; the app session never contains an Amazon token.
- **Browser isolation.** The browser never receives the LWA client secret,
  access token, or refresh token, and never calls the Amazon Ads API directly.
  All Amazon traffic goes through the backend gateway.
- **Gateway boundary.** All Amazon API calls go through an internal
  `AmazonAdsGateway` interface. Amazon payloads are strictly validated and
  translated to internal domain models at the boundary; the optimizer never
  depends on raw Amazon field naming. Use stable Reporting v3 for reports;
  prefer Unified API GA resources for campaign operations but keep
  product-specific Sponsored Products v3 adapters where mature. Do not build
  production reporting on beta endpoints.
- **Idempotent pipeline.** Reports are asynchronous (request → poll → download →
  validate → batch upsert with `INSERT ... ON CONFLICT DO UPDATE`). Honor
  `Retry-After` on 429s, exponential backoff with full jitter, per-region
  concurrency limits, and reconciliation checks (row counts, grain, non-negative
  counts, currency) before marking a sync complete.
- **Deterministic optimizer.** Rules only (no LLM decisions). Every rule is
  versioned, stores its exact inputs, requires minimum evidence, uses smoothed
  conversion rates, clamps bid changes to ±10–15% per cooldown period, and
  expires when data goes stale. ACoS is ad-spend-over-retail-revenue, not author
  profit — profit recommendations require user-entered KDP royalty economics and
  must be disabled (not guessed) when economics are missing.
- **Guarded writes.** Read-only is the default per profile. Applying a change
  requires: immutable change set, fresh re-read of Amazon state matching the
  `before` snapshot, guardrail re-checks, idempotency fingerprint, per-item
  result handling, post-write re-read verification, and audit logging. Rollback
  is a compensating API action, not a DB undo. A global kill switch disables all
  writes immediately.

## Data model conventions

From `docs/plan.md` §7:

- Monetary values: fixed-precision `numeric`; never aggregate across currencies
  without explicit conversion.
- Amazon IDs: text; internal PKs: `bigint generated always as identity`;
  unique constraint per Amazon external ID within its profile.
- Timestamps: timezone-aware.
- Keep attribution windows explicit — never mix e.g. `purchases7d` with
  `sales14d`.
- Separate daily fact tables per report grain (campaign, target, search term,
  advertised product, placement). Index every foreign key; add composite indexes
  matching dashboard filters; partial indexes on pending recommendations and
  runnable queue jobs.
- Queue work claimed with `FOR UPDATE SKIP LOCKED` plus leases/heartbeats.
- Workspace isolation enforced in the database (RLS if Supabase); separate
  low-privilege web role from privileged worker/migration roles.

## Security considerations

Non-negotiable requirements from `docs/plan.md` §13:

- LWA client secret lives only in the deployment secret manager — never per-user,
  never in code, never logged.
- Refresh tokens stored only encrypted (KMS/envelope encryption with versioned
  keys); decrypted only in backend/worker right before refresh; token refresh is
  serialized per connection with a lock.
- Redact authorization headers, secrets, codes, tokens, and pre-signed report
  URLs from all logs and error tracking.
- Exact allowlist for OAuth/post-login redirect destinations; one-time expiring
  state tied to the authenticated user; HTTPS and secure cookies in production;
  strict CSP; independent rate limits on login/OAuth/sync/preview/apply/rollback;
  recent re-authentication required for spend-changing actions.
- Never test write operations first against important live campaigns — use an
  Amazon test account/environment or a dedicated low-risk campaign.
- Encrypted PostgreSQL backups with point-in-time recovery; documented incident
  procedure for disabling writes, rotating secrets, invalidating sessions, and
  disconnecting Amazon.

## Testing strategy

Planned test layers (from `docs/plan.md` §14) — new code should come with tests
at the appropriate layer:

- **Unit:** ACoS/ROAS/profit/break-even-CPC math, smoothing, currency handling;
  every optimization rule at thresholds and edge cases; guardrails and cooldowns;
  Amazon payload translation; OAuth state validation; token redaction.
- **Contract/fixture:** sanitized Amazon API response fixtures per adapter;
  tolerate unknown additive fields; fail clearly on required-field changes.
- **Integration:** migrations, idempotent upserts (duplicate imports converge),
  queue lease semantics, partial Amazon batch results, serialized token refresh,
  workspace row isolation.
- **End-to-end:** sign-in; OAuth callback with bad/expired/replayed state;
  review → preview → apply → verify; stale before-state blocks writes; kill
  switch; disconnect.
- **Live API validation:** dedicated low-risk campaign, one profile, one manually
  approved action, small bid — then expand.

## Implementation phases

The plan defines Phases 0–9 with explicit "done when" acceptance criteria
(`docs/plan.md` §16). The code for Phases 2–7 exists, and open-source/CI work has
started Phase 8, but Phase 0/1 live acceptance is still incomplete. Treat the
project as alpha: do not enable real Amazon writes or begin Phase 9 automation
until the earlier live validation gates are complete.

## Language and style

- Documentation and plan material is written in English; write code, comments,
  and docs in English.
- Use strict TypeScript and the repository Prettier configuration. Run
  `pnpm check` before submitting changes.
- Keep this file current: whenever build commands, structure, or conventions are
  established, update the corresponding section instead of leaving stale text.
