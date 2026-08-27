import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { NegativeKind, NegativeListRow } from "@amazon-king/contracts";
import {
  useBooks,
  useNegatives,
  useProfiles,
  useSearchTermExclusions,
} from "../api/endpoints";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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
import { ExcludeSearchTermGlobal } from "../components/exclude-search-term-global";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import {
  formatAcos,
  formatAmazonLabel,
  formatCount,
  formatDate,
  formatMoney,
} from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";
import { resolveTimeframe, windowQualifier } from "../lib/timeframe";
import { TimeframeSelect } from "../components/timeframe-select";

const TEXT_COLUMNS = ["value"] as const;

type SortKey =
  | "value"
  | "blocking"
  | "stillServing"
  | "soldBefore"
  | "profit"
  | "lastServed";

type InsightFilter = "all" | "leaking" | "sold" | "catalog";

function sortValue(row: NegativeListRow, key: SortKey): number | string | null {
  switch (key) {
    case "value":
      return row.value.toLowerCase();
    case "blocking":
      return row.blockingCampaignCount;
    case "stillServing":
      return row.stillServingCampaignCount;
    case "soldBefore":
      return row.before.orders;
    case "profit":
      return row.window.estimatedAdProfit === null
        ? null
        : Number(row.window.estimatedAdProfit);
    case "lastServed":
      return row.lastServedAt;
  }
}

