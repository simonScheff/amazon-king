import { useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  negativeKindSchema,
  type NegativeBlockingCampaign,
  type NegativeKind,
  type SearchTermCampaignRow,
} from "@amazon-king/contracts";
import { useNegative, useSearchTermExclusions } from "../api/endpoints";
import { KpiCard } from "../components/kpi-card";
import { AmazonProductLink } from "../components/amazon-product-link";
import { ProfitabilityResult } from "../components/profitability-result";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { MetricFunnel } from "../components/metric-funnel";
import { TimeframeSelect } from "../components/timeframe-select";
import { Badge } from "../components/ui/badge";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Select } from "../components/ui/input";
import {
  columnAriaSort,
  SortButton,
  SortableTh,
} from "../components/ui/sortable-th";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { ExcludeSearchTerm } from "../components/exclude-search-term";
import { ExcludeSearchTermGlobal } from "../components/exclude-search-term-global";
import { ReincludeNegative } from "../components/reinclude-negative";
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
  ORDERS_COLUMN_TITLE,
  ordersUnitsHint,
} from "../lib/format";
import { compareNullable, nextSort, type Sort } from "../lib/sorting";
import { countryNameForCode } from "../lib/marketplaces";
import {
  resolveTimeframe,
  selectedWindowLabel,
  windowQualifier,
} from "../lib/timeframe";

const TEXT_COLUMNS = ["name", "state"] as const;

type CampaignSortKey =
  | "name"
  | "state"
  | "profit"
  | "impressions"
  | "clicks"
  | "cost"
  | "sales"
  | "orders"
  | "units"
  | "acos";

function campaignSortValue(
  row: SearchTermCampaignRow,
  key: CampaignSortKey,
): number | string | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
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
    case "units":
      return row.totals.units;
    case "acos":
      return Number(row.totals.sales) > 0
        ? Number(row.totals.cost) / Number(row.totals.sales)
        : null;
  }
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

function isEnabledState(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "enabled" || normalized === "active";
}

/**
 * Why an applied negative is not stopping the term right now. The remaining
 * case after both states is ad-group coverage: the negative sits on only some
 * of the ad groups that served the term.
 */
function notBlockingReason(row: NegativeBlockingCampaign): {
  label: string;
  title?: string;
} {
  if (!isEnabledState(row.state)) {
    return { label: `campaign ${formatAmazonLabel(row.state).toLowerCase()}` };
  }
  if (!isEnabledState(row.negativeState)) {
    return {
      label: `negative ${formatAmazonLabel(row.negativeState).toLowerCase()}`,
    };
  }
  return {
    label: "partial coverage",
    title:
      "Enabled, but it covers only some of the ad groups that served this term.",
  };
}

