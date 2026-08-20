# packages/database — `@amazon-king/database`

Migrations, queries, repositories, and the job queue. Read the root `AGENTS.md`
for the data-model conventions that every table here must follow.

## Commands

`typecheck`, `test` (vitest).

Integration tests in `src/integration.test.ts` run only when
`TEST_DATABASE_URL` points at a scratch Postgres database; otherwise they skip
silently. CI runs them against a real PostgreSQL service.

## Layout and rules

- `migrations/` — plain SQL, numbered `NNNN_name.sql`, applied by
  `src/migrate.ts` inside a per-file transaction and recorded in
  `schema_migrations`. Migrations are append-only; never edit an applied file.
- `src/pool.ts` — a thin `pg` pool wrapper.
- `src/repositories/` — explicit modules with **parameterized SQL only**. No
  query builder, no string interpolation of user input.
- `src/queue.ts` — the PostgreSQL job queue, claiming with
  `FOR UPDATE SKIP LOCKED` plus leases.

To add a migration, use the `add-migration` skill.

## Schema decisions worth knowing before you touch them

- `recommendation_dismissals` is keyed by the same identity tuple the worker
  dedupes on, using `unique nulls not distinct` so the nullable parts compare
  equal, with a normalized `search_term`. Rejecting a recommendation writes a
  row here so the next run does not raise the identical finding again. If you
  change the worker's dedupe identity, this key has to move with it.
- Daily fact tables carry `units`, `units_sold_clicks7d`, and
  `units_sold_clicks14d` alongside orders. `units` mirrors `unitsSoldClicks7d`
  the same way `orders` mirrors `purchases7d`. Royalty is valued per copy, so
  queries read `greatest(units, orders)` — facts imported before these columns
  existed have no units and degrade to orders.
- Change-set kinds and action types are enumerated in the schema:
  `campaign_creation` with the four `create_*` actions, and `campaign_update`
  with `update_campaign_state` / `update_campaign_name`. A new action type needs
  a migration, not just TypeScript.
- `negative_targets` mirrors `negative_keywords` for `ASIN_SAME_AS` exclusions.
  Structure sync is the source of truth; the optimizer folds them into
  cannibalization suppression so an ASIN conflict already resolved on Amazon is
  not re-raised from historical search-term spend. Campaign detail reads them
  through `dashboard.listNegativeTargetRows` (same book-filter `EXISTS` as
  `listNegativeKeywordRows`).
- `book_profile_links` is unique on `(profile_id, marketplace_asin)` as well as
  `(book_id, profile_id)`. Marketplace links come from advertised ASINs or from
  owner-confirmed `linkBookToProfiles` when a book has no ads in that market
  yet; two catalog books cannot claim the same ASIN in one profile.
