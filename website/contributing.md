---
title: Contributing
description: How to contribute to amazon-king — dev setup, repository layout, testing layers, style rules, DCO sign-off, and pull request expectations.
---

# Contributing

Thank you for helping improve amazon-king. The project is an early alpha and
prioritizes advertiser safety, deterministic behavior, and data privacy over
feature breadth. This page adapts the repository's `CONTRIBUTING.md` and
`AGENTS.md`; when in doubt, those files are authoritative.

## Before you start

- Read the `README.md`, the specification in `docs/plan.md`, and `AGENTS.md`
  at the repository root. `docs/plan.md` is the authoritative spec — read it
  before changing behavior.
- Discuss large behavioral or architectural changes in an issue before writing
  them.
- Never attach real Amazon Ads data, credentials, report URLs, account IDs, or
  unsanitized logs to an issue or pull request.
- Do not test write operations against real campaigns. Tests must use injected
  fakes, synthetic fixtures, or an Amazon-provided test environment.

## Development setup

Requirements: Node.js 20 or newer, pnpm 10, Docker, and GNU Make.

```sh
make setup    # install dependencies, create .env from .env.example
make db-up    # start PostgreSQL via docker compose
make migrate  # apply SQL migrations
pnpm check    # typecheck + lint + tests across the workspace
```

`make run` goes further and starts the full app (API on :3000, worker, web on
:5173). Other Make targets: `db-up`, `migrate`, `test`, `typecheck`, `lint`,
`build`, `stop`, `clean`. See the [command reference](/reference/commands).

## Repository layout

The monorepo is a modular monolith: the API and worker are separate processes
but one deployable product.

| Path                    | Package                  | Purpose                                                            |
| ----------------------- | ------------------------ | ------------------------------------------------------------------ |
| `apps/web`              | `@amazon-king/web`       | React + Vite dashboard (TanStack Router/Query, Tailwind)           |
| `apps/api`              | `@amazon-king/api`       | Fastify backend: auth, OAuth, read routes, guarded change service  |
| `apps/worker`           | `@amazon-king/worker`    | Job loop, sync pipeline, recommendation runs                       |
| `packages/amazon-ads`   | `@amazon-king/amazon-ads` | OAuth client, token manager, regional gateway, API adapters       |
| `packages/optimizer`    | `@amazon-king/optimizer` | Pure, deterministic rules, guardrails, ranking (no I/O)            |
| `packages/database`     | `@amazon-king/database`  | SQL migrations, repositories, PostgreSQL job queue                 |
| `packages/contracts`    | `@amazon-king/contracts` | Shared zod-validated request/response types                        |
| `packages/observability` | `@amazon-king/observability` | Logging, metrics, error reporting                            |
| `packages/crypto`       | `@amazon-king/crypto`    | AES-256-GCM envelope encryption for refresh tokens                 |
| `website/`              | —                        | This documentation site (VitePress)                                |

## Testing layers

Match your tests to the layer you changed:

- **Unit** — the default for most work: optimizer math and rules at thresholds
  and edge cases, guardrails and cooldowns, Amazon payload translation, OAuth
  state validation, token redaction. Run per package with
  `pnpm --filter <pkg> test`.
- **Contract/fixture** — sanitized Amazon API response fixtures live in
  `packages/amazon-ads/test/fixtures/`; adapters must tolerate unknown
  additive fields and fail clearly on required-field changes. Tests use
  injected fetch — never the network.
- **Integration** — migrations, idempotent upserts, queue lease semantics,
  serialized token refresh. These run only when `TEST_DATABASE_URL` points at
  a **disposable** PostgreSQL database; the suite drops and recreates the
  `public` schema, so never point it at data you care about.
- **End-to-end** — sign-in, OAuth callback edge cases, the review → preview →
  apply → verify flow, kill switch, disconnect.
- **Live API validation** — a dedicated low-risk campaign, one profile, one
  manually approved action, small bid. This comes last, after everything
  above is green, and is a maintainer-led acceptance gate rather than a
  contributor task.

API and worker services take injected dependencies; tests use the in-memory
`FakeDb` (`apps/api/src/test/fake-db.ts`) and fake worker stores — no real
database or network is needed for the unit suites.

## Style

- Strict TypeScript, formatted with the repository Prettier configuration.
- Run `pnpm lint` (prettier check) and `pnpm check` before opening a pull
  request; `pnpm exec prettier --write .` fixes formatting.
- Code, comments, and docs are written in English.
- Keep changes minimal and consistent with the surrounding code; validation
  happens at every API boundary with the shared contract schemas.

## DCO sign-off

Every commit must be signed off to certify the Developer Certificate of
Origin (`DCO.txt` at the repository root):

```sh
git commit --signoff
```

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.

## Pull request expectations

- Keep changes focused — one concern per pull request.
- Include tests at the appropriate layer (see above).
- Run `pnpm check` before opening the pull request; CI runs the full suite
  with PostgreSQL.
- Update documentation when behavior, configuration, or project status
  changes — including `AGENTS.md` when build commands, structure, or
  conventions change.
- Commit messages should explain the intent of the change.

## Project governance

- `CODE_OF_CONDUCT.md` — expected behavior in project spaces.
- `GOVERNANCE.md` — how decisions and maintainership work.
- `SECURITY.md` — how to report vulnerabilities (privately, via GitHub
  security advisories).

## Editing these docs

The documentation site lives in `website/` and is built with VitePress. Pages
are plain Markdown with YAML frontmatter (`title` and `description`); the
sidebar and navigation live in `website/.vitepress/config.mts`.

```sh
cd website
pnpm dev       # local dev server with hot reload
pnpm build     # production build
pnpm preview   # serve the production build locally
```

The site deploys to GitHub Pages via GitHub Actions on merge to `main`, so no
manual publishing step is needed — a merged pull request is enough.
