-- Daily exchange-rate fixings for the all-market dashboard view
-- (docs/fx-rates-all-market-plan.md, decisions 1-3). All quotes are stored
-- against a single USD pivot so one row set per day covers every marketplace
-- and display currency; cross rates are computed in SQL on numeric. Rows are
-- append-only (the repository inserts with ON CONFLICT DO NOTHING) so
-- converted numbers stay reproducible. Weekends and holidays simply have no
-- row; lookups fall back to the most recent earlier fixing.
create table fx_rates (
  rate_date date not null,
  base_currency char(3) not null,
  quote_currency char(3) not null,
  rate numeric not null check (rate > 0),
  source text not null,
  fetched_at timestamptz not null,
  primary key (rate_date, base_currency, quote_currency)
);
-- Point-in-time conversion resolves the latest fixing at or before a fact
-- date for a currency pair; the primary key leads with rate_date, so index
-- the pair-first ordering those lookups use.
create index idx_fx_rates_pair_date
  on fx_rates (base_currency, quote_currency, rate_date desc);

-- Currency of the all-market dashboard view (decision 5). A display setting
-- only; stored facts keep their native currency and are never rewritten.
alter table workspaces
  add column display_currency char(3) not null default 'USD';
