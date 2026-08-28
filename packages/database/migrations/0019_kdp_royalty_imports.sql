-- KDP "Royalties Estimator" workbook imports (docs/kdp-royalty-import-plan.md).
-- The browser parses the xlsx and posts normalized rows; the server derives
-- per-book/per-market royalty-per-copy suggestions and stores them here until
-- the owner applies or discards them. Nothing in this table feeds the
-- optimizer directly — applying writes effective-dated book_economics rows
-- through the usual save path.
--
-- payload_sha256 hashes the canonical row set, so re-uploading the same file
-- is an idempotent replay that returns the existing batch instead of
-- duplicating it. suggestions/skipped are stored as JSONB (single-owner
-- scale, one batch is ~50 rows); per-transaction analytics land with the
-- phase-2 history tables.
create table kdp_royalty_imports (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  file_name text not null,
  payload_sha256 char(64) not null,
  period_start date not null,
  period_end date not null,
  row_count integer not null check (row_count >= 0),
  suggestions jsonb not null default '[]'::jsonb,
  skipped jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  -- The unique index doubles as the foreign-key index on workspace_id.
  unique (workspace_id, payload_sha256)
);
create index idx_kdp_royalty_imports_workspace
  on kdp_royalty_imports (workspace_id, created_at desc);
