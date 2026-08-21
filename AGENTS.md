# AGENTS.md

Guidance for AI coding agents working in this repository.

## Where the rest of the context lives

This file holds only what applies to every task. Detail lives next to the code.

**Before changing code in a package, read that package's `AGENTS.md`:**

| Path                  | Covers                                                         |
| --------------------- | -------------------------------------------------------------- |
| `apps/web`            | Dashboard, PWA install gate, product filter, campaign wizard   |
| `apps/api`            | Routes, guarded write flow, auth, the `books` filter           |
| `apps/worker`         | Job loop, `metrics_sync` orchestration, recommendation runs    |
| `packages/database`   | Migrations, repositories, job queue, schema decisions          |
| `packages/optimizer`  | Purity contract, the nine rules, negatives and copy accounting |
| `packages/amazon-ads` | Gateway boundary, token manager, entity creation chain         |

`packages/contracts` (shared validated request/response types),
`packages/crypto`, and `packages/observability` are small enough to read
directly.

**Procedural workflows are skills in `.agents/skills/`:**

| Skill                        | Use it to                                             |
| ---------------------------- | ----------------------------------------------------- |
| `local-stack`                | Run and troubleshoot the app locally                  |
| `add-migration`              | Add a database migration and wire it through          |
| `add-optimizer-rule`         | Add or change a recommendation rule                   |
| `update-docs-site`           | Update the public VitePress docs site                 |
| `update-website-screenshots` | Refresh the docs screenshots with the current UI      |
| `live-amazon-validation`     | Gate any run against real Amazon credentials          |
| `expose-localhost`           | Share the local dev server over a public HTTPS tunnel |

## Project overview

The product is **Amazon Ads Optimizer for KDP Authors** ("amazon-king"): an
open-source, self-hosted, single-owner application that connects to the owner's
own Amazon Ads account, imports Sponsored Products campaign data, analyzes
performance against real KDP book economics (royalty per sale, target ACoS),
produces prioritized recommendations with evidence, and applies changes through
the Amazon Ads API **only after explicit human approval**.

- It is an **advisory system with human approval**, not an autonomous ad bot.
  Automation is a later phase gated on weeks of observed results.
- The system is **mostly backend**: data pipeline, database, optimization
  engine, job worker, and a guarded Amazon write service. The dashboard is a
  thin control room over that backend.
- The MVP boundary is one owner, one workspace, Sponsored Products only,
  read-only by default, deterministic recommendations, and manual approval for
  bid changes and negative exact keywords. No SaaS features — no multi-client
  tenancy, billing, or team roles beyond owner.

## Project status

Treat the project as **alpha**. The core features — Amazon connection, data
ingestion, KDP economics, dashboard, recommendation engine, and human-approved
writes — are implemented, and open-source/CI hardening has started, but no
end-to-end run against real Amazon credentials has happened and production
hardening is incomplete.

Do not enable real Amazon writes or begin automation work until live validation
is complete — follow the `live-amazon-validation` skill.

## Technology stack

New code should fit these boundaries unless an accepted design proposal changes
them.

| Layer       | Choice                                                                           |
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

The public documentation site is `website/` (VitePress), a pnpm workspace member
that deploys to GitHub Pages. Keep it in sync when changing behavior, routes,
env vars, or commands — see the `update-docs-site` skill.

## Build and test commands

Run from the repo root.

- Install: `pnpm install`
- Everything: `pnpm check` (lint, typecheck, test, build) — run this before
  submitting changes
- Individually: `pnpm lint` (`prettier --check .`; `pnpm exec prettier --write .`
  to fix), `pnpm typecheck`, `pnpm test`, `pnpm build`
- Per package: `pnpm --filter <pkg> typecheck | test | build`

The **Makefile** runs the whole app locally — `make run` handles deps, `.env`,
PostgreSQL, migrations, then starts api (:3000), worker, and web (:5173)
together. `make help` lists every target, including the `prod-*` self-hosting
stack. For local setup and troubleshooting, use the `local-stack` skill.

## Key architectural rules

These are binding design constraints; code must follow them.

- **Two separate logins.** Login A: app sign-in (passwordless email/passkey,
  `HttpOnly`/`Secure`/`SameSite=Lax` session cookie, CSRF protection, rate
  limiting). Login B: Amazon OAuth connection
  (`advertising::campaign_management` scope, one-time hashed expiring state,
  server-side code exchange). Never mix the two; the app session never contains
  an Amazon token.
- **Browser isolation.** The browser never receives the LWA client secret,
  access token, or refresh token, and never calls the Amazon Ads API directly.
  All Amazon traffic goes through the backend gateway.
- **Gateway boundary.** All Amazon API calls go through the internal
  `AmazonAdsGateway` interface. Amazon payloads are strictly validated and
  translated to internal domain models at the boundary; the optimizer never
  depends on raw Amazon field naming. Use stable Reporting v3 for reports;
  prefer Unified API GA resources for campaign operations but keep
  product-specific Sponsored Products v3 adapters where mature. Do not build
  production reporting on beta endpoints.
