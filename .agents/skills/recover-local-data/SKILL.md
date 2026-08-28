---
name: recover-local-data
description: Recover the local amazon-king database after a wipe, corruption, or accidental data loss. Use when the local database was destroyed or emptied, the dashboard is suddenly empty, or a backup must be restored.
whenToUse: When local data is lost or suspected lost — an emptied database, a destroyed Docker volume, a bad restore, or any "where is all my data" moment on localhost
---

# Recover the local database

The local database is backed up continuously: `make run` snapshots it on every
start, and the owner's crontab runs `make backup` daily at 03:17 (a sleeping
laptop skips the cron; the `make run` snapshot is the reliable one). Dumps
live in `backups/amazon_king-YYYYMMDD-HHMMSS.dump` (custom-format `pg_dump`,
gitignored, last 14 kept).

## Step 1: assess before touching anything

1. `docker compose ps` — is the `amazon-king-db` container up?
2. Look before assuming loss: `docker exec amazon-king-db psql -U postgres amazon_king -c "select count(*) from workspaces"` — an empty-looking
   dashboard can also be a signed-out session or a missing migration
   (generic 500s), not lost data.
3. Check what is actually missing. Data from an external source (Amazon
   campaigns/metrics, FX rates, KDP imports from workbooks in `docs/`) is
   always re-creatable. Hand-entered data (Max CPC policies, search-term
   exclusions, dismissals, book notes, tuned ACoS) exists only in the
   database — its loss is what a restore really fixes.

## Step 2: restore the newest dump that PREDATES the incident

```bash
ls -t backups/amazon_king-*.dump | head   # newest first
make restore DUMP=backups/amazon_king-YYYYMMDD-HHMMSS.dump
```

- Pick the newest dump from **before** the data was lost. A dump taken after
  the wipe faithfully preserves the wipe.
- `make restore` overwrites the local database and asks for a typed `yes`.
- Afterwards run `make migrate` (the dump may predate newer migrations), then
  `make run` and verify sign-in plus the dashboard.
- Sessions do not survive: the owner signs in again (dev magic link, see the
  `local-stack` skill).

## Step 3: when no usable dump exists

Rebuild from sources, in this order:

1. **Amazon connection (owner's browser required).** The OAuth refresh token
   dies with the database, and re-authorization is Login B — the owner must
   complete it. Generate the flow with a session
   (`POST /api/session/login` → open `devLoginUrl` in the owner's browser,
   then `POST /api/integrations/amazon/start` with the session cookie +
   `x-csrf-token` from `GET /api/session` → open the returned `url`).
2. **Profiles:** discovery inserts real Amazon profiles. If placeholder or
   re-created profiles exist, re-point `book_profile_links`, `book_economics`,
   and the KDP history tables to the real profile ids and delete the stale
   ones (country match; note Amazon reports the UK as `UK`, KDP as `GB`).
3. **Sync:** `POST /api/profiles/:profileId/syncs` per enabled profile, then
   wait for structure + metrics. Re-run FX backfill if facts predate the
   earliest stored rate (the incremental `fx_sync` job only fetches
   `latest+1`; see `tmp/backfill-fx.ts` for the one-off pattern).
4. **KDP economics:** re-upload the workbooks from `docs/` via Settings →
   Books & economics, or rebuild programmatically — `tmp/restore-local-data.ts`
   is a worked example that parses a workbook, seeds books/economics, and
   replays the import through the real read-service path.
5. **Accept the hand-entered loss.** Max CPC, exclusions, dismissals, and
   custom guardrails are not recoverable without a dump. Ask the owner for
   the values and bulk-insert them rather than clicking through the UI.

## Step 4: close the gap

After any recovery, take a fresh `make backup` immediately, and tell the
owner plainly what was restored, what was rebuilt, and what was lost.
