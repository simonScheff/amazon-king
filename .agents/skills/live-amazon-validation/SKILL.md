---
name: live-amazon-validation
description: Procedure and safety gates for exercising amazon-king against a real Amazon Ads account, including the first live write. Use when enabling writes, testing with real credentials, or judging whether the project is ready for the next implementation phase.
whenToUse: When about to run against real Amazon credentials, enable writes on a profile, apply a change set for real, or start automation work
---

**Stop and confirm with the user before anything in this skill touches a real
Amazon account.** The project is alpha: no end-to-end run against real Amazon
credentials has happened yet, and this repository can spend real money.

## Phase gates

`docs/plan.md` §16 defines Phases 0–9 with explicit "done when" acceptance
criteria:

| Phase | Scope                                  |
| ----- | -------------------------------------- |
| 0     | API approval and product specification |
| 1     | Technical spike                        |
| 2     | Foundation and application login       |
| 3     | Amazon connection                      |
| 4     | Data ingestion                         |
| 5     | KDP economics and read-only dashboard  |
| 6     | Recommendation engine                  |
| 7     | Human-approved writes                  |
| 8     | Production hardening                   |
| 9     | Carefully scoped automation            |

Code exists for Phases 2–7 and open-source/CI work has started Phase 8, but
Phase 0 and 1 live acceptance is incomplete. Do not skip ahead. In particular,
**Phase 9 automation stays closed** until weeks of observed results from
human-approved writes justify it — the product is an advisory system with human
approval, not an autonomous ad bot.

## Before the first live write

- Confirm the Amazon Ads API application is approved and the LWA credentials
  belong to the intended account.
- Confirm the client secret comes from the deployment secret manager, never from
  a per-user value or anything committed.
- Verify read-only mode is the default per profile and that the global kill
  switch disables writes immediately. Know how to trigger it before you need it.
- Confirm the guarded write path is intact: immutable change set, fresh re-read
  of Amazon state matching the `before` snapshot, guardrail re-checks,
  idempotency fingerprint, per-item result handling, post-write re-read
  verification, and audit logging.
- Confirm rollback works as a compensating API action for the action type you
  are about to apply. Campaign creation and negative ASIN targets are **not**
  rollbackable.

## The first live write

Never test writes against important live campaigns. Use an Amazon test account
or a dedicated low-risk campaign, then expand only after each step is verified:

1. One profile.
2. One manually approved action.
3. A small bid change.
4. Verify the post-write re-read shows the expected state and the audit log
   recorded it.
5. Verify rollback restores the previous state.
6. Only then widen to more actions, then more profiles.

## While validating ingestion

Reports are asynchronous and slow: Amazon needs roughly 19–21 minutes per daily
report, so a sync that looks hung usually is not. Check `report_jobs` state
before intervening — a poll timeout deliberately leaves the report `polling`
with its `amazon_report_id` so a retry resumes the same report rather than
discarding the wait.

Before marking a sync complete, reconciliation must pass: row counts, grain,
non-negative counts, and currency.

## If something goes wrong

Follow the incident procedure: disable writes with the kill switch, rotate
secrets if exposure is suspected, invalidate sessions, and disconnect Amazon.
Record what happened — a live incident is the most valuable input the plan can
get.
