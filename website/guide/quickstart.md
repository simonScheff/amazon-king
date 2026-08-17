---
title: "Quickstart: First Session"
description: A guided first session with Amazon King — sign in, tour the dashboard, connect Amazon Ads, trigger a sync, enter book economics, and approve your first recommendation.
---

# Quickstart: first session

This walkthrough takes you from a fresh `make run` to reviewing your first
recommendation. It assumes the [installation](/guide/installation) is done and
all three processes are running.

::: info No Amazon credentials yet?
Everything up to [Connect your Amazon account](#connect-your-amazon-account)
works offline. Without LWA credentials the pipeline can't import real data —
follow [Connecting Amazon Ads](/guide/connecting-amazon) when you're ready,
and come back here for the sync walkthrough.
:::

## 1. Sign in

Open `http://localhost:5173`. Enter any email address on `/login` and submit.
In development there is no mail server, so the API returns the magic link in
its response and the page shows a **"Continue sign-in"** link — click it. (The
same link is printed in the API logs if you miss it.)

You're now on the overview page. Login links are single-use and expire in 15
minutes; the session itself lasts 7 days, rolling.

## 2. Tour the dashboard

The overview (`/`) is the control room. Before any data exists it will be
mostly empty — here's what each part is for.

![Dashboard overview with KPI cards, daily performance charts, and top problems](/screenshots/overview.png)

- **Product filter** — the checkbox dropdown at the bottom of the left sidebar
  scopes the whole app to one or more of your books ("All products" by
  default). The overview, campaigns, search terms, and recommendations screens
  all respect it, and the selection persists as you navigate.
- **Country and date-range selectors** — every number on the page respects
  these. Currency is never mixed across marketplaces; pick one country at a
  time.
- **Six KPI cards** — Spend, Sales, Orders, ACoS, Est. royalty, and Est. ad
  profit. Clicking a card toggles its series on the trend charts.
- **Daily performance chart** — spend, sales, and orders over the selected
  range. A **daily profitability** chart appears once book economics exist.
- **Amber banner** — shown when advertised products have no economics yet.
  Profit-based numbers are withheld, not guessed, until you fill them in.
- **Top problems & opportunities** — the five highest-priority pending
  recommendations, one click away from the full list.
- **Sync & connection health** — whether the Amazon connection is live and
  when each profile last synced.

The left navigation covers the rest: `/recommendations` (filterable table of
every finding), `/campaigns`, `/search-terms` (cross-campaign search-term
analysis), `/changes` (the change center: every change set and its status),
`/connect`, and `/settings`.

## 3. Connect your Amazon account

Go to `/connect`. Starting the connection sends you through Login With Amazon
(scope `advertising::campaign_management`) — this is Login B, entirely
separate from your app session. After you approve, the API exchanges the code
server-side, envelope-encrypts the refresh token, and discovers your profiles.

Back on `/connect` you'll see the connection status and the discovered
profiles (one per marketplace), each with a checkbox to enable it for syncing.
Enable the profile(s) you care about — nothing syncs for disabled profiles.

## 4. Trigger the first sync

The scheduler will pick up newly enabled profiles on its own, but you don't
have to wait: press **Sync now** in Settings (or call
`POST /api/profiles/:id/syncs` directly).

From here, the worker takes over automatically:

1. **Structure sync** imports campaigns, ad groups, targets, and ads for the
   enabled profile. The scheduler repeats it every 45 minutes.
2. **Metrics sync** runs once daily after 05:00 UTC, importing yesterday's
   Sponsored Products reports (campaigns, targeting, search terms, advertised
   products), followed by a trailing 14-day re-sync to absorb Amazon's
   attribution lag. Each import is requested, polled, downloaded, validated,
   and reconciled before it's marked complete.
3. **Recommendation run** is chained automatically after a successful metrics
   sync (and skipped if the last complete metrics sync is older than 48
   hours). The optimizer evaluates all nine rules over 7/14/30/60-day windows.

A `schedule_tick` job fires every 15 minutes to enqueue whatever is due —
structure syncs, the daily metrics jobs, hourly-adjacent health checks — so a
fresh profile gets its first structure sync within minutes even if you never
press anything.

::: tip
The first metrics sync only imports yesterday. Give the daily cycle a few days
to build history before judging recommendations — rules require minimum
evidence and will stay quiet until the data supports them.
:::

## 5. Enter book economics

Go to `/settings`. The book economics section lists advertised ASINs the sync
discovered; identify each one (title, format) and enter, per marketplace:

- **List price** and **estimated royalty per sale** — what you actually earn
  per order (check your KDP royalty reports),
- **target ACoS** as a 0–1 fraction (e.g. `0.30`, not `30`),
- **goal mode** — `profit`, `balanced`, `launch`, or `visibility`,
- optional ceilings: max spend without a sale, max bid, max daily budget.

![Settings page with book economics forms for entering royalty per sale and target ACoS](/screenshots/settings.png)

The moment economics exist, the dashboard's estimated royalty and estimated ad
profit KPIs become real, and the profit-based rules start participating in
recommendation runs. See the [book economics guide](/guide/book-economics) for
how to compute royalty per sale for each format.

## 6. Review your first recommendation

Open `/recommendations`. Filter by profile, priority (P1–P5), or rule type.
Each row shows the finding, its evidence window, and its confidence; expanding
it shows the exact inputs the rule stored — spend, orders, clicks, smoothed
conversion rate, and the rule version that produced it.

Recommendations expire: if the underlying data goes stale, the finding moves
to `expired` instead of silently applying to old numbers. Advisory-only types
(harvesting, budget, placement, cannibalization) can't be applied directly —
they point you at manual actions or the
[campaign tools](/guide/campaign-tools).

## 7. Approve it into a draft change set

For an applicable recommendation (a bid change or a negative exact keyword),
approving it creates a **draft change set** in `/changes`. Nothing has touched
Amazon at this point — the draft is an immutable, inspectable bundle of
proposed writes.

Applying is a deliberate, gated step covered in
[applying & rolling back changes](/guide/applying-changes): preview against a
fresh Amazon re-read, recent re-authentication, guardrail re-checks, per-item
apply, and post-write verification. Note that with `KILL_SWITCH=true` (the
default) and a profile that isn't `writeEnabled`, applies are blocked — that
is the intended alpha posture until you've validated the pipeline on a
low-risk campaign.

## Where to go next

- [Reviewing recommendations](/guide/recommendations) — filters, evidence, and expiry in depth
- [Applying & rolling back changes](/guide/applying-changes) — the guarded write lifecycle
- [Operations runbook](/guide/operations) — sync health, logs, and the kill switch
