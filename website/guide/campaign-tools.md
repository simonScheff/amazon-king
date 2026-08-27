---
title: Campaign Tools
description: The new-campaign wizard, cannibalization resolution, persistent search-term exclusion, and Max CPC enforcement — campaign-level tools built on the guarded write pipeline.
---

# Campaign Tools

Beyond per-recommendation approvals, amazon-king has several campaign-level
tools. All of them produce ordinary change sets that go through the same
[guarded apply pipeline](/guide/applying-changes) — preview, fresh re-read,
guardrails, verification.

![Campaign detail page with KPI cards, profit chart, and the ad groups tab](/screenshots/campaign-detail.png)

The same page lists ad groups, targets, search terms, **negative keywords**,
and **negative products** (ASIN exclusions) from the last structure sync.
Each negative row has a **Re-include** button: it drafts a change set that
removes the negative, so the term or product can serve again once the draft is
applied in Change center. Adding a negative still goes through a
recommendation or Change center draft.

## Negatives inventory

`/negatives` lists every synced negative keyword and product ASIN across the
workspace: how many enabled campaigns currently block it, whether enabled
campaigns still serve it (a coverage gap), and whether it sold before we first
saw the negative. Amazon does not expose when a negative was created, so
**first seen** is the date this app first synced it.

Click a term or ASIN for the inner page (`/negatives/keyword/…` or
`/negatives/product/…`): search-term KPIs, funnel, and a daily chart with a
first-seen marker, then two campaign tables — **Running on** (Re-include) and
**Not running on** (Exclude). Exclude everywhere on keywords reuses the
persistent exclusion list; nothing reaches Amazon until you apply the draft in
Change center.

## Pause / enable / rename

The campaign detail page header has one-click controls to **pause** (or
re-enable) and **rename** a campaign. Each click drafts a single-action
`campaign_update` change set and applies it immediately through the guarded
pipeline (recent sign-in required — if your session is too old, the re-auth
dialog emails you a magic link and returns you to the page). The verified
change is reflected in the dashboard right away, and both actions are
rollbackable from the Change center (the previous state or name is restored).

Use rename to annotate *why* you paused something — e.g. "… — paused,
accidental auto campaign". There is deliberately no delete: Amazon only
offers a terminal `ARCHIVED` state that can never be undone, so the app does
not expose it.

## New campaign wizard

Entry points: **+ New campaign** on `/campaigns`, or **Create a new
campaign** from a cannibalization resolution (which prefills market, campaign
name, MANUAL targeting, and the conflicted term as an EXACT keyword).

The wizard at `/campaigns/new` has six steps:

1. **Markets** — pick one or more enabled profiles.
2. **Campaign** — name, daily budget, targeting type (AUTO or MANUAL),
   start date, state. New campaigns default to **paused** so nothing spends
   before you deliberately enable it.