export function NegativeDetailPage() {
  const params = useParams({ strict: false }) as {
    kind?: string;
    value?: string;
  };
  const kindParsed = negativeKindSchema.safeParse(params.kind);
  const value = params.value ?? "";
  const search = useSearch({ strict: false }) as {
    days?: number | "mtd";
    books?: string[];
    country?: string;
  };
  const days = resolveTimeframe(search.days, 7);
  const navigate = useNavigate();
  const kind: NegativeKind | null = kindParsed.success ? kindParsed.data : null;
  const detail = useNegative(
    kind ?? "keyword",
    value,
    days,
    search.books,
    search.country,
  );
  const exclusions = useSearchTermExclusions();
  const [blockingSort, setBlockingSort] = useState<Sort<CampaignSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [unblockedSort, setUnblockedSort] = useState<Sort<CampaignSortKey>>({
    key: "cost",
    direction: "desc",
  });

  if (!kindParsed.success) {
    return <ErrorState error={new Error("Unknown negative type")} />;
  }
  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} />;
  if (!detail.data) return null;

  const data = detail.data;
  const currency = data.currency;
  const hasActivity = hasCampaignActivity(data.window);
  const profitStatus = getCampaignProfitStatus(
    data.window,
    data.economicsMissing,
    data.window.estimatedAdProfit,
  );
  const excluded = (exclusions.data?.exclusions ?? []).some(
    (entry) => entry.term === data.value.trim().toLowerCase(),
  );

  const sortedBlocking = [...data.blockingCampaigns].sort((a, b) => {
    if (blockingSort.key === "state") {
      const live = Number(a.currentlyBlocks) - Number(b.currentlyBlocks);
      if (live !== 0) return blockingSort.direction === "asc" ? -live : live;
      return a.name.localeCompare(b.name);
    }
    const live = Number(b.currentlyBlocks) - Number(a.currentlyBlocks);
    if (live !== 0 && blockingSort.key === "cost") return live;
    return compareNullable(
      campaignSortValue(a, blockingSort.key),
      campaignSortValue(b, blockingSort.key),
      blockingSort.direction,
    );
  });
  const sortedUnblocked = [...data.unblockedCampaigns].sort((a, b) =>
    compareNullable(
      campaignSortValue(a, unblockedSort.key),
      campaignSortValue(b, unblockedSort.key),
      unblockedSort.direction,
    ),
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-sm">
        <Link to="/negatives" className="text-sky-400 hover:underline">
          ← Negatives
        </Link>
        {data.hasSearchTermFacts ? (
          <>
            <span aria-hidden="true" className="mx-2 text-zinc-600">
              ·
            </span>
            <Link
              to="/search-terms/$term"
              params={{ term: data.value }}
              search={{ days, country: data.countryCode }}
              className="text-sky-400 hover:underline"
            >
              View as search term
            </Link>
          </>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-xl font-bold tracking-tight text-zinc-100">
          {data.value}
        </h1>
        <span className="text-xs text-zinc-500">{currency}</span>
        <AmazonProductLink
          term={data.value}
          countryCode={data.countryCode}
          className="text-xs"
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Market</span>
            <Select
              aria-label="Market"
              value={data.countryCode}
              onChange={(event) => {
                const nextCountry = event.currentTarget.value;
                void navigate({
                  to: "/negatives/$kind/$value",
                  params: { kind: data.kind, value },
                  search: (prev) => ({ ...prev, days, country: nextCountry }),
                  replace: true,
                });
              }}
            >
              {data.availableCountryCodes.map((countryCode) => (
                <option key={countryCode} value={countryCode}>
                  {countryNameForCode(countryCode)} ({countryCode})
                </option>
              ))}
            </Select>
          </label>
          {data.kind === "keyword" ? (
            <ExcludeSearchTermGlobal
              term={data.value}
              excluded={excluded || data.excludedEverywhere}
            />
          ) : null}
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-400">Date range</span>
            <TimeframeSelect
              value={days}
              onChange={(window) =>
                navigate({
                  to: "/negatives/$kind/$value",
                  params: { kind: data.kind, value },
                  search: (prev) => ({
                    ...prev,
                    days: window,
                    country: data.countryCode,
                  }),
                  replace: true,
                })
              }
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <Badge tone={profitStatus.tone}>{profitStatus.label}</Badge>
        <span>
          {hasActivity && data.window.estimatedAdProfit !== null
            ? `${formatMoney(data.window.estimatedAdProfit, currency)} estimated ad profit`
            : selectedWindowLabel(days)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {formatDate(data.dateRange.start)} – {formatDate(data.dateRange.end)}
        </span>
        <span aria-hidden="true">·</span>
        <span>Data current through {formatDate(data.dataCurrentThrough)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {data.matchTypes.map((match) => (
          <Badge key={match} tone="neutral">
            {data.kind === "product" ? "Product" : formatAmazonLabel(match)}
          </Badge>
        ))}
        {data.excludedEverywhere || excluded ? (
          <Badge tone="info">Everywhere</Badge>
        ) : null}
        {data.catalogBookId ? <Badge tone="success">Your catalog</Badge> : null}
        <span className="text-sm text-zinc-400">
          {formatCount(data.blockingCampaignCount)} blocking now
        </span>
        <span aria-hidden="true" className="text-zinc-600">
          ·
        </span>
        <span
          className={
            data.stillServingCampaignCount > 0
              ? "text-sm text-amber-300"
              : "text-sm text-zinc-400"
          }
        >
          {formatCount(data.stillServingCampaignCount)} still eligible
        </span>
        <span aria-hidden="true" className="text-zinc-600">
          ·
        </span>
        <span
          className="text-sm text-zinc-400"
          title="Before we first synced this negative. Amazon does not expose when it was created."
        >
          Sold before first seen: {formatCount(data.before.orders)} orders ·{" "}
          {formatMoney(data.before.cost, currency)}
        </span>
        <span aria-hidden="true" className="text-zinc-600">
          ·
        </span>
        <span className="text-sm text-zinc-400">
          Last served {formatDate(data.lastServedAt)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Spend"
          value={formatMoney(data.window.cost, currency)}
        />
        <KpiCard
          label="Sales"
          value={formatMoney(data.window.sales, currency)}
        />
        <KpiCard
          label="Orders"
          value={formatCount(data.window.orders)}
          suffix={ordersUnitsHint(data.window.orders, data.window.units)}
          suffixTitle={ORDERS_COLUMN_TITLE}
        />
        <KpiCard label="ACoS" value={formatAcos(data.window.acos)} />
        <KpiCard
          label="Est. royalty"
          value={formatMoney(data.window.estimatedRoyalty, currency)}
          missing={data.economicsMissing}
        />
        <KpiCard
          label="Est. ad profit"
          value={formatMoney(data.window.estimatedAdProfit, currency)}
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
            markerDate={data.firstSeenAt}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`${windowQualifier(days)} conversion funnel`} />
        <CardBody>
          <MetricFunnel
            stages={[
              { label: "Impressions", value: data.window.impressions },
              { label: "Clicks", value: data.window.clicks, rateLabel: "CTR" },
              { label: "Orders", value: data.window.orders, rateLabel: "CVR" },
            ]}
          />
        </CardBody>
      </Card>

      {data.matchedTerms.length > 0 ? (
        <Card>
          <CardHeader title="Also matching in this window" />
          <CardBody>
            <ul className="flex flex-wrap gap-2 text-sm">
              {data.matchedTerms.map((term) => (
                <li key={term}>
                  <Link
                    to="/search-terms/$term"
                    params={{ term }}
                    search={{ days, country: data.countryCode }}
                    className="text-sky-400 hover:underline"
                  >
                    {term}
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Before vs this window" />
        <CardBody>
          <p className="mb-3 text-xs text-zinc-500">
            “Before” is search-term facts dated earlier than{" "}
            {formatDate(data.firstSeenAt)}, when we first saw this negative.
            Amazon does not expose when it was created on the campaign.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <PeriodColumn
              title="Before first seen"
              period={data.before}
              currency={currency}
            />
            <PeriodColumn
              title={selectedWindowLabel(days)}
              period={data.window}
              currency={currency}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Negative applied on (${formatCount(data.blockingCampaigns.length)})`}
          description="Campaigns that carry this negative. “Blocking” means the term cannot serve there right now."
        />
        {data.blockingCampaigns.length === 0 ? (
          <EmptyState>No campaigns currently carry this negative.</EmptyState>
        ) : (
          <BlockingCampaignTable
            rows={sortedBlocking}
            currency={currency}
            days={days}
            kind={data.kind}
            label={data.value}
            sort={blockingSort}
            onSort={(column) =>
              setBlockingSort((current) =>
                nextSort(current, column, TEXT_COLUMNS),
              )
            }
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Term can still serve on (${formatCount(data.unblockedCampaigns.length)})`}
          description="Campaigns that served this term in the window and have no negative for it."
        />
        {data.unblockedCampaigns.length === 0 ? (
          <EmptyState>
            Every campaign that served this term already blocks it.
          </EmptyState>
        ) : (
          <UnblockedCampaignTable
            rows={sortedUnblocked}
            currency={currency}
            days={days}
            term={data.value}
            sort={unblockedSort}
            onSort={(column) =>
              setUnblockedSort((current) =>
                nextSort(current, column, TEXT_COLUMNS),
              )
            }
          />
        )}
      </Card>
    </div>
  );
}

function PeriodColumn({
  title,
  period,
  currency,
}: {
  title: string;
  period: {
    cost: string;
    sales: string;
    orders: number;
    units: number;
    acos: number | null;
    estimatedAdProfit: string | null;
    economicsMissing: boolean;
  };
  currency: string;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-zinc-500">Spend</dt>
        <dd>{formatMoney(period.cost, currency)}</dd>
        <dt className="text-zinc-500">Sales</dt>
        <dd>{formatMoney(period.sales, currency)}</dd>
        <dt className="text-zinc-500">Orders</dt>
        <dd>{formatCount(period.orders)}</dd>
        <dt className="text-zinc-500">Units</dt>
        <dd>{formatCount(period.units)}</dd>
        <dt className="text-zinc-500">ACoS</dt>
        <dd>{formatAcos(period.acos)}</dd>
        <dt className="text-zinc-500">Profit</dt>
        <dd>
          {period.economicsMissing
            ? "—"
            : formatMoney(period.estimatedAdProfit, currency)}
        </dd>
      </dl>
    </div>
  );
}

function metricHeaders(
  sort: Sort<CampaignSortKey>,
  onSort: (column: CampaignSortKey) => void,
  days: ReturnType<typeof resolveTimeframe>,
  extra?: ReactNode,
  stateLabel = "State",
) {
  return (
    <tr>
      <Th aria-sort={columnAriaSort(sort, ["name", "profit"])}>
        <div className="flex flex-col items-start gap-1">
          <SortButton
            label="Campaign"
            column="name"
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
      <SortableTh
        label={stateLabel}
        column="state"
        sort={sort}
        onSort={onSort}
      />
      {extra}
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
      <Th>
        <span className="sr-only">Actions</span>
      </Th>
    </tr>
  );
}

function MetricCells({
  row,
  currency,
  days,
}: {
  row: SearchTermCampaignRow;
  currency: string;
  days: ReturnType<typeof resolveTimeframe>;
}) {
  const campaignActivity = hasCampaignActivity(row.totals);
  const campaignProfitStatus = getCampaignProfitStatus(
    row.totals,
    row.economicsMissing,
    row.estimatedAdProfit,
  );
  const acos =
    Number(row.totals.sales) > 0
      ? Number(row.totals.cost) / Number(row.totals.sales)
      : null;
  return (
    <>
      <Td
        className="hidden whitespace-nowrap md:table-cell"
        aria-label={`${row.name} ${windowQualifier(days)} profit: ${campaignProfitStatus.label}`}
      >
        <ProfitabilityResult
          status={campaignProfitStatus}
          amount={row.estimatedAdProfit}
          currency={currency}
          economicsMissing={row.economicsMissing}
          hasActivity={campaignActivity}
        />
      </Td>
      <Td className="text-right">{formatCount(row.totals.impressions)}</Td>
      <Td className="text-right">{formatCount(row.totals.clicks)}</Td>
      <Td className="text-right">{formatMoney(row.totals.cost, currency)}</Td>
      <Td className="text-right">{formatMoney(row.totals.sales, currency)}</Td>
      <Td className="text-right">{formatCount(row.totals.orders)}</Td>
      <Td className="text-right">{formatCount(row.totals.units)}</Td>
      <Td className="text-right">{formatAcos(acos)}</Td>
    </>
  );
}

function BlockingCampaignTable({
  rows,
  currency,
  days,
  kind,
  label,
  sort,
  onSort,
}: {
  rows: NegativeBlockingCampaign[];
  currency: string;
  days: ReturnType<typeof resolveTimeframe>;
  kind: NegativeKind;
  label: string;
  sort: Sort<CampaignSortKey>;
  onSort: (column: CampaignSortKey) => void;
}) {
  return (
    <Table stickyHeader>
      <thead>
        {metricHeaders(
          sort,
          onSort,
          days,
          <>
            <Th>Applied to</Th>
            <Th>Match</Th>
            <Th>Added</Th>
          </>,
          "This term",
        )}
      </thead>
      <tbody>
        {rows.map((row) => {
          const reason = row.currentlyBlocks ? null : notBlockingReason(row);
          return (
            <tr key={`${row.profileId}-${row.campaignId}-${row.negativeId}`}>
              <Td>
                <Link
                  to="/campaigns/$id"
                  params={{ id: row.campaignId }}
                  search={{ days }}
                  className="text-sky-400 hover:underline"
                >
                  {row.name}
                </Link>
                <div className="mt-2 md:hidden">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    {windowQualifier(days)} profit
                  </p>
                  <ProfitabilityResult
                    status={getCampaignProfitStatus(
                      row.totals,
                      row.economicsMissing,
                      row.estimatedAdProfit,
                    )}
                    amount={row.estimatedAdProfit}
                    currency={currency}
                    economicsMissing={row.economicsMissing}
                    hasActivity={hasCampaignActivity(row.totals)}
                  />
                </div>
              </Td>
              <Td>
                {reason === null ? (
                  <Badge tone="success">Blocking</Badge>
                ) : (
                  <Badge tone="neutral" title={reason.title}>
                    {`Not blocking · ${reason.label}`}
                  </Badge>
                )}
              </Td>
              <Td>{appliedToLabel(row)}</Td>
              <Td>{formatAmazonLabel(row.matchType)}</Td>
              <Td>{formatDate(row.firstSeenAt)}</Td>
              <MetricCells row={row} currency={currency} days={days} />
              <Td className="text-right">
                <ReincludeNegative
                  campaignId={row.campaignId}
                  kind={kind === "product" ? "target" : "keyword"}
                  negativeId={row.negativeId}
                  label={label}
                />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function UnblockedCampaignTable({
  rows,
  currency,
  days,
  term,
  sort,
  onSort,
}: {
  rows: SearchTermCampaignRow[];
  currency: string;
  days: ReturnType<typeof resolveTimeframe>;
  term: string;
  sort: Sort<CampaignSortKey>;
  onSort: (column: CampaignSortKey) => void;
}) {
  return (
    <Table stickyHeader>
      <thead>{metricHeaders(sort, onSort, days)}</thead>
      <tbody>
        {rows.map((row) => {
          const stillServing =
            row.state.toLowerCase() === "enabled" &&
            hasCampaignActivity(row.totals);
          return (
            <tr key={`${row.profileId}-${row.campaignId}`}>
              <Td>
                <Link
                  to="/campaigns/$id"
                  params={{ id: row.campaignId }}
                  search={{ days }}
                  className="text-sky-400 hover:underline"
                >
                  {row.name}
                </Link>
                {stillServing ? (
                  <div className="mt-1">
                    <Badge tone="warning">Still serving</Badge>
                  </div>
                ) : null}
                <div className="mt-2 md:hidden">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    {windowQualifier(days)} profit
                  </p>
                  <ProfitabilityResult
                    status={getCampaignProfitStatus(
                      row.totals,
                      row.economicsMissing,
                      row.estimatedAdProfit,
                    )}
                    amount={row.estimatedAdProfit}
                    currency={currency}
                    economicsMissing={row.economicsMissing}
                    hasActivity={hasCampaignActivity(row.totals)}
                  />
                </div>
              </Td>
              <Td>
                <Badge
                  tone={
                    row.state.toLowerCase() === "enabled"
                      ? "success"
                      : "neutral"
                  }
                >
                  {formatAmazonLabel(row.state)}
                </Badge>
              </Td>
              <MetricCells row={row} currency={currency} days={days} />
              <Td className="text-right">
                <ExcludeSearchTerm campaignId={row.campaignId} term={term} />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
