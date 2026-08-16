import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { SearchTermListRow } from "@amazon-king/contracts";
import { useBooks, useSearchTerms } from "../api/endpoints";
import { Card } from "../components/ui/card";
import { Input, Select } from "../components/ui/input";
import { SortableTh } from "../components/ui/sortable-th";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { AmazonProductLink } from "../components/amazon-product-link";
import { ProfitabilityResult } from "../components/profitability-result";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import { formatAcos, formatCount, formatMoney } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";

const PROFITABILITY_DAYS = 7;

const TEXT_COLUMNS = ["searchTerm"] as const;

type SortKey =
  | "searchTerm"
  | "campaignCount"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "acos"
  | "profit";

/** Display-only sort keys; money strings are converted to Number for ordering. */
function sortValue(
  row: SearchTermListRow,
  key: SortKey,
): number | string | null {
  switch (key) {
    case "searchTerm":
      return row.searchTerm.toLowerCase();
    case "campaignCount":
      return row.campaignCount;
    case "impressions":
      return row.totals.impressions;
    case "clicks":
      return row.totals.clicks;
    case "cost":
      return Number(row.totals.cost);
    case "sales":
      return Number(row.totals.sales);
    case "orders":
      return row.totals.orders;
    case "acos":
      return row.totals.acos;
    case "profit":
      return row.estimatedAdProfit === null
        ? null
        : Number(row.estimatedAdProfit);
  }
}

export function SearchTermsPage() {
  const search = useSearch({ strict: false }) as { book?: string };
  const book = search.book;
  const navigate = useNavigate();
  const books = useBooks();
  const searchTerms = useSearchTerms(PROFITABILITY_DAYS, book);
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [query, setQuery] = useState("");

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  const trimmedQuery = query.trim().toLowerCase();
  const filteredRows = (searchTerms.data ?? []).filter(
    (row) =>
      trimmedQuery === "" ||
      row.searchTerm.toLowerCase().includes(trimmedQuery),
  );
  const sortedRows = searchTerms.data
    ? [...filteredRows].sort((a, b) =>
        compareNullable(
          sortValue(a, sort.key),
          sortValue(b, sort.key),
          sort.direction,
        ),
      )
    : [];

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          Search terms
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Input
            type="search"
            aria-label="Filter search terms"
            placeholder="Filter terms…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-48"
          />
          <label htmlFor="product-filter" className="text-sm text-zinc-400">
            Product
          </label>
          <Select
            id="product-filter"
            value={book ?? ""}
            onChange={(event) =>
              void navigate({
                to: "/search-terms",
                search: event.target.value ? { book: event.target.value } : {},
                replace: true,
              })
            }
          >
            <option value="">All products</option>
            {(books.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} ({b.format})
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Card>
        {searchTerms.isPending ? (
          <Loading />
        ) : searchTerms.error ? (
          <ErrorState error={searchTerms.error} />
        ) : sortedRows.length === 0 ? (
          <EmptyState>
            {trimmedQuery !== ""
              ? `No search terms match “${query.trim()}”.`
              : book
                ? "No search terms for this product in the selected window."
                : "No search terms imported yet. Connect Amazon Ads and run a sync first."}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  label="Search term"
                  column="searchTerm"
                  sort={sort}
                  onSort={onSort}
                />
                <Th>Market</Th>
                <SortableTh
                  label="Campaigns"
                  column="campaignCount"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <Th className="hidden md:table-cell">
                  {PROFITABILITY_DAYS}-day profit
                </Th>
                <SortableTh
                  label="Impressions"
                  column="impressions"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Clicks"
                  column="clicks"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Spend"
                  column="cost"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Sales"
                  column="sales"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Orders"
                  column="orders"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="ACoS"
                  column="acos"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((term) => {
                const currency = term.currency;
                const defaultCountry = term.countryCodes.includes("US")
                  ? "US"
                  : term.countryCodes[0];
                const hasActivity = hasCampaignActivity(term.totals);
                const profitStatus = getCampaignProfitStatus(
                  term.totals,
                  term.economicsMissing,
                  term.estimatedAdProfit,
                );
                return (
                  <tr key={term.searchTerm}>
                    <Td className="max-w-xs">
                      <Link
                        to="/search-terms/$term"
                        params={{ term: term.searchTerm }}
                        search={{
                          days: PROFITABILITY_DAYS,
                          ...(book ? { book } : {}),
                          ...(defaultCountry
                            ? { country: defaultCountry }
                            : {}),
                        }}
                        className="break-words text-sky-400 hover:underline"
                      >
                        {term.searchTerm}
                      </Link>
                      <AmazonProductLink
                        term={term.searchTerm}
                        countryCode={defaultCountry}
                        className="ml-2 whitespace-nowrap text-xs"
                      />
                      <div className="mt-2 md:hidden">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                          {PROFITABILITY_DAYS}-day profit
                        </p>
                        <ProfitabilityResult
                          status={profitStatus}
                          amount={term.estimatedAdProfit}
                          currency={currency}
                          economicsMissing={term.economicsMissing}
                          hasActivity={hasActivity}
                        />
                      </div>
                    </Td>
                    <Td
                      className="whitespace-nowrap text-xs text-zinc-500"
                      title={term.countryCodes
                        .map((code) => countryNameForCode(code))
                        .join(", ")}
                    >
                      {term.countryCodes.map((code) => (
                        <span
                          key={code}
                          className="mr-2 inline-flex items-center gap-1 last:mr-0"
                        >
                          <Flag countryCode={code} />
                          {code}{" "}
                        </span>
                      ))}
                    </Td>
                    <Td className="text-right">
                      {formatCount(term.campaignCount)}
                    </Td>
                    <Td
                      className="hidden whitespace-nowrap md:table-cell"
                      aria-label={`${term.searchTerm} seven-day profit: ${profitStatus.label}`}
                    >
                      <ProfitabilityResult
                        status={profitStatus}
                        amount={term.estimatedAdProfit}
                        currency={currency}
                        economicsMissing={term.economicsMissing}
                        hasActivity={hasActivity}
                      />
                    </Td>
                    <Td className="text-right">
                      {formatCount(term.totals.impressions)}
                    </Td>
                    <Td className="text-right">
                      {formatCount(term.totals.clicks)}
                    </Td>
                    <Td className="text-right">
                      {formatMoney(term.totals.cost, currency)}
                    </Td>
                    <Td className="text-right">
                      {formatMoney(term.totals.sales, currency)}
                    </Td>
                    <Td className="text-right">
                      {formatCount(term.totals.orders)}
                    </Td>
                    <Td className="text-right">
                      {formatAcos(term.totals.acos)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
