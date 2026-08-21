import type { Db } from "../db.js";

/**
 * Daily exchange-rate fixings and FX backfill bookkeeping
 * (docs/fx-rates-all-market-plan.md, decisions 1-3). Stored rows are
 * immutable: upserts use ON CONFLICT DO NOTHING so re-syncs converge and
 * converted numbers stay reproducible. All quotes sit against a single pivot
 * base currency (USD); cross rates are computed in SQL at read time.
 */

export interface FxRateRow {
  rateDate: string; // ISO date
  baseCurrency: string;
  quoteCurrency: string;
  /** Passed as text like metric cost/sales; stored as numeric, never float. */
  rate: string;
  source: string;
  fetchedAt: string; // ISO timestamp
}

/**
 * Batch-insert fixings. ON CONFLICT DO NOTHING keeps stored rates immutable,
 * so repeated syncs of the same window converge instead of overwriting.
 * Returns the number of rows actually inserted.
 */
export async function upsertFxRates(
  db: Db,
  rows: readonly FxRateRow[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const records = rows.map((row) => ({
    rate_date: row.rateDate,
    base_currency: row.baseCurrency,
    quote_currency: row.quoteCurrency,
    rate: row.rate,
    source: row.source,
    fetched_at: row.fetchedAt,
  }));
  const result = await db.query(
    `insert into fx_rates
       (rate_date, base_currency, quote_currency, rate, source, fetched_at)
     select rate_date, base_currency, quote_currency, rate, source, fetched_at
     from jsonb_to_recordset($1::jsonb) as x(
       rate_date date, base_currency char(3), quote_currency char(3),
       rate numeric, source text, fetched_at timestamptz)
     on conflict do nothing`,
    [JSON.stringify(records)],
  );
  return result.rowCount ?? 0;
}

/**
 * Latest stored fixing date (drives the "rates not synced yet" fallback and
 * the sync-health card). Null when no rates have been synced.
 */
export async function getLatestRateDate(db: Db): Promise<string | null> {
  const result = await db.query<{ latest: string | null }>(
    `select max(rate_date)::text as latest from fx_rates`,
  );
  return result.rows[0]?.latest ?? null;
}

/** Raw fx_sync health, straight from fx_rates and the job queue. */
export interface FxSyncStatus {
  /** Newest stored rate_date; null when no rates have ever been synced. */
  latestRateDate: string | null;
  /**
   * Raw job_queue status of the most recent fx_sync run ('running', 'done',
   * 'failed', 'dead', or 'pending' when a failed attempt awaits retry); null
   * when the job has never run. Mapping to the API's status enum is the
   * caller's job.
   */
  lastStatus: string | null;
  /**
   * When that run finished (migration 0015), falling back to its last
   * heartbeat or scheduled time for rows from before the column existed.
   */
  lastRunAt: string | null;
  lastError: string | null;
}

/**
 * FX sync health for the API's data-freshness endpoint (plan §4/decision 7):
 * coverage from fx_rates plus the terminal state of the last fx_sync job.
 * Workspace-global, since rates live against the single USD pivot. A pending
 * row that never ran (freshly scheduled, attempts = 0) does not count as a
 * run; a pending row with attempts has a failed last attempt and counts with
 * its last_error.
 */
export async function getFxSyncStatus(db: Db): Promise<FxSyncStatus> {
  const result = await db.query<{
    latest_rate_date: string | null;
    last_status: string | null;
    last_run_at: string | null;
    last_error: string | null;
  }>(
    `select (select max(f.rate_date)::text from fx_rates f) as latest_rate_date,
            j.last_status, j.last_run_at, j.last_error
     from (select 1) as one
     left join lateral (
       select q.status as last_status,
              coalesce(q.finished_at, q.heartbeat_at, q.run_at) as last_run_at,
              q.last_error as last_error
       from job_queue q
       where q.type = 'fx_sync'
         and (q.status in ('running', 'done', 'failed', 'dead')
              or (q.status = 'pending' and q.attempts > 0))
       order by q.id desc
       limit 1
     ) j on true`,
  );
  const row = result.rows[0];
  return {
    latestRateDate: row?.latest_rate_date ?? null,
    lastStatus: row?.last_status ?? null,
    lastRunAt: row?.last_run_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

/**
 * Oldest metric date across the workspace's daily fact tables, so the fx_sync
 * job knows how far back to backfill rates. Null when the workspace has no
 * facts yet.
 */
export async function getEarliestFactDate(
  db: Db,
  workspaceId: string,
): Promise<string | null> {
  const result = await db.query<{ earliest: string | null }>(
    `select min(metric_date)::text as earliest
     from (
       select min(m.metric_date) as metric_date
       from campaign_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
       union all
       select min(m.metric_date)
       from target_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
       union all
       select min(m.metric_date)
       from search_term_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
       union all
       select min(m.metric_date)
       from advertised_product_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
       union all
       select min(m.metric_date)
       from placement_metrics_daily m
       join amazon_profiles p on p.id = m.profile_id
       join amazon_connections c on c.id = p.connection_id
       where c.workspace_id = $1
     ) facts`,
    [workspaceId],
  );
  return result.rows[0]?.earliest ?? null;
}
