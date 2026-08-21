import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { SearchTermListRow } from "@amazon-king/contracts";
import { useBooks, useProfiles, useSearchTerms } from "../api/endpoints";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  columnAriaSort,
  SortButton,
  SortableTh,
} from "../components/ui/sortable-th";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { CountrySelect } from "../components/country-select";
import { AmazonProductLink } from "../components/amazon-product-link";
import { BookCoverStack } from "../components/book-covers";
import { ProfitabilityResult } from "../components/profitability-result";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import {
  formatAcos,
  formatCount,
  formatMoney,
  ORDERS_COLUMN_TITLE,
} from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";
import { resolveTimeframe, windowQualifier } from "../lib/timeframe";
import { TimeframeSelect } from "../components/timeframe-select";

const TEXT_COLUMNS = ["searchTerm"] as const;

type SortKey =
  | "searchTerm"
  | "campaignCount"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "units"
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
    case "units":
      return row.totals.units;
    case "acos":
      return row.totals.acos;
    case "profit":
      return row.estimatedAdProfit === null
        ? null
        : Number(row.estimatedAdProfit);
  }
}

export function SearchTermsPage() {
  const search = useSearch({ strict: false }) as {
    days?: number | "mtd";
    books?: string[];
    country?: string;
  };
  const country = search.country;
  const days = resolveTimeframe(search.days);
  const navigate = useNavigate();
  const profiles = useProfiles();
  const books = useBooks();
  const searchTerms = useSearchTerms(days, search.books, country);
  const marketplaces = useSpendSortedMarketplaces(days, search.books);
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [query, setQuery] = useState("");

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  function setCountryFilter(country: string) {
    void navigate({
      to: "/search-terms",
      search: (prev) => ({
        ...prev,
        country: country === "" ? undefined : country,
      }),
      replace: true,
    });
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TimeframeSelect
            value={days}
            onChange={(window) =>
              navigate({
                to: "/search-terms",
                search: (prev) => ({ ...prev, days: window }),
                replace: true,
              })
            }
          />
          <CountrySelect
            value={country ?? ""}
            options={marketplaces}
            allLabel="All markets"
            aria-label="Filter by market"
            disabled={profiles.isPending}
            onChange={setCountryFilter}
          />
          <Input
            type="search"
            aria-label="Filter search terms"
            placeholder="Filter terms…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-48"
          />
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
              : country
                ? `No search terms in ${countryNameForCode(country)} for the selected window.`
                : search.books && search.books.length > 0
                  ? "No search terms for the selected products in this window."
                  : "No search terms imported yet. Connect Amazon Ads and run a sync first."}
          </EmptyState>
        ) : (
          <Table stickyHeader>
            <thead>
              <tr>
                <Th aria-sort={columnAriaSort(sort, ["searchTerm", "profit"])}>
                  <div className="flex flex-col items-start gap-1">
                    <SortButton
                      label="Search term"
                      column="searchTerm"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortButton
                      label={`${windowQualifier(days)} profit`}
                      column="profit"
                      sort={sort}
                      onSort={onSort}
                      className="md:hidden"
                    />
                  </div>
                </Th>
                <Th>Market</Th>
                <SortableTh
                  label="Campaigns"
                  column="campaignCount"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label={`${windowQualifier(days)} profit`}
                  column="profit"
                  sort={sort}
                  onSort={onSort}
                  className="hidden md:table-cell"
                />
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
                  title={ORDERS_COLUMN_TITLE}
                />
                <SortableTh
                  label="Units"
                  column="units"
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
                const defaultCountry =
                  country ??
                  (term.countryCodes.includes("US")
                    ? "US"
                    : term.countryCodes[0]);
                const hasActivity = hasCampaignActivity(term.totals);
                const profitStatus = getCampaignProfitStatus(
                  term.totals,
                  term.economicsMissing,
                  term.estimatedAdProfit,
                );
                return (
                  <tr key={term.searchTerm}>
                    <Td className="max-w-xs">
                      <div className="flex items-start gap-2">
                        <BookCoverStack
                          bookIds={term.bookIds}
                          books={books.data}
                        />
                        <div className="min-w-0">
                          <Link
                            to="/search-terms/$term"
                            params={{ term: term.searchTerm }}
                            search={{
                              days,
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
                              {windowQualifier(days)} profit
                            </p>
                            <ProfitabilityResult
                              status={profitStatus}
                              amount={term.estimatedAdProfit}
                              currency={currency}
                              economicsMissing={term.economicsMissing}
                              hasActivity={hasActivity}
                            />
                          </div>
                        </div>
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
                      aria-label={`${term.searchTerm} ${windowQualifier(days)} profit: ${profitStatus.label}`}
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
                      {formatCount(term.totals.units)}
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
