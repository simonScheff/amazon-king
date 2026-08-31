# packages/database — `@amazon-king/database`

Migrations, queries, repositories, and the job queue. Read the root `AGENTS.md`
for the data-model conventions that every table here must follow.

## Commands

`typecheck`, `test` (vitest).

Integration tests in `src/integration.test.ts` run only when
`TEST_DATABASE_URL` points at a scratch Postgres database; otherwise they skip
silently. CI runs them against a real PostgreSQL service. **Hard rail:** the
suite drops the public schema in `beforeAll`, so it refuses to start unless
the database name in `TEST_DATABASE_URL` contains `test` (2026-08-28: a run
with `TEST_DATABASE_URL=$DATABASE_URL` wiped the development database; do not
weaken this check). Local backups: `make backup` (also runs automatically on
`make run`, and daily via the owner's crontab), `make restore DUMP=…`.

## Layout and rules

- `migrations/` — plain SQL, numbered `NNNN_name.sql`, applied by
  `src/migrate.ts` inside a per-file transaction and recorded in
  `schema_migrations`. Migrations are append-only; never edit an applied file.
- `src/pool.ts` — a thin `pg` pool wrapper.
- `src/repositories/` — explicit modules with **parameterized SQL only**. No
  query builder, no string interpolation of user input. The spend explorer's
  per-entity daily series live in `repositories/spend.ts` (grain-parameterized
  over static fragments; native plus FX-converted variants reusing
  `fxRateJoins` from `dashboard.ts`).
- `src/change-drafts.ts` — change-set drafting shared by apps/api and
  apps/worker: `campaignNegativeSpec` (ASIN term → `add_negative_target`,
  else `add_negative_exact`) and `createSearchTermExclusionSet`
  (fingerprint-idempotent per-profile negatives sets with
  `metadata.strategy: "search_term_exclusion"`). Only drafting lives here;
  the guarded apply path stays in apps/api.
- `src/queue.ts` — the PostgreSQL job queue, claiming with
  `FOR UPDATE SKIP LOCKED` plus leases. `enqueueIfNotQueued` enqueues only
  when no pending/running job with a containing payload exists (the API's
  manual `fx_sync` trigger uses it; the worker store carries the same query
  for its schedule tick).

To add a migration, use the `add-migration` skill.

## Schema decisions worth knowing before you touch them

- `recommendation_dismissals` is keyed by the same identity tuple the worker
  dedupes on, using `unique nulls not distinct` so the nullable parts compare
  equal, with a normalized `search_term`. Rejecting a recommendation writes a
  row here so the next run does not raise the identical finding again. If you
  change the worker's dedupe identity, this key has to move with it.
- `search_term_exclusions` (migration 0018) is the workspace's persistent
  exclusion list: terms normalized (trimmed + lowercased) at write time — the
  same convention as `recommendation_dismissals` — unique per workspace.
  `repositories/exclusions.ts` adds with `ON CONFLICT DO NOTHING` (re-adding
  returns the existing row), and removing a row never touches negatives
  already applied on Amazon. The API writes it on Exclude everywhere; the
  worker reads it for the enforcement pass and feeds it to the optimizer as
  `protectedSearchTerms`.
- Daily fact tables carry `units`, `units_sold_clicks7d`, and
  `units_sold_clicks14d` alongside orders. `units` mirrors `unitsSoldClicks7d`
  the same way `orders` mirrors `purchases7d`; those 7d columns remain the
  worker/optimizer input. Browser-facing read queries (dashboard repositories,
  `metrics.dashboardTotals`) instead expose the 14-day click-attribution
  columns (`purchases14d`, `sales14d`, `units_sold_clicks14d`) so the app
  matches the Amazon Ads console. Royalty is valued per copy on the same 14d
  window, so those queries read
  `greatest(units_sold_clicks14d, purchases14d)` — facts imported before the
  units columns existed have no units and degrade to orders.
- Change-set kinds and action types are enumerated in the schema:
  `campaign_creation` with the four `create_*` actions, and `campaign_update`
  with `update_campaign_state` / `update_campaign_name`. A new action type needs
  a migration, not just TypeScript.
- `negative_targets` mirrors `negative_keywords` for `ASIN_SAME_AS` exclusions.
  Structure sync is the source of truth; the optimizer folds them into
  cannibalization suppression so an ASIN conflict already resolved on Amazon is
  not re-raised from historical search-term spend. Campaign detail reads them
  through `dashboard.listNegativeTargetRows` (same book-filter `EXISTS` as
  `listNegativeKeywordRows`). The workspace `/negatives` inventory is a
  read-time rollup (`listNegativeRollupRows`, `listNegativeSpecRows`,
  `listNegativeServingRows`) grouped by normalized keyword text or uppercased
  ASIN — Amazon exposes no creation date, so `firstSeenAt` is `created_at`.
- `book_profile_links` is unique on `(profile_id, marketplace_asin)` as well as
  `(book_id, profile_id)`. Marketplace links come from advertised ASINs or from
  owner-confirmed `linkBookToProfiles` when a book has no ads in that market
  yet; two catalog books cannot claim the same ASIN in one profile.
- `fx_rates` stores daily exchange-rate fixings against a single USD pivot and
  is append-only: `repositories/fx.ts` inserts with `ON CONFLICT DO NOTHING`,
  so a stored rate is never rewritten and converted numbers stay reproducible.
  Dates without a fixing (weekends/holidays) have no row; readers fall back to
  the most recent earlier `rate_date`. `workspaces.display_currency` is a
  display setting only — stored facts keep their native currency.
- `kdp_royalty_imports` (migration 0019) holds uploaded KDP Royalties
  Estimator batches: derived suggestions and skipped rows as JSONB, idempotent
  per workspace via `unique (workspace_id, payload_sha256)` — re-uploading the
  same file replays the existing batch (insert `ON CONFLICT DO NOTHING`, then
  re-select). `applied_at` is a one-way stamp set only by
  `markKdpRoyaltyImportApplied`, which returns null on a second attempt so a
  batch can never be applied twice. Only the import flow reads this table;
  applying writes real `book_economics` rows through `upsertBookEconomics`.
  The normalized report rows are stored too (`rows` jsonb, migration 0022) so
  the KDP history can be rebuilt from the database alone —
  `scripts/rebuild-kdp-history.ts` wipes and replays them through
  `listKdpRoyaltyImportPayloads`; batches predating the column carry `[]` and
  become rebuildable only by re-uploading the file.
- `kdp_sale_transactions` (migration 0020, `repositories/kdp-sales.ts`) is the
  phase-2 KDP history feeding `/kdp-history`: verbatim per-transaction rows
  (`royalty_date − order_date` is the fulfillment lag). Imports are
  **additive** (migration 0022): a KDP report is royalty-month scoped and
  every file carries a tail of previous-month orders, so
  `mergeKdpSaleTransactions` deletes only rows identical to the incoming ones
  (every report field — multiplicity survives, since real files contain true
  duplicate one-copy sales) and inserts the incoming set. No import ever
  deletes another file's data — the 2026-08-29 incident was the old
  delete-covered-months model wiping a full month over a one-row tail. The
  monthly aggregates are **derived at read time** by
  `listKdpMonthlyBookSales` (the old `kdp_monthly_book_sales` table was
  dropped), grouped by KDP report month — `date_trunc('month', royalty_date)`,
  matching the KDP dashboard's own display; order-date months are never used
  for display. Unlinked-ASIN transactions keep null `book_id`/`profile_id`
  (shown in the transaction browser, excluded from the monthly derivation).
  The transaction browser's `month` filter is the royalty_date month too.
  Transactions carry `transaction_type` (migration 0021) because the
  fulfillment stats and the monthly derivation exclude Expanded Distribution
  rows on the same royalty-type + transaction-type classification the import
  uses (`STANDARD_ROW_SQL`).
  `listKdpAdUnitsByBookMonth` computes the ad side of the sales mix at query
  time from `advertised_product_metrics_daily` (fact ad_id → `ads.asin` →
  `book_profile_links`, `greatest(units_sold_clicks14d, purchases14d)` copies)
  — it is never snapshotted. `listKdpFulfillmentStats` uses `percentile_cont`
  for the median lag per profile × month of order_date, standard-rate rows
  only. The royalty trend reads `books.listBookEconomicsHistoryByWorkspace`
  (every effective-dated row, `effective_from::text`) — never duplicated
  storage. `listKdpDailyRoyalty` sums real royalty per order date (organic
  included, unlinked-ASIN rows too unless a book filter is given) converted
  per day into one display currency — the organic side of the
  `/kdp-history` daily profit chart; it wraps the transactions in a
  subselect aliasing `order_date as metric_date` so the shared
  `fxRateJoins` applies verbatim.
- The converting dashboard queries (`convertedDailyTotals`,
  `convertedDailySeries`, `convertedRoyaltySeries`, `convertedCountrySpend` in
  `repositories/dashboard.ts`) serve the `country=all` view: each fact is
  cross-rated through the USD pivot at its own metric date via lateral joins
  (`rate_date <= fact_date order by rate_date desc limit 1`, USD = 1), all on
  `numeric`, rounded to 4 decimals. A fact without a covering fixing
  contributes NULL and raises `rates_missing` — never a silent 1:1.
  The joins come from the exported `fxRateJoins(displayParamIndex)` helper,
  which expects the outer query's fact source aliased as `m` with
  `metric_date` and `currency` columns — `kdp-sales.ts` reuses it for the
  KDP daily-royalty conversion via a subselect.
  `fx.getFxSyncStatus` reads coverage plus the last `fx_sync` job state for
  the freshness endpoint; `job_queue.finished_at` (migration 0015) is stamped
  by `complete` and terminal `fail`.
