import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  MetricTotals,
  MetricWindow,
  NegativeKeywordRow,
} from "@amazon-king/contracts";
import { useCampaign, useProfiles } from "../api/endpoints";
import { KpiCard } from "../components/kpi-card";
import { CampaignControls } from "../components/campaign-controls";
import { CampaignHeader } from "../components/campaign-header";
import { CampaignMaxCpc } from "../components/campaign-max-cpc";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { ProfitabilityResult } from "../components/profitability-result";
import { Badge } from "../components/ui/badge";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { SortableTh } from "../components/ui/sortable-th";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatMoney,
  ORDERS_COLUMN_TITLE,
  ordersUnitsHint,
} from "../lib/format";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";
import { resolveTimeframe } from "../lib/timeframe";

type Tab =
  "adGroups" | "targets" | "searchTerms" | "negativeKeywords" | "maxCpc";

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "adGroups", label: "Ad groups" },
  { key: "targets", label: "Targets" },
  { key: "searchTerms", label: "Search terms" },
  { key: "negativeKeywords", label: "Negative keywords" },
  { key: "maxCpc", label: "Max CPC" },
];

interface Row {
  id: string;
  name: string;
  state: string;
  totals: MetricTotals;
  /** Present on search-term rows only. */
  estimatedAdProfit?: string | null;
  economicsMissing?: boolean;
}

const TEXT_COLUMNS = ["name", "state"] as const;

type SortKey =
  | "name"
  | "state"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "units"
  | "acos"
  | "profit";

/** Display-only sort keys; money strings are converted to Number for ordering. */
function sortValue(row: Row, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "state":
      return row.state;
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
      return Number(row.totals.sales) > 0
        ? Number(row.totals.cost) / Number(row.totals.sales)
        : null;
    case "profit":
      return row.estimatedAdProfit == null
        ? null
        : Number(row.estimatedAdProfit);
  }
}

