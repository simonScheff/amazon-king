---
name: add-migration
description: Add a database migration to packages/database and wire it through repositories and tests. Use when adding or changing a table, column, index, enum value, change-set kind, or action type.
whenToUse: When a change needs a schema change in packages/database/migrations, or when asked how migrations work in this repo
---

Migrations are plain SQL under `packages/database/migrations/`, numbered
`NNNN_name.sql`. `src/migrate.ts` applies each file inside its own transaction
and records it in `schema_migrations`.

## Steps

1. **Pick the next number.** List `packages/database/migrations/` and take the
   highest number plus one. Never reuse or renumber.
2. **Write the SQL** following the root `AGENTS.md` data-model conventions:
   fixed-precision `numeric` for money, `bigint generated always as identity`
   for internal PKs, text for Amazon ids with a unique constraint per Amazon
   external id within its profile, timezone-aware timestamps, an index on every
   foreign key, and composite indexes matching the dashboard filters that will
   query it.
3. **Never edit an applied migration.** Migrations are append-only; correct a
   mistake with a new file. Editing one that has run leaves developers' and
   CI's databases silently diverged.
4. **Keep each file transactional.** The runner wraps the file, so do not add
   `BEGIN`/`COMMIT`. If a statement cannot run inside a transaction (for example
   `CREATE INDEX CONCURRENTLY`), it needs its own file and a note explaining
   why.
5. **Update the repository layer.** Queries live in
   `packages/database/src/repositories/` and must be parameterized — no string
   interpolation of user input.
6. **Update the contracts** in `packages/contracts` if the shape crosses the API
   boundary, so the web app's Zod validation stays truthful.
7. **Apply it locally:** `make migrate`. A pending migration shows up in the UI
   only as a generic "Internal server error"; see the `local-stack` skill.
8. **Test it.** Add coverage to `packages/database/src/integration.test.ts`,
   which runs only when `TEST_DATABASE_URL` points at a scratch database and is
   skipped otherwise. CI runs it against real PostgreSQL, so a migration that
   only works on your machine will fail there. Duplicate imports must converge —
   upserts are expected to be idempotent.
9. Note the new file in `packages/database/AGENTS.md` only if it introduces a
   decision worth knowing before touching that schema, not as a changelog entry.

## Cases that need more than SQL

- **New change-set kind or action type.** These are enumerated in the schema, so
  a new one needs a migration in addition to the TypeScript union, plus handling
  in the guarded apply path in `apps/api/src/services/changes.ts`.
- **New daily fact column.** Backfill is usually impossible — Amazon reports are
  re-imported, not rewritten — so queries must degrade gracefully for rows
  imported before the column existed. The `greatest(units, orders)` royalty
  pattern is the reference example.
- **Anything the worker dedupes on.** `recommendation_dismissals` is keyed by
  the worker's recommendation identity tuple using `unique nulls not distinct`.
  If that identity changes, the key must change with it or dismissals will stop
  matching.
