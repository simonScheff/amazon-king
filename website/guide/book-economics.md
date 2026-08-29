---
title: Book Economics
description: Why ACoS is not author profit, and how to enter per-book KDP royalty economics so amazon-king can make profit-aware recommendations.
---

# Book Economics

Amazon reports ACoS — **ad spend divided by ad-attributed retail revenue**.
That number measures the ad account's efficiency against the retail price the
*customer* paid. It is not your profit. As a KDP author you earn a royalty
per sale, not the list price: printing costs, Amazon's cut, and delivery fees
sit between the two. A campaign at 30% ACoS can be profitable for one book
and a loss-maker for another, depending on royalty.

amazon-king therefore keeps two layers strictly separate:

- **ACoS-based recommendations** work from imported ad data alone.
- **Profit-aware recommendations** require economics you enter yourself. The
  optimizer never guesses royalties — when economics are missing, profit
  recommendations are suppressed entirely.

![Settings page with book economics and advertised ASIN identification](/screenshots/settings.png)

## Identifying your books

The ad account knows ASINs, not titles. After the first sync, open
**Settings → New ASINs**. Each advertised ASIN that is
not yet linked to your catalog appears there; identify it by confirming:

- the **title**,
- the **format** (`paperback`, `hardcover`, `kindle`, or `other`),
- the **profiles** (markets) where this ASIN is yours, and
- optionally a **cover image URL**.

Submitting posts to `POST /api/books/mappings` and links the ASIN to a book
in your workspace catalog, so dashboards and rules can attribute ad sales to
a real book.

## Expanding to another marketplace

Catalog links are also how the new-campaign wizard knows which ASIN to put
on a product ad. Those links are usually created from ads that already exist
in a market. To advertise a book in a store where it has **no ads yet** —
for example a US-only paperback you now want to run in the UK — open the
book on **Settings → Books & economics**, expand **Link another market**,
and use **Add to …**. Confirm the marketplace ASIN
(KDP often reuses the same ASIN). The new-campaign wizard Book step offers
the same control for books that do not yet cover every selected market.

This does **not** enroll the paperback on Amazon.co.uk. The listing must
already be for sale on that store in KDP. amazon-king only records the ASIN
for the product ad; Amazon rejects apply if the ASIN is not yours there.
Profit recommendations stay off for that market until you enter royalty
economics.

The API is `POST /api/books/:bookId/profile-links`. It is a local catalog
write (session + CSRF), not an Amazon write, so it does not require recent
sign-in.

## Entering economics

Economics are entered per **book per market** (profile) on
**Settings → Books & economics**: expand the book, edit the market's row, and
save. The `effectiveFrom` date and `notes` live behind the row's **Details**
toggle. Each entry carries:

| Field | Meaning |
| --- | --- |
| `listPrice` | Retail list price in the market's currency. |
| `estimatedRoyaltyPerSale` | Your net royalty per sale — the amount that actually reaches you. This is the number profit math runs on. |
| `effectiveFrom` | The date these economics apply from (see below). |
| `targetAcos` | Optional target ACoS as a 0–1 fraction (e.g. `0.30`). Drives bid proposals. |
| `goalMode` | `profit`, `balanced`, `launch`, or `visibility` (see below). |
| `maxSpendWithoutSale` | Optional cap on spend allowed before a sale. |
| `maxBid` / `maxDailyBudget` | Optional hard ceilings used as guardrail inputs. |
| `notes` | Free text, kept with the entry. |

Money fields are decimal strings in the profile's currency; amazon-king never
aggregates across currencies (the FX-converted All markets overview is the
one explicit, read-side exception).

### Effective-dated history

Economics are **effective-dated**, not overwritten. Rows are unique per
(book, profile, `effective_from`), and the optimizer uses the latest row
whose `effective_from` is on or before today. When a launch price ends or a
royalty changes, add a new row with a new effective date instead of editing
the old one — historical recommendations stay reproducible against the
economics that were in force at the time.

## Importing royalty from a KDP report

Instead of hand-calculating royalty per sale, you can recalibrate it from
actuals once a month. Download the **Royalties Estimator** workbook (.xlsx)
from your KDP dashboard for last month, then click **Import from KDP report**
on **Settings → Books & economics** (the same button lives on
**Settings → KDP imports**). The file is parsed in your browser and
never leaves your own deployment.

