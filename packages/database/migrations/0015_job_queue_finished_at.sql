-- Completion timestamp for queue jobs, so the FX sync health surfaced by the
-- API's data-freshness endpoint (docs/fx-rates-all-market-plan.md §4) can
-- report when the last fx_sync run finished. Jobs that finished before this
-- column existed read as null; readers fall back to heartbeat_at / run_at.
alter table job_queue
  add column finished_at timestamptz;
