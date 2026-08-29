-- KDP history turns additive (docs/kdp-royalty-import-plan.md, 2026-08-29
-- incident): a KDP "monthly" report is royalty-month scoped, so every file
-- carries a tail of previous-month orders (order→royalty lag of 0–10 days).
-- The old model treated every order-date month present in a file as fully
-- covered and replaced it wholesale — a newer file's one-row tail deleted the
-- prior month's transactions and overwrote its monthly aggregates. Imports now
-- only merge transaction rows (identical rows are replaced, everything else is
-- left alone), and the monthly aggregates feeding /kdp-history are derived at
-- read time from kdp_sale_transactions instead of stored.
--
-- kdp_royalty_imports.rows keeps the normalized report rows (already bounded
-- at 20k by the contracts schema) so the history tables can be rebuilt from
-- the database alone via scripts/rebuild-kdp-history.ts. Batches imported
-- before this column have '[]' and need a re-upload to become rebuildable.
alter table kdp_royalty_imports
  add column rows jsonb not null default '[]'::jsonb;

-- Derived at read time now; the stored copy was both redundant and the
-- corruption vector above, so it goes away entirely.
drop table kdp_monthly_book_sales;
