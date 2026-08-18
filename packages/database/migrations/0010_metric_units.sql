-- Click-attributed unit counts from Reporting v3 (unitsSoldClicks7d/14d).
-- `units` is the 7-day convenience column, matching how `orders` mirrors
-- purchases7d. Historical rows stay 0 until the next metrics sync backfills.
alter table campaign_metrics_daily
  add column units integer not null default 0 check (units >= 0),
  add column units_sold_clicks7d integer not null default 0
    check (units_sold_clicks7d >= 0),
  add column units_sold_clicks14d integer not null default 0
    check (units_sold_clicks14d >= 0);

alter table target_metrics_daily
  add column units integer not null default 0 check (units >= 0),
  add column units_sold_clicks7d integer not null default 0
    check (units_sold_clicks7d >= 0),
  add column units_sold_clicks14d integer not null default 0
    check (units_sold_clicks14d >= 0);

alter table search_term_metrics_daily
  add column units integer not null default 0 check (units >= 0),
  add column units_sold_clicks7d integer not null default 0
    check (units_sold_clicks7d >= 0),
  add column units_sold_clicks14d integer not null default 0
    check (units_sold_clicks14d >= 0);

alter table advertised_product_metrics_daily
  add column units integer not null default 0 check (units >= 0),
  add column units_sold_clicks7d integer not null default 0
    check (units_sold_clicks7d >= 0),
  add column units_sold_clicks14d integer not null default 0
    check (units_sold_clicks14d >= 0);

alter table placement_metrics_daily
  add column units integer not null default 0 check (units >= 0),
  add column units_sold_clicks7d integer not null default 0
    check (units_sold_clicks7d >= 0),
  add column units_sold_clicks14d integer not null default 0
    check (units_sold_clicks14d >= 0);
