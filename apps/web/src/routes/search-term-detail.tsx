import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { SearchTermCampaignRow } from "@amazon-king/contracts";
import { useProfiles, useSearchTerm } from "../api/endpoints";
import { KpiCard } from "../components/kpi-card";
import { AmazonProductLink } from "../components/amazon-product-link";
import { ProfitabilityResult } from "../components/profitability-result";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { MetricFunnel } from "../components/metric-funnel";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { SortableTh } from "../components/ui/sortable-th";
import { Table, Td } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatMoney,
} from "../lib/format";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";
import { countryNameForCode, marketplaceOptions } from "../lib/marketplaces";

const DAY_OPTIONS = [7, 14, 30, 60] as const;
const DEFAULT_DAYS = 7;

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
function sortValue(
  row: SearchTermCampaignRow,
  key: SortKey,
): number | string | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "profile":
      return row.profileId;
    case "state":
      return row.state;
    case "profit":
      return row.estimatedAdProfit === null
        ? null
        : Number(row.estimatedAdProfit);
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

export function SearchTermDetailPage() {
  const { term } = useParams({ strict: false }) as { term: string };
  const search = useSearch({ strict: false }) as {
    days?: number;
    book?: string;
    country?: string;
  };
  const days = DAY_OPTIONS.includes(search.days as 7)
    ? Number(search.days)
    : DEFAULT_DAYS;
  const book = search.book;
  const navigate = useNavigate();
  const detail = useSearchTerm(term, days, book, search.country);
  const profiles = useProfiles();
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} />;
  if (!detail.data) return null;

  const data = detail.data;
  const currency = data.currency;
  const hasActivity = hasCampaignActivity(data.totals);
  const profitStatus = getCampaignProfitStatus(
    data.totals,
    data.economicsMissing,
    data.totals.estimatedAdProfit,
  );
  const sortedCampaigns = [...data.campaigns].sort((a, b) =>
    compareNullable(
      sortValue(a, sort.key),
      sortValue(b, sort.key),
      sort.direction,
    ),
  );
  // Markets the term can be copied to: every enabled market except the one
  // currently viewed. Picking one opens the campaign wizard prefilled with
  // this term — as an exact keyword, or as a product target when the term is
  // an ASIN (the wizard's prefill decides).
  const copyTargets = marketplaceOptions(profiles.data ?? []).filter(
    (option) => option.countryCode !== data.countryCode,
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-sm">
        <Link
          to="/search-terms"
          search={book ? { book } : {}}
          className="text-sky-400 hover:underline"
        >
          ← Search terms
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-xl font-bold tracking-tight text-zinc-100">
          {data.searchTerm}
        </h1>
        <span className="text-xs text-zinc-500">{currency}</span>
        <AmazonProductLink
          term={data.searchTerm}
          countryCode={data.countryCode}
          className="text-xs"
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Market</span>
            <Select
              aria-label="Market"
              value={data.countryCode}
              onChange={(event) =>
                void navigate({
                  to: "/search-terms/$term",
                  params: { term },
                  search: {
                    days,
                    country: event.currentTarget.value,
                    ...(book ? { book } : {}),
                  },
                  replace: true,
                })
              }
            >
              {data.availableCountryCodes.map((countryCode) => (
                <option key={countryCode} value={countryCode}>
                  {countryNameForCode(countryCode)} ({countryCode})
                </option>
              ))}
            </Select>
          </label>
          {copyTargets.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <span>Copy to market</span>
              <Select
                aria-label="Copy to market"
                value=""
                onChange={(event) => {
                  const country = event.currentTarget.value;
                  if (country === "") return;
                  void navigate({
                    to: "/campaigns/new",
                    search: { searchTerm: data.searchTerm, country },
                  });
                }}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {copyTargets.map((option) => (
                  <option key={option.countryCode} value={option.countryCode}>
                    {option.countryName} ({option.countryCode})
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-400">Date range</span>
            <div role="group" aria-label="Date range" className="flex gap-1">
              {DAY_OPTIONS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === days ? "primary" : "secondary"}
                  onClick={() =>
                    navigate({
                      to: "/search-terms/$term",
                      params: { term },
                      search: {
                        days: option,
                        country: data.countryCode,
                        ...(book ? { book } : {}),
                      },
                      replace: true,
                    })
                  }
                >
                  {option}d
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <Badge tone={profitStatus.tone}>{profitStatus.label}</Badge>
        <span>
          {hasActivity && data.totals.estimatedAdProfit !== null
            ? `${formatMoney(data.totals.estimatedAdProfit, currency)} estimated ad profit`
            : `Selected ${days}-day window`}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {formatDate(data.dateRange.start)} – {formatDate(data.dateRange.end)}
        </span>
        <span aria-hidden="true">·</span>
        <span>Data current through {formatDate(data.dataCurrentThrough)}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Spend"
          value={formatMoney(data.totals.cost, currency)}
        />
        <KpiCard
          label="Sales"
          value={formatMoney(data.totals.sales, currency)}
        />
        <KpiCard label="Orders" value={formatCount(data.totals.orders)} />
        <KpiCard label="ACoS" value={formatAcos(data.totals.acos)} />
        <KpiCard
          label="Est. royalty"
          value={formatMoney(data.totals.estimatedRoyalty, currency)}
          missing={data.economicsMissing}
        />
        <KpiCard
          label="Est. ad profit"
          value={formatMoney(data.totals.estimatedAdProfit, currency)}
          missing={data.economicsMissing}
        />
      </div>

      {data.economicsMissing ? (
        <p className="text-xs text-amber-300">
          Profit is hidden because one or more advertised books do not have KDP
          royalty economics for this period. Under Settings → Book economics,
          set Effective from to {formatDate(data.dateRange.start)} or earlier if
          those economics applied then.
        </p>
      ) : null}

      <Card>
        <CardHeader title="Daily performance" />
        <CardBody>
          <PerformanceTrendChart
            daily={data.daily}
            currency={currency}
            visible={["spend", "sales", "royalty", "acos"]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`${days}-day conversion funnel`} />
        <CardBody>
          <MetricFunnel
            stages={[
              { label: "Impressions", value: data.totals.impressions },
              { label: "Clicks", value: data.totals.clicks, rateLabel: "CTR" },
              { label: "Orders", value: data.totals.orders, rateLabel: "CVR" },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        {data.campaigns.length === 0 ? (
          <EmptyState>No campaigns advertised this search term.</EmptyState>
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
                  label={`${days}-day profit`}
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
              {sortedCampaigns.map((c) => {
                const campaignActivity = hasCampaignActivity(c.totals);
                const campaignProfitStatus = getCampaignProfitStatus(
                  c.totals,
                  c.economicsMissing,
                  c.estimatedAdProfit,
                );
                // ACoS is a ratio derived for display only; money itself is
                // never aggregated in the browser.
                const acos =
                  Number(c.totals.sales) > 0
                    ? Number(c.totals.cost) / Number(c.totals.sales)
                    : null;
                return (
                  <tr key={`${c.profileId}-${c.campaignId}`}>
                    <Td>
                      <Link
                        to="/campaigns/$id"
                        params={{ id: c.campaignId }}
                        search={{ days }}
                        className="text-sky-400 hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="mt-2 md:hidden">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                          {days}-day profit
                        </p>
                        <ProfitabilityResult
                          status={campaignProfitStatus}
                          amount={c.estimatedAdProfit}
                          currency={currency}
                          economicsMissing={c.economicsMissing}
                          hasActivity={campaignActivity}
                        />
                      </div>
                    </Td>
                    <Td className="font-mono text-xs text-zinc-500">
                      {c.profileId}
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
                      aria-label={`${c.name} ${days}-day profit: ${campaignProfitStatus.label}`}
                    >
                      <ProfitabilityResult
                        status={campaignProfitStatus}
                        amount={c.estimatedAdProfit}
                        currency={currency}
                        economicsMissing={c.economicsMissing}
                        hasActivity={campaignActivity}
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
