---
title: Key Concepts
description: The core vocabulary of Amazon King — logins, profiles, syncs, recommendations, change sets, guardrails, and book economics — and why each one exists.
---

# Key concepts

These are the terms you will see across the dashboard, the API, and these
docs. Each is a deliberate design decision; understanding them makes the rest
of the system predictable.

## Login A vs Login B

Amazon King has two completely separate logins. **Login A** is how you sign in
to the app: passwordless email (a magic link), an `HttpOnly`,
`SameSite=Lax` session cookie (`ak_session`) with a rolling 7-day lifetime,
CSRF protection, and rate limiting. **Login B** is the OAuth connection from
the server to your Amazon Ads account (Login With Amazon, scope
`advertising::campaign_management`). The app session never contains an Amazon
token, and Amazon credentials are never sent to the browser.

*Why it matters:* compromising your dashboard session does not leak Amazon
credentials, and disconnecting Amazon does not lock you out of the app. See
[Connecting Amazon Ads](/guide/connecting-amazon) and the
[security model](/architecture/security).

## Profiles and marketplaces

An Amazon Ads **profile** maps to one marketplace (country) of your ad
account — Amazon.com (US), Amazon.co.uk (UK), and so on. Profiles are
discovered automatically after you connect. Each profile has two
owner-controlled switches: `enabled` (include it in syncs and analysis) and
`writeEnabled` (allow guarded writes against it). Both are opt-in.

*Why it matters:* you can import and analyze a marketplace for weeks before
trusting the system to write to it, and every monetary figure stays in the
profile's own currency — Amazon King never aggregates across currencies,
except in the explicit **All markets** overview, which converts each day's
figures through stored daily FX rates into one display currency (see
[Configuration](/guide/configuration#exchange-rates-and-the-all-market-view)).

## Syncs

The worker keeps a local mirror of your Amazon account in PostgreSQL.
**Structure syncs** import campaigns, ad groups, targets, and ads every
45 minutes per enabled profile. **Metrics syncs** import performance reports
once daily after 05:00 UTC (when Amazon's data for yesterday has settled),
followed by a trailing 14-day **recent-window re-sync** to absorb attribution
lag. Metrics cover four report families: campaigns, targeting, search terms,
and advertised products. A self-rescheduling `schedule_tick` job (every
15 minutes) enqueues whatever is due; a successful metrics sync chains a
recommendation run.

*Why it matters:* the dashboard and the optimizer always read local, validated
data — no waiting on Amazon's API, and every import is idempotent and
reconciled before it is marked complete. See the
[data pipeline](/architecture/data-pipeline).

## The gateway boundary

Every call to the Amazon Ads API goes through a single internal
`AmazonAdsGateway` interface. Amazon payloads are strictly validated (zod
schemas) and translated into internal domain models at the boundary; the
optimizer never sees raw Amazon field names. The gateway also owns token
refresh, regional routing, `Retry-After` handling, and backoff.

*Why it matters:* when Amazon changes an API response, exactly one layer
breaks — with a clear error — instead of corrupting facts downstream. See
[system overview](/architecture/overview).

## Recommendations

A **recommendation** is one deterministic finding from one of the nine
optimization rules: a wasteful search term to negate, an expensive target to
bid down, a profitable target to bid up, a search term worth harvesting, and
so on. Each carries a **priority** (P1–P5, where P1 is most urgent), a
**confidence** score (0–1, derived from evidence volume and smoothed
conversion rates), the **evidence window** (the exact 7/14/30/60-day date
range the rule ran over), and an **expiry** — when the underlying data goes
stale, the recommendation expires rather than acting on old numbers.

*Why it matters:* you can audit exactly why anything was suggested, rules
can't fire on thin data, and nothing lingers past its shelf life. See
[reviewing recommendations](/guide/recommendations) and the
[optimization rules reference](/reference/optimization-rules).

## Change sets

A **change set** is an immutable, human-approved bundle of writes to Amazon.
Kinds: `recommendation` (created by approving recommendations), `max_cpc`
(bulk bid ceilings), `rollback` (a compensating action for a previous set),
`campaign_creation` (creating a new campaign and its contents), and
`campaign_update` (one-click pause/enable or rename from the campaign page).
A change
set moves through statuses: `draft` → `previewed` → `applying` →
`applied`, `partially_applied`, `failed`, or `blocked`. Applying re-reads
Amazon state, compares it against the stored before-snapshot, re-checks
guardrails, applies item by item (handling Amazon's per-item 207 results),
and verifies with a post-write re-read.

*Why it matters:* there is no "edit Amazon" button anywhere — every write is
an inspectable, auditable object with a lifecycle, and a stale before-state
blocks the apply instead of blindly overwriting. See
[applying & rolling back changes](/guide/applying-changes).

## Guardrails

**Guardrails** are hard limits re-checked at apply time, independent of the
rules: bid changes are clamped to ±15% per cooldown period, per-book ceilings
you set (max bid, max daily budget, max spend without a sale) are enforced,
and entities on your protected lists (`protectedCampaignIds`,
`protectedSearchTerms` — empty by default) are left alone. Recently changed
targets are also skipped while their bid cooldown runs. Violations block the affected items, not silently adjust them.

*Why it matters:* even if a rule misfires or your data is misleading, the
guardrails bound how much damage one approved change set can do. See the
[optimization rules reference](/reference/optimization-rules) for the exact
thresholds.

## The kill switch

`KILL_SWITCH` is a global, environment-level flag that disables every Amazon
write immediately. It defaults to `true` — writes fail closed until you
explicitly set it to `false`, and per-profile `writeEnabled` is a second,
independent gate on top of it.

*Why it matters:* it is the incident-response lever. If anything looks wrong,
one environment change stops all writes without touching the database or the
Amazon connection. See the [operations runbook](/guide/operations).

## Book economics

**Book economics** are the KDP numbers Amazon never sees, entered per book and
marketplace, effective-dated: list price, **estimated royalty per sale**,
**target ACoS** (a 0–1 fraction of revenue, not author profit), optional
spend/bid/budget ceilings, and a **goal mode**:

- `profit` — optimize for estimated ad profit within target ACoS.
- `balanced` — weigh profit against volume.
- `launch` — tolerate higher spend to gather data and velocity on a new title.
- `visibility` — maximize impressions.

Currently only `launch` changes optimizer behavior — it suppresses the
spend-cutting rules while the title gathers data. `profit`, `balanced`, and
`visibility` are recorded but treated identically by the rules for now.

*Why it matters:* profit recommendations are *disabled, not guessed*, when
economics are missing — the dashboard shows an amber banner instead of
inventing a royalty. See the [book economics guide](/guide/book-economics).

## ACoS vs estimated ad profit

**ACoS** is ad spend divided by attributed retail revenue — Amazon's metric,
computed over what shoppers paid. **Estimated ad profit** is what you actually
care about: `max(orders, units) × royalty per sale − ad cost` — royalty is
earned per copy sold, so a three-copy order earns three royalties. Because KDP royalty rates
(35%/70% ebook, fixed minus printing cost for print) mean you keep only part
of each retail dollar, a "good" ACoS can still be unprofitable and a "high"
ACoS can be fine.

*Why it matters:* it is the core reason Amazon King exists. Every KPI, chart,
and profit-based rule works in estimated ad profit once you've entered book
economics — and refuses to guess when you haven't.

## Where to go next

- [Quickstart](/guide/quickstart) — see these concepts in a working session
- [Architecture overview](/architecture/overview) — how the pieces are deployed
- [HTTP API reference](/reference/api) — the exact endpoints and payloads
