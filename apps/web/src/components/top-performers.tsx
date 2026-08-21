import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { MetricWindow } from "@amazon-king/contracts";
import { useBooks, useCampaigns, useSearchTerms } from "../api/endpoints";
import { Card, CardHeader } from "./ui/card";
import { BookCoverStack, type CoverBook } from "./book-covers";
import { EmptyState, ErrorState, Loading } from "./states";
import { formatAcos, formatCount, formatMoney } from "../lib/format";
import { getCampaignProfitStatus } from "../lib/campaign-profit";

const TOP_COUNT = 5;

type Tone = "neutral" | "success" | "warning" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  success: "text-emerald-300",
  danger: "text-red-300",
  warning: "text-zinc-400",
  neutral: "text-zinc-400",
};

interface TopRow {
  key: string;
  /** Linked primary label (term text or campaign name). */
  name: ReactNode;
  /** Secondary line under the name. */
  sub: string;
  bookIds: string[];
  /** Formatted estimated ad profit — the metric the list is ranked by. */
  profit: string;
  acos: number | null;
  tone: Tone;
  /** Bar width as a fraction of the leader's profit, 0–1. */
  share: number;
}

function windowLabel(days: MetricWindow): string {
  return days === "mtd" ? "month to date" : `${days} days`;
}