amazon-king derives a suggested royalty per copy per book and market from
**standard-rate sales only** — expanded-distribution sales (the 40%/50%
royalty rows) can't come from an ad click, so they are excluded from the math
and shown as context instead. The review screen lists every suggestion with
its evidence (standard copies sold in the period), flags rows with **low
evidence** (fewer than five standard copies, unchecked by default) and rows
that **deviate more than 15%** from the current value, and explains any
skipped rows (unknown marketplace, ASIN not linked, currency mismatch, or no
standard-rate sales).

Applying writes only the royalty per sale — list price, target ACoS, goal
mode, and limits are kept from the latest economics row, effective from the
date you choose. Books with no economics row yet are not touchable here;
profit rules correctly stay off for them until you complete their row
manually. Re-uploading the same file replays the existing import instead of
duplicating it, and each import applies once. Every applied row is written
through the same audited save path as a manual edit.

KDP reports carry no ad attribution and arrive with a processing lag of
several days, so this is a monthly recalibration ritual — download a few days
into the new month — not a per-day truth. Per-day profit figures continue to
come from your synced ads data valued with these economics.

**Settings → KDP imports** keeps the operational record: every imported
batch with its report period, file name, row and suggestion counts, status
(**Applied** with the date, or **Not applied**), and when it was imported.

## KDP history

Every import also stores what it saw: the individual sale rows, merged
additively — re-uploading or overlapping files (every KDP report carries a
tail of previous-month orders) can never destroy or duplicate earlier data.
Monthly totals are derived from those rows, grouped by **KDP report month** —
the month the royalty posted, exactly like your KDP dashboard displays it.
The **KDP history** page in the sidebar turns that into four views:

- **Royalty per sale — trend.** One line per book and market, drawn from
  your effective-dated economics history. Each line is labeled with its own
  currency — values are never converted or summed across markets.
- **Sales mix by month.** Ad-attributed copies (from your synced ads data)
  against the rest of what KDP recorded, per book. The two never align
  perfectly — attribution windows and order dates differ — so the organic
  bar is clamped at zero rather than going negative.
- **Fulfillment time.** Median and average order-to-ship days per
  marketplace, over standard-rate print sales only. Expanded-distribution
  sales are excluded — Amazon doesn't print those, so their lag measures a
  third party.
- **Individual sales.** Every stored sale with book, marketplace, and month
  filters and a ship-lag column — useful when one month's numbers look off.

A skipped month simply shows as a gap; there is no catch-up requirement,
because the last applied economics keep applying until the next import.

## What changes when economics are present

With at least one effective economics row for a market:

- The dashboard shows the **Est. royalty** and **Est. ad profit** KPIs and
  the **Daily profitability** chart. Royalty is each advertised book's own
  figure in that marketplace (copies sold × that book's net royalty for the
  country), never one rate for the whole account. Copies, not orders: a single
  order of three copies earns three royalties, and Amazon reports the two
  numbers separately. On days imported before amazon-king collected units the
  order count is used instead, which understates a multi-copy day rather than
  reporting no royalty. Without economics these stay hidden and the dashboard
  says so explicitly.
- The profit-aware rules activate:
  `expensive_target` (cut bids on unprofitable targets),
  `profitable_target` (raise bids on profitable ones),
  `budget_constrained_winner` (flag winners starved by budget), and
  `placement_opportunity` (placement-level profit signals).
- `targetAcos` and royalty feed the bid proposal formula, so suggested bids
  aim at *your* break-even point rather than retail ACoS.

Without economics, every profit rule stays silent and the system degrades to
ACoS-only advice. Per-rule thresholds are listed in
[Optimization rules](/reference/optimization-rules).

## Goal modes

The goal mode tunes how aggressive the rules may be for a book:

- `profit` — optimize strictly for royalty profit.
- `balanced` — the default; profit-aware but tolerant of moderate spend.
- `launch` — discovery mode for new releases. In launch mode the
  `expensive_target` and `wasteful_search_term` rules are suppressed: the
  system will not down-bid or negative-keyword a book you are deliberately
  spending to explore.
- `visibility` — maximize exposure while staying inside your caps.

Goal mode is per book per market, so a mature backlist title can run on
`profit` while a new release runs on `launch` in the same account.

## Next steps

With economics in place, recommendations become profit-aware — see
[Reviewing recommendations](/guide/recommendations), and
[Applying & rolling back changes](/guide/applying-changes) for what happens
when you approve one.
