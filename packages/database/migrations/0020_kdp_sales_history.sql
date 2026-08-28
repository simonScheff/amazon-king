-- Phase-2 KDP sales history (docs/kdp-royalty-import-plan.md section 6).
-- Populated from the same Royalties Estimator upload that creates a
-- kdp_royalty_imports batch: the monthly aggregates feed the /kdp-history
-- sales-mix chart, and the verbatim transaction rows power the per-sale
-- browser and the fulfillment-lag metric (royalty_date - order_date,
-- standard-rate rows only). Nothing here feeds the optimizer; the ad-side
-- half of the sales mix is computed at query time from the fact tables.
--
-- Re-importing a month replaces its data: monthly rows upsert on
-- (book_id, profile_id, month) with the latest import winning, and the
-- repository deletes the covered months' transactions before inserting the
-- new file's rows, so overlapping files do not double-count.
create table kdp_monthly_book_sales (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  import_id bigint not null references kdp_royalty_imports (id),
  book_id bigint not null references books (id),
  profile_id bigint not null references amazon_profiles (id),
  month date not null check (month = date_trunc('month', month)::date),
  standard_units integer not null default 0,
  expanded_units integer not null default 0,
  -- Summed royalty in native currency; refunds can take it negative.
  royalty numeric(19,4) not null default 0,
  currency char(3) not null,
  created_at timestamptz not null default now(),
  -- The unique index doubles as the foreign-key index on book_id.
  unique (book_id, profile_id, month)
);
create index idx_kdp_monthly_book_sales_workspace
  on kdp_monthly_book_sales (workspace_id, month);
create index idx_kdp_monthly_book_sales_import
  on kdp_monthly_book_sales (import_id);
create index idx_kdp_monthly_book_sales_profile
  on kdp_monthly_book_sales (profile_id);

-- book_id/profile_id are nullable: rows whose ASIN is not linked to a catalog
-- book are still stored so the transaction browser shows the full file.
create table kdp_sale_transactions (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  import_id bigint not null references kdp_royalty_imports (id),
  book_id bigint references books (id),
  profile_id bigint references amazon_profiles (id),
  asin text not null,
  marketplace text not null,
  format text not null check (format in ('paperback', 'hardcover', 'ebook')),
  royalty_type text not null,
  order_date date not null,
  royalty_date date not null,
  -- Refund rows carry negative units/royalty; both stay signed.
  net_units integer not null,
  royalty numeric(19,4) not null,
  currency char(3) not null,
  created_at timestamptz not null default now()
);
create index idx_kdp_sale_transactions_workspace
  on kdp_sale_transactions (workspace_id, royalty_date);
create index idx_kdp_sale_transactions_import
  on kdp_sale_transactions (import_id);
create index idx_kdp_sale_transactions_book
  on kdp_sale_transactions (book_id);
create index idx_kdp_sale_transactions_profile
  on kdp_sale_transactions (profile_id);
