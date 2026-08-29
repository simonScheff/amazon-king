import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  KdpFulfillmentSeries,
  KdpHistorySeries,
} from "@amazon-king/contracts";
import {
  KDP_SALES_PAGE_SIZE,
  useKdpHistory,
  useKdpSaleTransactions,
} from "../api/endpoints";
import {
  RoyaltyTrendChart,
  SalesMixChart,
} from "../components/kdp-history-charts";
import { Flag } from "../components/flag";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/input";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  formatCount,
  formatDate,
  formatMoney,
  formatMonth,
} from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";

/**
 * /kdp-history — phase 2 of docs/kdp-royalty-import-plan.md (decision 10):
 * the analytics surface for KDP royalty imports. Settings stays operational
 * (import button + log); trends, sales mix, fulfillment time, and the per-sale
 * transaction browser live here.
 */

function mixBookOptions(series: readonly KdpHistorySeries[]) {
  const byId = new Map<string, string>();
  for (const entry of series) {
    if (!byId.has(entry.bookId)) byId.set(entry.bookId, entry.title);
  }
  return [...byId.entries()]
    .map(([bookId, title]) => ({ bookId, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Median order→ship days per month as a mini bar strip, oldest → newest.
 * Bar heights are only scaled within the strip, so the exact numbers live in
 * a hover/focus tooltip per bar; the endpoint months are labeled underneath
 * to make the time direction obvious. The latest month's bar is highlighted
 * to match the "Latest month" columns.
 */
function FulfillmentTrend({
  months,
}: {
  months: KdpFulfillmentSeries["months"];
}) {
  const recent = months.slice(-12);
  const max = Math.max(...recent.map((m) => m.medianDays), 1);
  const first = recent[0];
  const last = recent.at(-1);
  return (
    <span
      className="inline-flex flex-col"
      role="group"
      aria-label="Monthly median fulfillment time trend"
    >
      <span className="inline-flex items-end gap-0.5">
        {recent.map((m, i) => (
          <span key={m.month} className="group relative">
            <span
              tabIndex={0}
              aria-label={`${formatMonth(m.month)}: median ${m.medianDays.toFixed(1)} days`}
              className={`block w-1.5 rounded-sm outline-none transition-colors ${
                i === recent.length - 1
                  ? "bg-sky-400 group-hover:bg-sky-300 group-focus-visible:bg-sky-300"
                  : "bg-sky-500/50 group-hover:bg-sky-400 group-focus-visible:bg-sky-400"
              }`}
              style={{ height: `${Math.max(2, (m.medianDays / max) * 24)}px` }}
            />
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-925 px-2 py-1 text-left text-[11px] leading-snug opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
                i === 0
                  ? "left-0"
                  : i === recent.length - 1
                    ? "right-0"
                    : "left-1/2 -translate-x-1/2"
              }`}
            >
              <span className="block font-medium text-zinc-100">
                {formatMonth(m.month)}
              </span>
              <span className="block text-zinc-400">
                {`Median ${m.medianDays.toFixed(1)} d · avg ${m.averageDays.toFixed(1)} d · ${formatCount(m.standardUnits)} sales`}
              </span>
            </span>
          </span>
        ))}
      </span>
      {first && last ? (
        <span className="mt-1 flex justify-between gap-3 text-[10px] leading-none text-zinc-500">
          <span>{formatMonth(first.month)}</span>
          {recent.length > 1 ? <span>{formatMonth(last.month)}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function FulfillmentCard({
  fulfillment,
}: {
  fulfillment: readonly KdpFulfillmentSeries[];
}) {
  return (
    <Card>
      <CardHeader
        title="Fulfillment time"
        description="Order → ship days for standard-rate print sales. Expanded-distribution sales are excluded — Amazon doesn't print those."
      />
      {fulfillment.length === 0 ? (
        <EmptyState>No fulfillment data yet.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Marketplace</Th>
              <Th>Latest month</Th>
              <Th>Median days</Th>
              <Th>Average days</Th>
              <Th>Median days by month</Th>
            </tr>
          </thead>
          <tbody>
            {fulfillment.map((entry) => {
              const latest = entry.months.at(-1);
              return (
                <tr key={entry.profileId}>
                  <Td className="whitespace-nowrap align-middle">
                    <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
                      <Flag countryCode={entry.countryCode} />
                      {countryNameForCode(entry.countryCode)}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm">
                    {latest ? formatMonth(latest.month) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm tabular-nums">
                    {latest ? `${latest.medianDays.toFixed(1)}` : "—"}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm tabular-nums">
                    {latest ? `${latest.averageDays.toFixed(1)}` : "—"}
                  </Td>
                  <Td className="align-middle">
                    <FulfillmentTrend months={entry.months} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Days between two ISO dates (royalty date − order date = fulfillment lag). */
function lagDays(orderDate: string, royaltyDate: string): number {
  const start = Date.parse(`${orderDate}T00:00:00Z`);
  const end = Date.parse(`${royaltyDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function TransactionsCard({ series }: { series: readonly KdpHistorySeries[] }) {
  const [bookId, setBookId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [month, setMonth] = useState("");
  const [page, setPage] = useState(0);
  const transactions = useKdpSaleTransactions({
    bookId: bookId || undefined,
    profileId: profileId || undefined,
    month: month || undefined,
    page,
  });

  const books = mixBookOptions(series);
  const markets = [
    ...new Map(
      series.map((entry) => [
        entry.profileId,
        { profileId: entry.profileId, countryCode: entry.countryCode },
      ]),
    ).values(),
  ].sort((a, b) =>
    countryNameForCode(a.countryCode).localeCompare(
      countryNameForCode(b.countryCode),
    ),
  );
  const months = [
    ...new Set(series.flatMap((entry) => entry.months.map((m) => m.month))),
  ].sort((a, b) => b.localeCompare(a));

  return (
    <Card>
      <CardHeader title="Individual sales" />
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <Select
          aria-label="Filter by book"
          value={bookId}
          onChange={(event) => {
            setBookId(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All books</option>
          {books.map((book) => (
            <option key={book.bookId} value={book.bookId}>
              {book.title}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by marketplace"
          value={profileId}
          onChange={(event) => {
            setProfileId(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All marketplaces</option>
          {markets.map((market) => (
            <option key={market.profileId} value={market.profileId}>
              {countryNameForCode(market.countryCode)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by month"
          value={month}
          onChange={(event) => {
            setMonth(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All months</option>
          {months.map((value) => (
            <option key={value} value={value}>
              {formatMonth(value)}
            </option>
          ))}
        </Select>
      </div>
      {transactions.isPending ? (
        <Loading label="Loading sales…" />
      ) : transactions.error ? (
        <ErrorState error={transactions.error} />
      ) : transactions.data.transactions.length === 0 ? (
        <EmptyState>No sales match the current filters.</EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Order date</Th>
                <Th>Book / ASIN</Th>
                <Th>Marketplace</Th>
                <Th>Format</Th>
                <Th>Royalty type</Th>
                <Th>Net units</Th>
                <Th>Royalty</Th>
                <Th>Ship lag</Th>
              </tr>
            </thead>
            <tbody>
              {transactions.data.transactions.map((sale) => (
                <tr key={sale.id}>
                  <Td className="whitespace-nowrap text-xs text-zinc-500">
                    {formatDate(sale.orderDate)}
                  </Td>
                  <Td className="max-w-64">
                    {sale.title ? (
                      <span className="block truncate text-sm text-zinc-200">
                        {sale.title}
                      </span>
                    ) : null}
                    <span className="font-mono text-xs text-zinc-500">
                      {sale.asin}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-sm">
                    {sale.marketplace}
                  </Td>
                  <Td className="whitespace-nowrap text-sm capitalize">
                    {sale.format}
                  </Td>
                  <Td className="whitespace-nowrap text-sm">
                    {sale.royaltyType}
                  </Td>
                  <Td className="whitespace-nowrap text-sm tabular-nums">
                    {formatCount(sale.netUnits)}
                  </Td>
                  <Td className="whitespace-nowrap text-sm tabular-nums">
                    {formatMoney(sale.royalty, sale.currency)}
                  </Td>
                  <Td className="whitespace-nowrap text-sm tabular-nums">
                    {lagDays(sale.orderDate, sale.royaltyDate)}{" "}
                    {lagDays(sale.orderDate, sale.royaltyDate) === 1
                      ? "day"
                      : "days"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {transactions.data.total > KDP_SALES_PAGE_SIZE ? (
            <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
              <span className="tabular-nums">
                {page * KDP_SALES_PAGE_SIZE + 1}–
                {Math.min(
                  (page + 1) * KDP_SALES_PAGE_SIZE,
                  transactions.data.total,
                )}{" "}
                of {formatCount(transactions.data.total)}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous
                </Button>
                <span className="tabular-nums">
                  Page {page + 1} of{" "}
                  {Math.ceil(transactions.data.total / KDP_SALES_PAGE_SIZE)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    (page + 1) * KDP_SALES_PAGE_SIZE >= transactions.data.total
                  }
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

export function KdpHistoryPage() {
  const search = useSearch({ strict: false }) as { book?: string };
  const navigate = useNavigate();
  const history = useKdpHistory();

  const series = history.data?.series ?? [];
  const books = mixBookOptions(series);
  // The sales-mix selector lives in the URL (?book=<bookId>); "all" sums
  // units across every book (units are currency-free, so summing is honest).
  const mixBook =
    search.book !== undefined && books.some((b) => b.bookId === search.book)
      ? search.book
      : "all";
  const mixSeries =
    mixBook === "all"
      ? series
      : series.filter((entry) => entry.bookId === mixBook);
  const isEmpty =
    history.data !== undefined &&
    history.data.series.length === 0 &&
    history.data.fulfillment.length === 0;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="text-xl font-bold tracking-tight text-zinc-100">
        KDP history
      </h1>

      {history.isPending ? (
        <Loading label="Loading KDP history…" />
      ) : history.error ? (
        <ErrorState error={history.error} />
      ) : isEmpty ? (
        <Card>
          <EmptyState>
            No KDP sales history yet. Import a KDP Royalties Estimator report
            from{" "}
            <Link
              to="/settings"
              search={{ tab: "kdp" }}
              className="text-sky-400 underline underline-offset-2 hover:text-sky-300"
            >
              Settings → KDP imports
            </Link>{" "}
            to see royalty trends, the ad/organic sales mix, fulfillment times,
            and individual sales here.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Net royalty per sale — trend"
              description="The book-economics value in effect at the end of each month. Each line is labeled with its own currency — nothing is converted or summed."
            />
            <CardBody>
              <RoyaltyTrendChart series={series} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Sales mix by month"
              description="Ad-attributed copies vs. the rest of what KDP recorded. The two never align perfectly — organic is clamped at zero."
              action={
                <Select
                  aria-label="Sales mix book"
                  value={mixBook}
                  onChange={(event) => {
                    const book = event.target.value || undefined;
                    void navigate({
                      to: "/kdp-history",
                      search: (prev) => ({ ...prev, book }),
                      replace: true,
                    });
                  }}
                >
                  <option value="all">All books</option>
                  {books.map((book) => (
                    <option key={book.bookId} value={book.bookId}>
                      {book.title}
                    </option>
                  ))}
                </Select>
              }
            />
            <CardBody>
              <SalesMixChart series={mixSeries} />
            </CardBody>
          </Card>

          <FulfillmentCard fulfillment={history.data?.fulfillment ?? []} />

          <TransactionsCard series={series} />
        </>
      )}
    </div>
  );
}
