# Contributing to amazon-king

Thank you for helping improve amazon-king. The project is an early alpha and
prioritizes advertiser safety, deterministic behavior, and data privacy over
feature breadth.

## Before you start

- Read [README.md](README.md), [docs/plan.md](docs/plan.md), and [AGENTS.md](AGENTS.md).
- Discuss large behavioral or architectural changes in an issue before writing
  them.
- Never attach real Amazon Ads data, credentials, report URLs, account IDs, or
  unsanitized logs to an issue or pull request.
- Do not test write operations against a real campaign. Tests must use injected
  fakes, synthetic fixtures, or an Amazon-provided test environment.

## Local development

Requirements: Node.js 20 or newer, pnpm 10, Docker, and GNU Make.

```sh
make setup
make db-up
make migrate
pnpm check
```

Database integration tests require a disposable PostgreSQL database. The test
suite drops and recreates its `public` schema, so never point
`TEST_DATABASE_URL` at a database containing useful data.

## Pull requests

Keep changes focused and include tests at the appropriate layer. Run
`pnpm check` before opening a pull request. Update documentation when behavior,
configuration, or project status changes.

Commit messages should explain the intent of the change. Every commit must be
signed off to certify the [Developer Certificate of Origin](DCO.txt):

```sh
git commit --signoff
```

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.