export function NegativesPage() {
  const search = useSearch({ strict: false }) as {
    days?: number | "mtd";
    books?: string[];
    country?: string;
    kind?: NegativeKind;
  };
  const country = search.country;
  const kindFilter = search.kind;
  const days = resolveTimeframe(search.days);
  const navigate = useNavigate();
  const profiles = useProfiles();
  const books = useBooks();
  const negatives = useNegatives(days, search.books, country, kindFilter);
  const exclusions = useSearchTermExclusions();
  const marketplaces = useSpendSortedMarketplaces(days, search.books);
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "stillServing",
    direction: "desc",
  });
  const [query, setQuery] = useState("");
  const [insight, setInsight] = useState<InsightFilter>("all");

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  function setCountryFilter(next: string) {
    void navigate({
      to: "/negatives",
      search: (prev) => ({
        ...prev,
        country: next === "" ? undefined : next,
      }),
      replace: true,
    });
  }

  function setKindFilter(next: NegativeKind | undefined) {
    void navigate({
      to: "/negatives",
      search: (prev) => ({ ...prev, kind: next }),
      replace: true,
    });
  }

  const trimmedQuery = query.trim().toLowerCase();
  const rows = negatives.data ?? [];
  const leakingCount = rows.filter(
    (row) => row.stillServingCampaignCount > 0,
  ).length;
  const soldCount = rows.filter((row) => row.before.orders > 0).length;
  const catalogCount = rows.filter((row) => row.catalogBookId !== null).length;

  const filteredRows = rows.filter((row) => {
    if (kindFilter && row.kind !== kindFilter) return false;
    if (insight === "leaking" && row.stillServingCampaignCount === 0) {
      return false;
    }
    if (insight === "sold" && row.before.orders === 0) return false;
    if (insight === "catalog" && row.catalogBookId === null) return false;
    return (
      trimmedQuery === "" || row.value.toLowerCase().includes(trimmedQuery)
    );
  });
  const sortedRows = [...filteredRows].sort((a, b) => {
    const primary = compareNullable(
      sortValue(a, sort.key),
      sortValue(b, sort.key),
      sort.direction,
    );
    if (primary !== 0) return primary;
    return b.blockingCampaignCount - a.blockingCampaignCount;
  });

  const excludedTerms = new Set(
    (exclusions.data?.exclusions ?? []).map((entry) => entry.term),
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          Negatives
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TimeframeSelect
            value={days}
            onChange={(window) =>
              navigate({
                to: "/negatives",
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
            aria-label="Filter negatives"
            placeholder="Filter negatives…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-48"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Negative type" className="flex gap-1">
          {(
            [
              [undefined, "All"],
              ["keyword", "Keywords"],
              ["product", "Products"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={label}
              size="sm"
              variant={kindFilter === value ? "primary" : "secondary"}
              aria-pressed={kindFilter === value}
              onClick={() => setKindFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {negatives.data ? (
          <div
            role="group"
            aria-label="Insight filters"
            className="flex flex-wrap gap-1"
          >
            <InsightChip
              label={`${formatCount(rows.length)} unique`}
              active={insight === "all"}
              onClick={() => setInsight("all")}
            />
            <InsightChip
              label={`${formatCount(leakingCount)} still serving`}
              active={insight === "leaking"}
              tone={leakingCount > 0 ? "warning" : undefined}
              onClick={() => setInsight("leaking")}
            />
            <InsightChip
              label={`${formatCount(soldCount)} used to sell`}
              active={insight === "sold"}
              onClick={() => setInsight("sold")}
            />
            <InsightChip
              label={`${formatCount(catalogCount)} your catalog`}
              active={insight === "catalog"}
              onClick={() => setInsight("catalog")}
            />
          </div>
        ) : null}
      </div>

      <Card>
        {negatives.isPending ? (
          <Loading />
        ) : negatives.error ? (
          <ErrorState error={negatives.error} />
        ) : sortedRows.length === 0 ? (
          <EmptyState>
            {trimmedQuery !== ""
              ? `No negatives match “${query.trim()}”.`
              : insight !== "all"
                ? "No negatives match this insight filter."
                : kindFilter
                  ? `No ${kindFilter === "keyword" ? "keyword" : "product"} negatives in this view.`
                  : country
                    ? `No negatives in ${countryNameForCode(country)}.`
                    : search.books && search.books.length > 0
                      ? "No negatives for the selected products."
                      : "No negatives synced yet. Connect Amazon Ads and run a structure sync first."}
          </EmptyState>
        ) : (
          <Table stickyHeader>
            <thead>
              <tr>
                <Th aria-sort={columnAriaSort(sort, ["value", "profit"])}>
                  <div className="flex flex-col items-start gap-1">
                    <SortButton
                      label="Term / ASIN"
                      column="value"
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
                  label="Blocking"
                  column="blocking"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Still serving"
                  column="stillServing"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortableTh
                  label="Sold before"
                  column="soldBefore"
                  sort={sort}
                  onSort={onSort}
                />
                <SortableTh
                  label={`${windowQualifier(days)} profit`}
                  column="profit"
                  sort={sort}
                  onSort={onSort}
                  className="hidden md:table-cell"
                />
                <SortableTh
                  label="Last served"
                  column="lastServed"
                  sort={sort}
                  onSort={onSort}
                />
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const defaultCountry =
                  country ??
                  (row.countryCodes.includes("US")
                    ? "US"
                    : row.countryCodes[0]);
                const hasActivity = hasCampaignActivity(row.window);
                const profitStatus = getCampaignProfitStatus(
                  row.window,
                  row.window.economicsMissing,
                  row.window.estimatedAdProfit,
                );
                const excluded = excludedTerms.has(
                  row.value.trim().toLowerCase(),
                );
                return (
                  <tr key={`${row.kind}:${row.value}`}>
                    <Td className="max-w-xs">
                      <div className="flex items-start gap-2">
                        <BookCoverStack
                          bookIds={
                            row.catalogBookId
                              ? [row.catalogBookId, ...row.bookIds]
                              : row.bookIds
                          }
                          books={books.data}
                        />
                        <div className="min-w-0">
                          <Link
                            to="/negatives/$kind/$value"
                            params={{ kind: row.kind, value: row.value }}
                            search={{
                              days,
                              ...(defaultCountry
                                ? { country: defaultCountry }
                                : {}),
                            }}
                            className="break-words text-sky-400 hover:underline"
                          >
                            {row.value}
                          </Link>
                          <AmazonProductLink
                            term={row.value}
                            countryCode={defaultCountry}
                            className="ml-2 whitespace-nowrap text-xs"
                          />
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge tone="neutral">
                              {row.kind === "product"
                                ? "Product"
                                : row.matchTypes
                                    .map((match) => formatAmazonLabel(match))
                                    .join(" · ") || "Keyword"}
                            </Badge>
                            {row.excludedEverywhere || excluded ? (
                              <Badge tone="info">Everywhere</Badge>
                            ) : null}
                            {row.catalogBookId ? (
                              <Badge tone="success">Your catalog</Badge>
                            ) : null}
                          </div>
                          <div className="mt-2 md:hidden">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                              {windowQualifier(days)} profit
                            </p>
                            <ProfitabilityResult
                              status={profitStatus}
                              amount={row.window.estimatedAdProfit}
                              currency={row.currency}
                              economicsMissing={row.window.economicsMissing}
                              hasActivity={hasActivity}
                            />
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td
                      className="whitespace-nowrap text-xs text-zinc-500"
                      title={row.countryCodes
                        .map((code) => countryNameForCode(code))
                        .join(", ")}
                    >
                      {row.countryCodes.map((code) => (
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
                      {formatCount(row.blockingCampaignCount)}
                    </Td>
                    <Td className="text-right">
                      {row.stillServingCampaignCount > 0 ? (
                        <Badge tone="warning">
                          {formatCount(row.stillServingCampaignCount)}
                        </Badge>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </Td>
                    <Td
                      className="whitespace-nowrap"
                      title="Before we first synced this negative. Amazon does not expose when it was created."
                    >
                      {row.before.orders > 0 || Number(row.before.cost) > 0 ? (
                        <div>
                          <div>{formatCount(row.before.orders)} orders</div>
                          <div className="text-xs text-zinc-500">
                            {formatMoney(row.before.cost, row.currency)}
                            {row.before.acos !== null
                              ? ` · ${formatAcos(row.before.acos)} ACoS`
                              : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </Td>
                    <Td
                      className="hidden whitespace-nowrap md:table-cell"
                      aria-label={`${row.value} ${windowQualifier(days)} profit: ${profitStatus.label}`}
                    >
                      <ProfitabilityResult
                        status={profitStatus}
                        amount={row.window.estimatedAdProfit}
                        currency={row.currency}
                        economicsMissing={row.window.economicsMissing}
                        hasActivity={hasActivity}
                      />
                    </Td>
                    <Td className="whitespace-nowrap text-zinc-400">
                      {formatDate(row.lastServedAt)}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      {row.kind === "keyword" ? (
                        <ExcludeSearchTermGlobal
                          term={row.value}
                          excluded={excluded || row.excludedEverywhere}
                        />
                      ) : null}
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

function InsightChip({
  label,
  active,
  tone,
  onClick,
}: {
  label: string;
  active: boolean;
  tone?: "warning";
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "primary" : "ghost"}
      aria-pressed={active}
      className={
        !active && tone === "warning"
          ? "text-amber-300 hover:text-amber-200"
          : ""
      }
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