function formatAmazonLabel(value: string) {
  const words = value
    .replace(/^negative_/i, "")
    .toLowerCase()
    .split("_");
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function NegativeKeywordsTable({ rows }: { rows: NegativeKeywordRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        No negative keywords are synced for this campaign.
      </EmptyState>
    );
  }
  return (
    <Table stickyHeader>
      <thead>
        <tr>
          <Th>Negative keyword</Th>
          <Th>Match type</Th>
          <Th>Applied to</Th>
          <Th>State</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const state = row.state.toLowerCase();
          return (
            <tr key={row.id}>
              <Td className="font-medium text-zinc-100">{row.keywordText}</Td>
              <Td>{formatAmazonLabel(row.matchType)}</Td>
              <Td>
                {row.level === "campaign"
                  ? "Campaign"
                  : `Ad group · ${row.adGroupName ?? row.adGroupId ?? "Unknown"}`}
              </Td>
              <Td>
                <Badge tone={state === "enabled" ? "success" : "neutral"}>
                  {formatAmazonLabel(state)}
                </Badge>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function MetricsTable({
  rows,
  currency,
  termLink,
  showProfit = false,
}: {
  rows: Row[];
  currency: string;
  termLink?: { days: MetricWindow; country?: string };
  showProfit?: boolean;
}) {
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  if (rows.length === 0) {
    return <EmptyState>Nothing here yet for this campaign.</EmptyState>;
  }

  const sortedRows = [...rows].sort((a, b) =>
    compareNullable(
      sortValue(a, sort.key),
      sortValue(b, sort.key),
      sort.direction,
    ),
  );

  return (
    <Table stickyHeader>
      <thead>
        <tr>
          <SortableTh label="Name" column="name" sort={sort} onSort={onSort} />
          <SortableTh
            label="State"
            column="state"
            sort={sort}
            onSort={onSort}
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
          {showProfit ? (
            <SortableTh
              label="Profit"
              column="profit"
              sort={sort}
              onSort={onSort}
            />
          ) : null}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((r) => {
          const acos =
            Number(r.totals.sales) > 0
              ? Number(r.totals.cost) / Number(r.totals.sales)
              : null;
          return (
            <tr key={r.id}>
              <Td className="max-w-xs truncate">
                {termLink ? (
                  <Link
                    to="/search-terms/$term"
                    params={{ term: r.name }}
                    search={{
                      days: termLink.days,
                      ...(termLink.country
                        ? { country: termLink.country }
                        : {}),
                    }}
                    className="text-sky-400 hover:underline"
                  >
                    {r.name}
                  </Link>
                ) : (
                  r.name
                )}
              </Td>
              <Td>
                <Badge tone={r.state === "enabled" ? "success" : "neutral"}>
                  {r.state}
                </Badge>
              </Td>
              <Td className="text-right">
                {formatCount(r.totals.impressions)}
              </Td>
              <Td className="text-right">{formatCount(r.totals.clicks)}</Td>
              <Td className="text-right">
                {formatMoney(r.totals.cost, currency)}
              </Td>
              <Td className="text-right">
                {formatMoney(r.totals.sales, currency)}
              </Td>
              <Td className="text-right">{formatCount(r.totals.orders)}</Td>
              <Td className="text-right">{formatCount(r.totals.units)}</Td>
              <Td className="text-right">{formatAcos(acos)}</Td>
              {showProfit ? (
                <Td>
                  <ProfitabilityResult
                    status={getCampaignProfitStatus(
                      r.totals,
                      r.economicsMissing ?? false,
                      r.estimatedAdProfit ?? null,
                    )}
                    amount={r.estimatedAdProfit ?? null}
                    currency={currency}
                    economicsMissing={r.economicsMissing ?? false}
                    hasActivity={hasCampaignActivity(r.totals)}
                  />
                </Td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as {
    days?: number | "mtd";
    books?: string[];
  };
  const days = resolveTimeframe(search.days);
  const navigate = useNavigate();
  const campaign = useCampaign(id, days, search.books);
  const profiles = useProfiles();
  const [tab, setTab] = useState<Tab>("adGroups");

  if (campaign.isPending) return <Loading />;
  if (campaign.error) return <ErrorState error={campaign.error} />;
  if (!campaign.data) return null;

  const c = campaign.data.campaign;
  const currency = campaign.data.currency;
  const country = (profiles.data ?? []).find(
    (profile) => profile.profileId === c.profileId,
  )?.countryCode;
  const hasActivity = hasCampaignActivity(c.totals);
  const editable = c.state !== "archived";
  const profitStatus = getCampaignProfitStatus(
    c.totals,
    campaign.data.economicsMissing,
    c.totals.estimatedAdProfit,
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-sm">
        <Link to="/campaigns" className="text-sky-400 hover:underline">
          ← Campaigns
        </Link>
      </p>
      <CampaignHeader
        name={c.name}
        state={c.state}
        countryCode={country}
        currency={currency}
        profileId={c.profileId}
        amazonConsoleUrl={c.amazonConsoleUrl}
        profitStatus={profitStatus}
        estimatedAdProfit={c.totals.estimatedAdProfit}
        hasActivity={hasActivity}
        dateRange={campaign.data.dateRange}
        dataCurrentThrough={campaign.data.dataCurrentThrough}
        days={days}
        onDaysChange={(window) =>
          navigate({
            to: "/campaigns/$id",
            params: { id },
            search: (prev) => ({ ...prev, days: window }),
            replace: true,
          })
        }
        controls={
          editable ? (
            <CampaignControls campaignId={id} name={c.name} state={c.state} />
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Spend" value={formatMoney(c.totals.cost, currency)} />
        <KpiCard label="Sales" value={formatMoney(c.totals.sales, currency)} />
        <KpiCard
          label="Orders"
          value={formatCount(c.totals.orders)}
          suffix={ordersUnitsHint(c.totals.orders, c.totals.units)}
          suffixTitle={ORDERS_COLUMN_TITLE}
        />
        <KpiCard label="ACoS" value={formatAcos(c.totals.acos)} />
        <KpiCard
          label="Est. royalty"
          value={formatMoney(c.totals.estimatedRoyalty, currency)}
          missing={campaign.data.economicsMissing}
        />
        <KpiCard
          label="Est. ad profit"
          value={formatMoney(c.totals.estimatedAdProfit, currency)}
          missing={campaign.data.economicsMissing}
        />
      </div>

      {campaign.data.economicsMissing ? (
        <p className="text-xs text-amber-300">
          Profit is hidden because one or more advertised books do not have KDP
          royalty economics for this period. Under Settings → Book economics,
          set Effective from to {formatDate(campaign.data.dateRange.start)} or
          earlier if those economics applied then.
        </p>
      ) : null}

      <Card>
        <CardHeader title="Campaign performance & estimated profit" />
        <CardBody>
          <PerformanceTrendChart
            daily={campaign.data.daily}
            currency={currency}
            showProfit
          />
        </CardBody>
      </Card>

      <Card>
        <div
          role="tablist"
          aria-label="Campaign breakdown"
          className="flex overflow-x-auto border-b border-zinc-800"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm ${
                tab === t.key
                  ? "border-b-2 border-sky-500 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CardBody className="p-0">
          <div role="tabpanel">
            {tab === "maxCpc" ? (
              <CampaignMaxCpc campaignId={id} />
            ) : tab === "negativeKeywords" ? (
              <NegativeKeywordsTable rows={campaign.data.negativeKeywords} />
            ) : (
              <MetricsTable
                key={tab}
                rows={campaign.data[tab]}
                currency={currency}
                termLink={tab === "searchTerms" ? { days, country } : undefined}
                showProfit={tab === "searchTerms"}
              />
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
