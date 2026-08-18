import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import type { CampaignListRow } from "@amazon-king/contracts";
import { useBooks, useCampaigns, useProfiles } from "../api/endpoints";
import { BookCoverStack } from "../components/book-covers";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { SortableTh } from "../components/ui/sortable-th";
import { Table, Td } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { CountrySelect } from "../components/country-select";
import { ProfitabilityResult } from "../components/profitability-result";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import { formatAcos, formatCount, formatMoney } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";

const PROFITABILITY_DAYS = 7;

const TEXT_COLUMNS = ["name", "profile", "state"] as const;

type SortKey =
  | "name"
  | "profile"
  | "state"
  | "profit"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "acos";

/** Display-only sort keys; money strings are converted to Number for ordering. */
function sortValue(row: CampaignListRow, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "profile":
      return row.profileId;
    case "state":
      return row.state;
    case "profit":
      return row.profitability.estimatedAdProfit === null
        ? null
        : Number(row.profitability.estimatedAdProfit);
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
      return Number(row.totals.sales) > 0
        ? Number(row.totals.cost) / Number(row.totals.sales)
        : null;
  }
}

export function CampaignsPage() {
  const search = useSearch({ strict: false }) as { books?: string[] };
  const campaigns = useCampaigns(PROFITABILITY_DAYS, search.books);
  const profiles = useProfiles();
  const books = useBooks();
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");

  const countryByProfile = new Map(
    (profiles.data ?? []).map((p) => [p.profileId, p.countryCode]),
  );
  const marketplaces = useSpendSortedMarketplaces(PROFITABILITY_DAYS);
  const marketProfileIds = new Set(
    country === ""
      ? []
      : (marketplaces.find((m) => m.countryCode === country)?.profileIds ?? []),
  );

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  const trimmedQuery = query.trim().toLowerCase();
  const filteredRows = (campaigns.data ?? []).filter(
    (row) =>
      (trimmedQuery === "" || row.name.toLowerCase().includes(trimmedQuery)) &&
      (country === "" || marketProfileIds.has(row.profileId)),
  );
  const sortedRows = campaigns.data
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
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          Campaigns
        </h1>
        <div className="flex items-center gap-2">
          <CountrySelect
            value={country}
            options={marketplaces}
            allLabel="All markets"
            aria-label="Filter by market"
            disabled={profiles.isPending}
            onChange={setCountry}
          />
          <Input
            type="search"
            aria-label="Filter campaigns"
            placeholder="Filter campaigns…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-48"
          />
          <Link
            to="/campaigns/new"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.25),0_4px_14px_rgba(109,59,215,0.35)] transition-all hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:scale-[0.98]"
          >
            + New campaign
          </Link>
        </div>
      </div>
      <Card>
        {campaigns.isPending ? (
          <Loading />
        ) : campaigns.error ? (
          <ErrorState error={campaigns.error} />
        ) : sortedRows.length === 0 ? (
          <EmptyState>
            {trimmedQuery !== ""
              ? `No campaigns match “${query.trim()}”.`
              : country !== ""
                ? `No campaigns in ${countryNameForCode(country)}.`
                : "No campaigns imported yet. Connect Amazon Ads and run a sync first."}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  label="Campaign"
                  column="name"
                  sort={sort}
                  onSort={onSort}
                />
                <SortableTh
                  label="Profile"
                  column="profile"
                  sort={sort}
                  onSort={onSort}
                />
                <SortableTh
                  label="State"
                  column="state"
                  sort={sort}
                  onSort={onSort}
                />
                <SortableTh
                  label={`${PROFITABILITY_DAYS}-day profit`}
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
              {sortedRows.map((c) => {
                const currency = c.profitability.currency;
                const countryCode = countryByProfile.get(c.profileId);
                const hasActivity = hasCampaignActivity(c.totals);
                const profitStatus = getCampaignProfitStatus(
                  c.totals,
                  c.profitability.economicsMissing,
                  c.profitability.estimatedAdProfit,
                );
                // ACoS is a ratio derived for display only; money itself is
                // never aggregated in the browser.
                const acos =
                  Number(c.totals.sales) > 0
                    ? Number(c.totals.cost) / Number(c.totals.sales)
                    : null;
                return (
                  <tr key={c.campaignId}>
                    <Td>
                      <div className="flex items-start gap-2">
                        <BookCoverStack
                          bookIds={c.bookIds}
                          books={books.data}
                        />
                        <div className="min-w-0">
                          <Link
                            to="/campaigns/$id"
                            params={{ id: c.campaignId }}
                            search={{ days: PROFITABILITY_DAYS }}
                            className="text-sky-400 hover:underline"
                          >
                            {c.name}
                          </Link>
                          <div className="mt-2 md:hidden">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                              {PROFITABILITY_DAYS}-day profit
                            </p>
                            <ProfitabilityResult
                              status={profitStatus}
                              amount={c.profitability.estimatedAdProfit}
                              currency={currency}
                              economicsMissing={
                                c.profitability.economicsMissing
                              }
                              hasActivity={hasActivity}
                            />
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-xs text-zinc-500">
                      {countryCode ? (
                        <span
                          className="whitespace-nowrap"
                          title={`${countryNameForCode(countryCode)} · profile ${c.profileId}`}
                        >
                          <Flag countryCode={countryCode} className="mr-1" />
                          {countryCode}
                        </span>
                      ) : (
                        <span className="font-mono">{c.profileId}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge
                        tone={c.state === "enabled" ? "success" : "neutral"}
                      >
                        {c.state}
                      </Badge>
                    </Td>
                    <Td
                      className="hidden whitespace-nowrap md:table-cell"
                      aria-label={`${c.name} seven-day profit: ${profitStatus.label}`}
                    >
                      <ProfitabilityResult
                        status={profitStatus}
                        amount={c.profitability.estimatedAdProfit}
                        currency={currency}
                        economicsMissing={c.profitability.economicsMissing}
                        hasActivity={hasActivity}
                      />
                    </Td>
                    <Td className="text-right">
                      {formatCount(c.totals.impressions)}
                    </Td>
                    <Td className="text-right">
                      {formatCount(c.totals.clicks)}
                    </Td>
                    <Td className="text-right">
                      {formatMoney(c.totals.cost, currency)}
                    </Td>
                    <Td className="text-right">
                      {formatMoney(c.totals.sales, currency)}
                    </Td>
                    <Td className="text-right">
                      {formatCount(c.totals.orders)}
                    </Td>
                    <Td className="text-right">{formatAcos(acos)}</Td>
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
