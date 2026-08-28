import { useState, type ReactNode } from "react";
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
  NegativeTargetRow,
  TargetRow,
} from "@amazon-king/contracts";
import { useCampaign, useProfiles } from "../api/endpoints";
import { AmazonProductLink } from "../components/amazon-product-link";
import { CampaignControls } from "../components/campaign-controls";
import { ExcludeSearchTerm } from "../components/exclude-search-term";
import { KpiCard } from "../components/kpi-card";
import { CampaignHeader } from "../components/campaign-header";
import { CampaignMaxCpc } from "../components/campaign-max-cpc";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { ProfitabilityResult } from "../components/profitability-result";
import { ReincludeNegative } from "../components/reinclude-negative";
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
import { isAsin } from "../lib/asin";

type Tab =
  | "adGroups"
  | "targets"
  | "searchTerms"
  | "negativeKeywords"
  | "negativeTargets"
  | "maxCpc";

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "adGroups", label: "Ad groups" },
  { key: "targets", label: "Targets" },
  { key: "searchTerms", label: "Search terms" },
  { key: "negativeKeywords", label: "Negative keywords" },
  { key: "negativeTargets", label: "Negative products" },
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

function appliedToLabel(row: {
  level: "campaign" | "ad_group";
  adGroupName: string | null;
  adGroupId: string | null;
}): string {
  return row.level === "campaign"
    ? "Campaign"
    : `Ad group · ${row.adGroupName ?? row.adGroupId ?? "Unknown"}`;
}

const NEGATIVE_KEYWORD_TEXT_COLUMNS = [
  "keywordText",
  "matchType",
  "appliedTo",
  "state",
] as const;

type NegativeKeywordSortKey =
  "keywordText" | "matchType" | "appliedTo" | "firstSeenAt" | "state";

function negativeKeywordSortValue(
  row: NegativeKeywordRow,
  key: NegativeKeywordSortKey,
): number | string | null {
  switch (key) {
    case "keywordText":
      return row.keywordText.toLowerCase();
    case "matchType":
      return formatAmazonLabel(row.matchType).toLowerCase();
    case "appliedTo":
      return appliedToLabel(row).toLowerCase();
    case "firstSeenAt": {
      const timestamp = Date.parse(row.firstSeenAt);
      return Number.isNaN(timestamp) ? null : timestamp;
    }
    case "state":
      return formatAmazonLabel(row.state).toLowerCase();
  }
}