- **Idempotent pipeline.** Reports are asynchronous: request → poll → download →
  validate → batch upsert with `INSERT ... ON CONFLICT DO UPDATE`. Honor
  `Retry-After` on 429s, exponential backoff with full jitter, per-region
  concurrency limits, and reconciliation checks (row counts, grain, non-negative
  counts, currency) before marking a sync complete.
- **Deterministic optimizer.** Rules only, no LLM decisions. Every rule is
  versioned, stores its exact inputs, requires minimum evidence, uses smoothed
  conversion rates, clamps bid changes to ±10–15% per cooldown period, and
  expires when data goes stale. ACoS is ad-spend-over-retail-revenue, not author
  profit — profit recommendations require user-entered KDP royalty economics and
  must be disabled, not guessed, when economics are missing.
- **Royalty is earned per copy.** KDP pays per copy sold, so one order of three
  copies earns three royalties. Value royalty on copies —
  `greatest(units, orders)` in SQL, `royaltyCopies(orders, units)` in the
  optimizer — never on order counts. Facts imported before units were captured
  degrade to orders, which is safe because Amazon never reports fewer units than
  orders.
- **Guarded writes.** Read-only is the default per profile. Applying a change
  requires an immutable change set, a fresh re-read of Amazon state matching the
  `before` snapshot, guardrail re-checks, an idempotency fingerprint, per-item
  result handling, post-write re-read verification, and audit logging. Rollback
  is a compensating API action, not a DB undo. A global kill switch disables all
  writes immediately.

## Data model conventions

- Monetary values: fixed-precision `numeric`; never aggregate across currencies
  without explicit conversion. The one explicit conversion is the all-market
  dashboard view: read-side only, cross-rated through the USD-pivot `fx_rates`
  table in SQL at each fact's own metric date. The surface around it:
  `GET /api/dashboard/summary` accepts `country=all` plus an optional
  `currency` (default the workspace's `display_currency`, set via
  `PATCH /api/workspace/settings`), rates arrive via the worker's daily
  `fx_sync` job (`FX_RATES_BASE_URL`, Frankfurter), and the optimizer,
  recommendations, and writes keep working in native currency — conversion
  never touches stored facts.
- Amazon IDs: text; internal PKs: `bigint generated always as identity`; unique
  constraint per Amazon external ID within its profile.
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

Non-negotiable requirements:

- The LWA client secret lives only in the deployment secret manager — never
  per-user, never in code, never logged.
- Refresh tokens are stored only encrypted, via `@amazon-king/crypto`
  (AES-256-GCM envelope encryption, a dev stand-in for KMS; master key from
  `TOKEN_ENCRYPTION_KEY`, 64 hex chars, versioned via `TOKEN_ENCRYPTION_KEY_V2`
  and friends, with the key version embedded in the ciphertext). Decrypt only in
  the backend or worker immediately before refresh, and serialize refresh per
  connection with a lock.
- Redact authorization headers, secrets, codes, tokens, and pre-signed report
  URLs from all logs and error tracking.
- Exact allowlist for OAuth and post-login redirect destinations; one-time
  expiring state tied to the authenticated user; HTTPS and secure cookies in
  production; strict CSP; independent rate limits on
  login/OAuth/sync/preview/apply/rollback; recent re-authentication required for
  spend-changing actions.
- Never test write operations first against important live campaigns — use an
  Amazon test account or a dedicated low-risk campaign.
- Encrypted PostgreSQL backups with point-in-time recovery; a documented
  incident procedure for disabling writes, rotating secrets, invalidating
  sessions, and disconnecting Amazon.

## Testing strategy

New code should come with tests at the appropriate layer:

- **Unit:** ACoS/ROAS/profit/break-even-CPC math, smoothing, currency handling;
  every optimization rule at thresholds and edge cases; guardrails and
  cooldowns; Amazon payload translation; OAuth state validation; token
  redaction.
- **Contract/fixture:** sanitized Amazon API response fixtures per adapter;
  tolerate unknown additive fields; fail clearly on required-field changes.
- **Integration:** migrations, idempotent upserts (duplicate imports converge),
  queue lease semantics, partial Amazon batch results, serialized token refresh,
  workspace row isolation.
- **End-to-end:** sign-in; OAuth callback with bad, expired, or replayed state;
  review → preview → apply → verify; stale before-state blocks writes; kill
  switch; disconnect.
- **Live API validation:** see the `live-amazon-validation` skill.

## Language and style

- Write code, comments, and documentation in English.
- Use strict TypeScript and the repository Prettier configuration.
- Keep agent documentation current. When build commands, structure, or
  conventions change, update the file that owns that topic — this one for
  cross-cutting rules, the package's `AGENTS.md` for local detail — instead of
  leaving stale text behind.
