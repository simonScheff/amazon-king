# apps/worker — `@amazon-king/worker`

The background job worker: imports, reports, analysis, and scheduled jobs.
Read-only against Amazon in the MVP. Read the root `AGENTS.md` first for the
**idempotent pipeline** rule.

## Commands

`dev` (`tsx watch src/index.ts`), `start`, `typecheck`, `test` (vitest — no
network, no real database).

## Dependency discipline

Handlers depend on the `WorkerStore` interface in `src/store.ts` (production:
repositories plus worker-specific SQL; tests: an in-memory fake), an injected
gateway, storage, and clock. **Never read the wall clock directly in a handler**
— injected time is what makes these tests deterministic.

## The loop

`src/loop.ts` polls, claims, and executes one job at a time with a 120 s lease
heartbeated every 30 s and graceful SIGTERM/SIGINT shutdown.

Lease reaping runs on its own `setInterval`, plus once at startup, rather than
inside the loop body. This is deliberate: a single `metrics_sync` can occupy the
loop for hours, and a crashed worker's claimed jobs must not sit `running` and
invisible for that long. Do not fold reaping back into the loop.

## Handlers

`src/jobs/` behind a type → handler map.

- `profile_discovery`, `structure_sync`, `connection_health`,
  `recent_window_resync`
  - `structure_sync` adopts the payload's optional `syncRunId` (set by
    `POST /api/profiles/:profileId/syncs`) and finishes that row; only
    scheduled syncs create their own `sync_runs` row.
- `schedule_tick` — self-rescheduling every 15 minutes, cadence per plan §8,
  deduped via `enqueueIfNotQueued`
- `metrics_sync` and `recommendation_run` — see below

## metrics_sync

Reporting v3 orchestration: fingerprint-deduped specs requesting
`purchases7d` / `sales7d` / `unitsSoldClicks7d` and the matching 14d columns,
poll resume via a persisted `amazon_report_id` plus the gateway `reportOwner`
callback, streaming download to `REPORT_STORAGE_DIR` with a sha256, then
reconciliation and transactional fact upserts. Success chains a
`recommendation_run`.

Concurrency and retry shape, all load-bearing:

- A range longer than Amazon's 31-day limit is split into chunks. The four
  report families of a chunk run **concurrently** (`Promise.allSettled`) because
  each spends nearly all its wall time asleep in the poll loop. Chunks stay
  sequential, which caps in-flight reports per profile at four.
- A failing family does not cancel its siblings; each records its own
  `report_jobs` state so the retry resumes. A `TerminalJobError` from any family
  outranks transient sibling errors.
- Amazon needs roughly 19–21 minutes per daily report, so
  `REPORT_POLL_TIMEOUT_MS` defaults to 45 minutes. A poll timeout leaves the
  report `polling` with its `amazon_report_id` so the retry resumes the same
  Amazon report instead of throwing away the wait. Only an Amazon `FAILURE`
  marks it `retryable` and re-requests.
- A report already downloaded (`validating` or `importing` with a `storage_key`)
  is re-imported from disk, never re-fetched.

## recommendation_run

Loads structure — including the synced `negative_keywords` and
`negative_targets` — plus metrics, economics, and cooldowns, then runs
`@amazon-king/optimizer` over 7/14/30/60-day windows.

Suppression rules that must hold:

- Skip entirely when there is no fresh complete metrics sync.
- Suppress profit rules when KDP economics are missing. Never guess economics.
- Skip any identity with an active row in `recommendation_dismissals`, so a
  rejected finding is not raised again.
- Expire pending or approved `cannibalization_conflict` findings whose term a
  negative keyword or negative ASIN target now blocks.
- Expire pending or approved `wasteful_search_term` findings whose campaign a
  synced negative already blocks for that term.
- Expire pending or approved `high_ctr_poor_conversion` findings when the
  campaign's remaining unblocked search-term traffic would no longer trigger
  the rule.

## Tokens

`src/tokens.ts` wires refresh: decrypt → `TokenManager` → re-encrypt. A dead
grant marks the connection `reconnect_required` and dead-letters its pending
jobs.