function NegativeKeywordsTable({
  rows,
  campaignId,
  editable,
}: {
  rows: NegativeKeywordRow[];
  campaignId: string;
  editable: boolean;
}) {
  const [sort, setSort] = useState<Sort<NegativeKeywordSortKey>>({
    key: "keywordText",
    direction: "asc",
  });

  function onSort(column: NegativeKeywordSortKey) {
    setSort((current) =>
      nextSort(current, column, NEGATIVE_KEYWORD_TEXT_COLUMNS),
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState>
        No negative keywords are synced for this campaign.
      </EmptyState>
    );
  }

  const sortedRows = [...rows].sort((a, b) =>
    compareNullable(
      negativeKeywordSortValue(a, sort.key),
      negativeKeywordSortValue(b, sort.key),
      sort.direction,
    ),
  );

  return (
    <Table stickyHeader>
      <thead>
        <tr>
          <SortableTh
            label="Negative keyword"
            column="keywordText"
            sort={sort}
            onSort={onSort}
          />
          <SortableTh
            label="Match type"
            column="matchType"
            sort={sort}
            onSort={onSort}
          />
          <SortableTh
            label="Applied to"
            column="appliedTo"
            sort={sort}
            onSort={onSort}
          />
          <SortableTh
            label="Added"
            column="firstSeenAt"
            sort={sort}
            onSort={onSort}
          />
          <SortableTh
            label="State"
            column="state"
            sort={sort}
            onSort={onSort}
          />
          {editable ? <Th /> : null}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => {
          const state = row.state.toLowerCase();
          return (
            <tr key={row.id}>
              <Td className="font-medium text-zinc-100">{row.keywordText}</Td>
              <Td>{formatAmazonLabel(row.matchType)}</Td>
              <Td>{appliedToLabel(row)}</Td>
              <Td>{formatDate(row.firstSeenAt)}</Td>
              <Td>
                <Badge tone={state === "enabled" ? "success" : "neutral"}>
                  {formatAmazonLabel(state)}
                </Badge>
              </Td>
              {editable ? (
                <Td className="text-right">
                  <ReincludeNegative
                    campaignId={campaignId}
                    kind="keyword"
                    negativeId={row.id}
                    label={row.keywordText}
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

function NegativeProductsTable({
  rows,
  countryCode,
  campaignId,
  editable,
}: {
  rows: NegativeTargetRow[];
  countryCode?: string;
  campaignId: string;
  editable: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        No negative product targets are synced for this campaign.
      </EmptyState>
    );
  }
  return (
    <Table stickyHeader>
      <thead>
        <tr>
          <Th>ASIN</Th>
          <Th>Type</Th>
          <Th>Applied to</Th>
          <Th>Added</Th>
          <Th>State</Th>
          {editable ? <Th /> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const state = row.state.toLowerCase();
          return (
            <tr key={row.id}>
              <Td>
                <span className="font-medium text-zinc-100">{row.asin}</span>
                <AmazonProductLink
                  term={row.asin}
                  countryCode={countryCode}
                  className="ml-2 text-xs"
                />
              </Td>
              <Td>ASIN same as</Td>
              <Td>{appliedToLabel(row)}</Td>
              <Td>{formatDate(row.firstSeenAt)}</Td>
              <Td>
                <Badge tone={state === "enabled" ? "success" : "neutral"}>
                  {formatAmazonLabel(state)}
                </Badge>
              </Td>
              {editable ? (
                <Td className="text-right">
                  <ReincludeNegative
                    campaignId={campaignId}
                    kind="target"
                    negativeId={row.id}
                    label={row.asin}
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

const TARGET_TEXT_COLUMNS = ["name", "type", "state"] as const;

type TargetSortKey =
  | "name"
  | "type"
  | "bid"
  | "state"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "units"
  | "acos";

/** Type badge for a target row; keyword rows carry their match type. */
function targetTypeLabel(row: TargetRow): string {
  if (row.kind === "keyword") {
    return row.matchType
      ? `Keyword · ${formatAmazonLabel(row.matchType)}`
      : "Keyword";
  }
  return row.asin === null ? "Auto" : "Product";
}

function targetSortValue(
  row: TargetRow,
  key: TargetSortKey,
): number | string | null {
  switch (key) {
    case "name":
      return (row.bookTitle ?? row.name).toLowerCase();
    case "type":
      return targetTypeLabel(row).toLowerCase();
    case "bid":
      return row.bid === null ? null : Number(row.bid);
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
  }
}

function TargetsTable({
  rows,
  currency,
  countryCode,
}: {
  rows: TargetRow[];
  currency: string;
  countryCode?: string;
}) {
  const [sort, setSort] = useState<Sort<TargetSortKey>>({
    key: "cost",
    direction: "desc",
  });

  function onSort(column: TargetSortKey) {
    setSort((current) => nextSort(current, column, TARGET_TEXT_COLUMNS));
  }

  if (rows.length === 0) {
    return <EmptyState>No targets are synced for this campaign.</EmptyState>;
  }

  const sortedRows = [...rows].sort((a, b) =>
    compareNullable(
      targetSortValue(a, sort.key),
      targetSortValue(b, sort.key),
      sort.direction,
    ),
  );

  return (
    <Table stickyHeader>
      <thead>
        <tr>
          <SortableTh
            label="Target"
            column="name"
            sort={sort}
            onSort={onSort}
          />
          <SortableTh label="Type" column="type" sort={sort} onSort={onSort} />
          <SortableTh
            label="Bid"
            column="bid"
            sort={sort}
            onSort={onSort}
            className="text-right"
          />
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
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => {
          const acos =
            Number(row.totals.sales) > 0
              ? Number(row.totals.cost) / Number(row.totals.sales)
              : null;
          const state = row.state.toLowerCase();
          return (
            <tr key={row.id}>
              <Td className="max-w-xs truncate">
                <span className="font-medium text-zinc-100">
                  {row.bookTitle ?? row.name}
                </span>
                {row.bookTitle !== null && row.asin !== null ? (
                  <span className="ml-2 text-xs text-zinc-500">{row.asin}</span>
                ) : null}
                {row.asin !== null ? (
                  <AmazonProductLink
                    term={row.asin}
                    countryCode={countryCode}
                    className="ml-2 text-xs"
                  />
                ) : null}
              </Td>
              <Td>
                <Badge tone="neutral">{targetTypeLabel(row)}</Badge>
              </Td>
              <Td className="text-right">{formatMoney(row.bid, currency)}</Td>
              <Td>
                <Badge tone={state === "enabled" ? "success" : "neutral"}>
                  {formatAmazonLabel(state)}
                </Badge>
              </Td>
              <Td className="text-right">
                {formatCount(row.totals.impressions)}
              </Td>
              <Td className="text-right">{formatCount(row.totals.clicks)}</Td>
              <Td className="text-right">
                {formatMoney(row.totals.cost, currency)}
              </Td>
              <Td className="text-right">
                {formatMoney(row.totals.sales, currency)}
              </Td>
              <Td className="text-right">{formatCount(row.totals.orders)}</Td>
              <Td className="text-right">{formatCount(row.totals.units)}</Td>
              <Td className="text-right">{formatAcos(acos)}</Td>
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
  renderAction,
}: {
  rows: Row[];
  currency: string;
  termLink?: { days: MetricWindow; country?: string };
  showProfit?: boolean;
  /** Optional trailing per-row action cell (used by the search terms tab). */
  renderAction?: (row: Row) => ReactNode;
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
          {renderAction ? <Th /> : null}
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
              {renderAction ? (
                <Td className="text-right">{renderAction(r)}</Td>
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

  // Terms an enabled synced negative already blocks, matched the way the
  // exclude action would create them: keyword text case-insensitively
  // (Amazon matches negatives that way), ASINs uppercased.
  const excludedTerms = new Set<string>();
  for (const negative of campaign.data.negativeKeywords) {
    if (negative.state.toLowerCase() === "enabled") {
      excludedTerms.add(negative.keywordText.trim().toLowerCase());
    }
  }
  for (const negative of campaign.data.negativeTargets) {
    if (negative.state.toLowerCase() === "enabled") {
      excludedTerms.add(negative.asin.trim().toUpperCase());
    }
  }
  function isTermExcluded(term: string) {
    return isAsin(term)
      ? excludedTerms.has(term.trim().toUpperCase())
      : excludedTerms.has(term.trim().toLowerCase());
  }

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
              <NegativeKeywordsTable
                rows={campaign.data.negativeKeywords}
                campaignId={id}
                editable={editable}
              />
            ) : tab === "negativeTargets" ? (
              <NegativeProductsTable
                rows={campaign.data.negativeTargets}
                countryCode={country}
                campaignId={id}
                editable={editable}
              />
            ) : tab === "targets" ? (
              <TargetsTable
                rows={campaign.data.targets}
                currency={currency}
                countryCode={country}
              />
            ) : (
              <MetricsTable
                key={tab}
                rows={campaign.data[tab]}
                currency={currency}
                termLink={tab === "searchTerms" ? { days, country } : undefined}
                showProfit={tab === "searchTerms"}
                renderAction={
                  tab === "searchTerms" && editable
                    ? (row) => (
                        <ExcludeSearchTerm
                          campaignId={id}
                          term={row.name}
                          alreadyExcluded={isTermExcluded(row.name)}
                        />
                      )
                    : undefined
                }
              />
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