function TopCard({
  title,
  note,
  rows,
  emptyText,
  books,
  barClass,
  viewAllTo,
  viewAllLabel,
  pending,
  error,
}: {
  title: string;
  note: string;
  rows: TopRow[] | undefined;
  emptyText: string;
  books: CoverBook[] | undefined;
  barClass: string;
  viewAllTo: "/search-terms" | "/campaigns";
  viewAllLabel: string;
  pending: boolean;
  error: unknown;
}) {
  return (
    // min-w-0: as a grid item the card's automatic minimum is its min-content
    // (the un-truncated row text), which can exceed the viewport on mobile.
    <Card className="min-w-0">
      <CardHeader
        title={title}
        action={<span className="text-xs text-zinc-500">{note}</span>}
      />
      {pending ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1 px-3 py-2">
          {rows.map((row) => (
            <li
              key={row.key}
              className="relative flex items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-2"
            >
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 rounded-md bg-gradient-to-r ${barClass}`}
                style={{ width: `${Math.max(row.share * 100, 4)}%` }}
              />
              <span className="relative">
                <BookCoverStack bookIds={row.bookIds} books={books} size="sm" />
              </span>
              <div className="relative min-w-0 flex-1">
                <div className="truncate text-sm text-zinc-200">{row.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{row.sub}</div>
              </div>
              <div className="relative shrink-0 text-right">
                <div className="text-sm font-semibold tabular-nums text-zinc-100">
                  {row.profit}
                </div>
                <div
                  className={`mt-0.5 text-xs tabular-nums ${TONE_CLASS[row.tone]}`}
                >
                  {formatAcos(row.acos)} ACoS
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link
        to={viewAllTo}
        className="block border-t border-zinc-800 px-5 py-3 text-center text-sm text-zinc-400 transition-colors hover:text-sky-300"
      >
        {viewAllLabel} →
      </Link>
    </Card>
  );
}

/**
 * "Top performers" section for the overview: the most profitable search
 * terms and campaigns in the selected window, each with the covers of the
 * books it sells and a share-of-leader bar. Ranked by estimated ad profit,
 * which needs user-entered book economics — rows without a profit figure are
 * left out, and when economics are missing entirely the cards say so instead
 * of guessing. ACoS text is colored by the profit verdict.
 */
export function TopPerformers({
  days,
  country,
  bookIds,
  profileIds,
}: {
  days: MetricWindow;
  country: string;
  bookIds?: string[];
  /** Profiles of the selected marketplace; campaigns are filtered to these. */
  profileIds: ReadonlySet<string>;
}) {
  const books = useBooks();
  const terms = useSearchTerms(days, bookIds, country);
  const campaigns = useCampaigns(days, bookIds);

  const note = `by profit · ${windowLabel(days)}`;

  const profitableTerms = [...(terms.data ?? [])]
    .filter(
      (row) =>
        row.estimatedAdProfit !== null && Number(row.estimatedAdProfit) > 0,
    )
    .sort((a, b) => Number(b.estimatedAdProfit) - Number(a.estimatedAdProfit))
    .slice(0, TOP_COUNT);
  const termLeader = profitableTerms[0]
    ? Number(profitableTerms[0].estimatedAdProfit)
    : 0;
  const termRows: TopRow[] | undefined = terms.data
    ? profitableTerms.map((row) => {
        const profit = Number(row.estimatedAdProfit);
        return {
          key: row.searchTerm,
          name: (
            <Link
              to="/search-terms/$term"
              params={{ term: row.searchTerm }}
              search={{ days, country }}
              className="hover:text-sky-300 hover:underline"
            >
              {row.searchTerm}
            </Link>
          ),
          sub: `${formatCount(row.totals.orders)} orders · ${formatMoney(row.totals.sales, row.currency)} sales`,
          bookIds: row.bookIds,
          profit: formatMoney(row.estimatedAdProfit, row.currency),
          acos: row.totals.acos,
          tone: getCampaignProfitStatus(
            row.totals,
            row.economicsMissing,
            row.estimatedAdProfit,
          ).tone,
          share: termLeader > 0 ? profit / termLeader : 0,
        };
      })
    : undefined;

  const profitableCampaigns = [...(campaigns.data ?? [])]
    .filter(
      (row) =>
        profileIds.has(row.profileId) &&
        row.profitability.estimatedAdProfit !== null &&
        Number(row.profitability.estimatedAdProfit) > 0,
    )
    .sort(
      (a, b) =>
        Number(b.profitability.estimatedAdProfit) -
        Number(a.profitability.estimatedAdProfit),
    )
    .slice(0, TOP_COUNT);
  const campaignLeader = profitableCampaigns[0]
    ? Number(profitableCampaigns[0].profitability.estimatedAdProfit)
    : 0;
  const campaignRows: TopRow[] | undefined = campaigns.data
    ? profitableCampaigns.map((row) => {
        const profit = Number(row.profitability.estimatedAdProfit);
        const sales = Number(row.totals.sales);
        const cost = Number(row.totals.cost);
        return {
          key: row.campaignId,
          name: (
            <Link
              to="/campaigns/$id"
              params={{ id: row.campaignId }}
              className="hover:text-sky-300 hover:underline"
            >
              {row.name}
            </Link>
          ),
          sub: `${formatCount(row.totals.orders)} orders · ${formatMoney(row.totals.cost, row.profitability.currency)} spend`,
          bookIds: row.bookIds,
          profit: formatMoney(
            row.profitability.estimatedAdProfit,
            row.profitability.currency,
          ),
          acos: sales > 0 ? cost / sales : null,
          tone: getCampaignProfitStatus(
            row.totals,
            row.profitability.economicsMissing,
            row.profitability.estimatedAdProfit,
          ).tone,
          share: campaignLeader > 0 ? profit / campaignLeader : 0,
        };
      })
    : undefined;

  // When rows exist but none have a profit figure, economics are missing —
  // say so instead of implying nothing sold.
  const termsNeedEconomics =
    (terms.data ?? []).some((row) => Number(row.totals.sales) > 0) &&
    profitableTerms.length === 0;
  const campaignsNeedEconomics =
    (campaigns.data ?? []).some(
      (row) => profileIds.has(row.profileId) && Number(row.totals.sales) > 0,
    ) && profitableCampaigns.length === 0;
  const economicsHint =
    "Profit needs book economics — enter them under Settings → Book economics.";

  return (
    <div className="grid gap-6">
      <TopCard
        title="Top search terms"
        note={note}
        rows={termRows}
        emptyText={
          termsNeedEconomics
            ? economicsHint
            : "No profitable search terms in this window."
        }
        books={books.data}
        barClass="from-sky-400/15 to-sky-400/5"
        viewAllTo="/search-terms"
        viewAllLabel="View all search terms"
        pending={terms.isPending}
        error={terms.error}
      />
      <TopCard
        title="Top campaigns"
        note={note}
        rows={campaignRows}
        emptyText={
          campaignsNeedEconomics
            ? economicsHint
            : "No profitable campaigns in this window."
        }
        books={books.data}
        barClass="from-violet-400/15 to-violet-400/5"
        viewAllTo="/campaigns"
        viewAllLabel="View all campaigns"
        pending={campaigns.isPending}
        error={campaigns.error}
      />
    </div>
  );
}
