# amazon-king

[![CI](https://github.com/simonScheff/amazon-king/actions/workflows/ci.yml/badge.svg)](https://github.com/simonScheff/amazon-king/actions/workflows/ci.yml)
[![CodeQL](https://github.com/simonScheff/amazon-king/actions/workflows/codeql.yml/badge.svg)](https://github.com/simonScheff/amazon-king/actions/workflows/codeql.yml)
[![Docs](https://github.com/simonScheff/amazon-king/actions/workflows/docs.yml/badge.svg)](https://github.com/simonScheff/amazon-king/actions/workflows/docs.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**[Documentation →](https://simonscheff.github.io/amazon-king/)**

amazon-king is an open-source, self-hosted Amazon Ads optimizer for KDP
authors. It imports Sponsored Products data, evaluates it against user-entered
book economics, produces deterministic recommendations with evidence, and
applies changes only after explicit human approval.

> [!WARNING]
> This project is pre-1.0 alpha software. Its adapters and write flow have not
> completed an end-to-end validation against real Amazon credentials. Keep
> `KILL_SWITCH=true`; do not use it for unattended writes or important live
> campaigns.

This is an independent project and is not affiliated with or endorsed by
Amazon. Amazon Ads, Kindle, and KDP are trademarks of their respective owners.

## Product boundary

- One owner and one workspace per deployment
- Sponsored Products only
- Read-only profiles and a global write kill switch by default
- Deterministic, versioned recommendations; no LLM spending decisions
- Profit recommendations disabled until royalty economics are provided
- Manual approval, stale-state checks, guardrails, verification, and audit logs
  around every supported write

The authoritative product and architecture specification is
[docs/plan.md](docs/plan.md). Contributor-facing engineering rules are in
[AGENTS.md](AGENTS.md).

## Amazon API access

The repository never provides Amazon credentials. Every self-hoster must apply
for Amazon Ads API access for their own advertiser account, create their own
Login with Amazon application, and keep its client secret private.

Amazon distinguishes direct advertisers using the API for their own account
from partners operating software for other advertisers. A centrally hosted
service for other users requires the appropriate Amazon Partner registration;
developer credentials must never be shared through this repository or between
unrelated self-hosters.

- [Amazon Ads API access](https://advertising.amazon.com/about-api)
- [Amazon Ads Partner Network policies](https://advertising.amazon.com/resources/ad-policy/partner-network-policies)

## Local development

Requirements: Node.js 20 or newer, pnpm 10, Docker, and GNU Make.

```sh
make setup
```

Edit the generated `.env` and set at least `LWA_CLIENT_ID` and
`LWA_CLIENT_SECRET`, then run:

```sh
make run
```

This starts PostgreSQL, applies migrations, and runs the API on port 3000, the
worker, and the Vite dashboard on port 5173. In development only, magic sign-in
links are printed to the API log. SMTP is mandatory in production.

Keep `KILL_SWITCH=true` while developing. Profiles also remain read-only until
write access is explicitly enabled for each profile.

## Self-hosting

The included production Compose stack runs PostgreSQL, migrations, the API,
worker, and web proxy. It requires HTTPS termination, SMTP, private secrets, and
operator-managed backups. See [docs/self-hosting.md](docs/self-hosting.md) and
[docs/operations.md](docs/operations.md) before exposing an instance.

```sh
make prod-config
# Replace every change-me value in .env.production.
make prod-up
```

## Verification

```sh
pnpm check
```

The command checks formatting, TypeScript, unit and contract tests, database
tests when `TEST_DATABASE_URL` is present, and the production web build.
Database integration tests drop and recreate the target database's `public`
schema; use a disposable database only.

## Repository layout

```text
apps/
  web/          React dashboard
  api/          Fastify browser API, sessions, OAuth, guarded writes
  worker/       report pipeline, sync jobs, recommendation runs
packages/
  amazon-ads/   OAuth, token manager, regional gateway, API adapters
  contracts/    shared Zod boundary schemas
  crypto/       encrypted Amazon refresh-token storage
  database/     migrations, repositories, PostgreSQL job queue
  observability/ structured logging and secret redaction
  optimizer/    pure deterministic recommendation rules and guardrails
deploy/         production web proxy configuration
docs/           product plan and operator documentation
```

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Commits
must be signed off under the [Developer Certificate of Origin](DCO.txt). Never
submit real Amazon Ads data, credentials, report URLs, or unsanitized logs.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Community expectations and project decision-making are documented in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [GOVERNANCE.md](GOVERNANCE.md).

## License

Licensed under the [Apache License 2.0](LICENSE). The license does not grant
rights to Amazon trademarks; see [NOTICE](NOTICE).