3. **Ad group** — name and default bid.
4. **Book** — pick a book from your catalog; the wizard uses its per-market
   ASINs for the product ads. Only books already linked to every selected
   market appear in the dropdown. Books that are missing a selected market
   are listed below it so you can confirm the marketplace ASIN and link them
   in place (the listing must already exist on that Amazon store). You can
   also add a market from [Settings](/guide/book-economics#expanding-to-another-marketplace).
5. **Keywords & targets** — keywords (EXACT, PHRASE, or BROAD, each with a
   bid) and/or ASIN product targets (optional bid). Entering a keyword or
   ASIN switches the campaign to **MANUAL** targeting automatically: Amazon
   rejects manual targeting clauses in AUTO campaigns (it creates the close
   match, loose match, substitutes, and complements targets itself), so an
   AUTO campaign is only valid with no keywords or targets entered, and a
   MANUAL campaign requires at least one.
6. **Review** — the payload is validated against the shared contract schema
   before submission.

Submitting posts to `POST /api/campaign-creation-change-sets` and creates **one
draft `campaign_creation` change set per market**. The wizard never interrupts
you for a sign-in, however long you spend in it: drafting touches only the
app's own database, and the recent-sign-in requirement lands on the apply in
the Change center, where the campaign actually reaches Amazon.

### How creation applies

Each creation set is an ordered chain of actions:
`create_campaign → create_ad_group → create_product_ad`, plus one
`create_keyword` / `create_target` per keyword or ASIN target (MANUAL
campaigns only — an AUTO campaign's set is just the three entity creates).
Product targets are expressed as `ASIN_SAME_AS` expressions.

- Created Amazon ids from each phase are substituted into dependent actions;
  a child whose parent failed is not attempted and fails with
  `PARENT_FAILED`, so you never get orphaned ad groups or keywords.
- There is no before-state to compare (nothing exists yet). Instead, apply
  treats a **same-name campaign already present on Amazon** as satisfied and
  resends nothing — retrying a partially applied creation is idempotent.
- Created ids are verified against a fresh structure read, and a
  `structure_sync` job is enqueued after a successful apply so the dashboard
  mirrors the new entities immediately.

::: warning
Campaign creation change sets are **not rollbackable** — there is no
compensating "delete campaign" operation. Review the draft carefully in the
change center before applying.
:::

## Resolving cannibalization

A `cannibalization_conflict` [recommendation](/guide/recommendations) means
one search term is accruing spend in two or more campaigns — you are bidding
against yourself. The recommendation detail page embeds a resolution flow:

1. Review the evidence: every conflicting campaign with its spend and orders
   for the term.
2. Choose a **destination**: one existing campaign that should keep serving
   the term, or **Create a new campaign** (which routes into the wizard with
   the term prefilled, and submits the finding's id with the payload).
3. Confirm. The API drafts a change set adding the term as a campaign-level
   **negative exact keyword** — or a **negative ASIN target** when the
   "term" is an ASIN — in every conflicting campaign except the destination
   (in *all* of them when the destination is a new campaign).

### The dependency lock

When the destination is a new campaign, the negatives set carries
`metadata.dependsOnChangeSetId` pointing at the creation set. Apply rejects
it with `409 DEPENDENCY_NOT_APPLIED` until the creation set is `applied`, and
the change center shows a lock notice instead of the apply button. This
guarantees the term is never blocked in all campaigns at once — the new
destination must exist on Amazon first.

::: info
Both negative exact keywords and negative ASIN targets created this way are
rollbackable from the Change center (they are verified app-created negatives);
a rollback removes the negative again. The **Re-include** button on the
campaign's negatives tabs does the same for any synced negative, however it
was created.
:::

## Excluding a search term everywhere

When a shopper term should simply never serve — an irrelevant query that
keeps spending, a competing ASIN you cannot win — **Exclude everywhere**
handles it once, permanently, across every market. It is a row action on the
`/search-terms` and `/negatives` lists and a header action on those detail
pages (keywords only on Negatives).

One confirmed click does two things:

1. Records the term (trimmed and lower-cased) in the workspace's persistent
   **exclusion list**.
2. Drafts one change set per enabled market blocking the term in every
   enabled campaign that **actually served it** (the term appears in the
   campaign's search-term facts over the trailing 30 days) and does not
   already block it — a campaign-level **negative exact keyword**, or a
   **negative ASIN target** when the "term" is an ASIN. Campaigns that never
   served the term get no action.

The drafts wait in the [Change center](/guide/applying-changes) like any
other set: nothing reaches Amazon until you review and apply them there.
Terms already on the list show an **Excluded everywhere** badge instead of
the action, and re-excluding a term is idempotent — it replays the same
drafts rather than piling up duplicates.

Because the list is persistent, it keeps working after the click:

- **Future campaigns stay covered.** After each recommendation run, the
  worker re-checks every excluded term against the freshly synced structure
  and search-term facts. A campaign that starts serving an excluded term
  later — created in the wizard or directly on Amazon — gets the same
  approval-gated draft once its facts show the term. Coverage follows actual
  serving, not campaign creation, and the pass only ever drafts; it never
  writes to Amazon by itself.
- **The optimizer stops nagging.** Excluded terms are fed to the rules as
  protected search terms, so `wasteful_search_term` no longer recommends
  negating them — the exclusion mechanism already owns them.

Manage the list under **Settings → Profiles** in the **Excluded search
terms** card, which lists every excluded term with a per-term remove.
Removing a term deletes only the list entry: it does **not** pull negatives
already applied on Amazon (re-include those per campaign from the negatives
tabs), and it does not touch open drafts the enforcement pass already
created.

The older per-market bulk route (`POST /api/search-terms/:term/negatives`,
one market at a time, nothing recorded) still exists for API users who want
to block a term in a single market only.

## Max CPC

Amazon's bidding features — dynamic bid increases, placement and audience
adjustments, automated rules — can push your effective CPC far above the base
bid you set. The **Max CPC** tab on the campaign detail page makes one
ceiling explicit and enforceable.

On the **Campaigns** page, hover the profitable/not-profitable result (or focus
it with the keyboard) to see the campaign's ceiling. The tooltip shows the
configured Max CPC in that market's currency, or **Not configured** when the
campaign has no ceiling yet.

The tab reads the campaign's live bid controls and reports a coverage status:

- `not_configured` — no ceiling set.
- `pending` — a policy exists but has not been enforced yet.
- `covered` — all base bids are within the ceiling and every known Amazon-side
  bid increase is neutralized.
- `drifted` — live state no longer matches the policy (for example dynamic
  bid increases re-enabled, active placement adjustments, Amazon bid rules,
  or base bids above the ceiling), with each issue listed.

Setting a ceiling (`POST /api/campaigns/:id/max-cpc`, recent-auth required)
creates a `max_cpc` change set containing one action per bid that exceeds the
ceiling — keyword and target bids, ad group default bids, and the bidding
adjustments that inflate them. The policy is tracked in
`campaign_bid_policies` (active, then drifted if live coverage diverges) and
any later recommendation whose proposed bid exceeds an active ceiling fails
apply with `409 MAX_CPC_EXCEEDED`.

Because a ceiling batch can touch every bid in a campaign and only ever
*reduces* monetary exposure, `max_cpc` sets apply with relaxed guardrails:
up to 5,000 actions per set, reductions only (raises are forbidden by
construction), no bid cooldown, and a 1-day staleness window instead of the
usual three. Campaigns with more than 5,000 bid controls are rejected at
draft time (`409 TOO_MANY_ACTIONS`) — split them first.
