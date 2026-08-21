import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useAmazonStatus,
  useDashboardSummary,
  useDataFreshness,
  useProfiles,
  useRecommendations,
  useSyncRuns,
} from "../api/endpoints";
import type { SyncRunSummary } from "@amazon-king/contracts";
import { CountrySelect } from "../components/country-select";
import { Flag } from "../components/flag";
import { KpiCard } from "../components/kpi-card";
import { TimeframeSelect } from "../components/timeframe-select";
import {
  PerformanceTrendChart,
  TREND_SERIES_COLORS,
  type TrendSeries,
} from "../components/performance-trend-chart";
import { DailyProfitChart } from "../components/daily-profit-chart";
import { Badge } from "../components/ui/badge";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  labelize,
  ORDERS_COLUMN_TITLE,
  ordersUnitsHint,
  percentChange,
} from "../lib/format";
import { resolveCountry } from "../lib/marketplaces";
import { previousDeltaLabel, resolveTimeframe } from "../lib/timeframe";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";

export function OverviewPage() {
  const search = useSearch({ strict: false }) as {
    days?: number | "mtd";
    country?: string;
    books?: string[];
  };
  const days = resolveTimeframe(search.days);
  const bookIds = search.books;
  const navigate = useNavigate();

  const profiles = useProfiles();
  const marketplaces = useSpendSortedMarketplaces(days, bookIds);
  const country = resolveCountry(search.country, marketplaces);
  const selectedMarketplace = marketplaces.find(
    (marketplace) => marketplace.countryCode === country,
  );
  const selectedProfileIds = new Set(selectedMarketplace?.profileIds ?? []);

  const summary = useDashboardSummary(days, country, bookIds);
  const freshness = useDataFreshness();
  const status = useAmazonStatus();
  const top = useRecommendations({ state: "pending" }, bookIds);

  const visibleRecommendations = (top.data ?? []).filter(
    (recommendation) =>
      recommendation.profileId !== null &&
      selectedProfileIds.has(recommendation.profileId),
  );
  const visibleFreshness = (freshness.data ?? []).filter((item) =>
    selectedProfileIds.has(item.profileId),
  );

  // Latest sync run per profile+dataset (the API returns runs newest-first).
  const syncRuns = useSyncRuns();
  const latestRunByKey = new Map<string, SyncRunSummary>();
  for (const run of syncRuns.data ?? []) {
    if (!selectedProfileIds.has(run.profileId)) continue;
    const key = `${run.profileId}:${run.kind}`;
    if (!latestRunByKey.has(key)) latestRunByKey.set(key, run);
  }
  // Metrics syncs target yesterday — Amazon's current day is incomplete.
  const expectedThrough = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  const currency = summary.data?.currency ?? "USD";
  const totals = summary.data?.totals;
  const previousTotals = summary.data?.previous.totals;
  const deltaLabel = previousDeltaLabel(days);

  // Display-only conversion of decimal strings for the delta calculation.
  const num = (value: string | null | undefined): number | null =>
    value == null ? null : Number(value);

  // KPI cards double as toggles for the trend chart series.
  const [visibleSeries, setVisibleSeries] = useState<ReadonlySet<TrendSeries>>(
    () => new Set<TrendSeries>(["spend", "sales", "royalty"]),
  );
  const toggleSeries = (series: TrendSeries) => {
    setVisibleSeries((current) => {
      const next = new Set(current);
      if (next.has(series)) {
        // Keep at least one line on the chart.
        if (next.size === 1) return current;
        next.delete(series);
      } else {
        next.add(series);
      }
      return next;
    });
  };
  const seriesProps = (series: TrendSeries, disabled = false) => ({
    swatch: TREND_SERIES_COLORS[series],
    active: visibleSeries.has(series),
    onToggle: disabled ? undefined : () => toggleSeries(series),
  });

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          Overview
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Country</span>
            <CountrySelect
              value={country}
              options={marketplaces}
              disabled={profiles.isPending || marketplaces.length === 0}
              onChange={(countryCode) =>
                navigate({
                  to: "/",
                  search: (prev) => ({ ...prev, days, country: countryCode }),
                  replace: true,
                })
              }
            />
          </label>
          <TimeframeSelect
            value={days}
            onChange={(window) =>
              navigate({
                to: "/",
                search: (prev) => ({ ...prev, days: window, country }),
                replace: true,
              })
            }
          />
        </div>
      </div>

      {summary.isPending ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState error={summary.error} />
      ) : summary.data ? (
        <>
          <p className="text-sm text-zinc-400">
            Data current through{" "}
            <time
              dateTime={summary.data.dataCurrentThrough}
              className="font-medium text-zinc-100"
            >
              {formatDateTime(summary.data.dataCurrentThrough)}
            </time>{" "}
            · {formatDate(summary.data.dateRange.start)} –{" "}
            {formatDate(summary.data.dateRange.end)} ·{" "}
            {selectedMarketplace ? (
              <>
                <Flag
                  countryCode={selectedMarketplace.countryCode}
                  className="mr-1"
                />
                {selectedMarketplace.countryName}
              </>
            ) : (
              <>
                <Flag countryCode={country} className="mr-1" />
                {country}
              </>
            )}
          </p>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              label="Spend"
              value={formatMoney(totals?.cost, currency)}
              delta={percentChange(
                num(totals?.cost),
                num(previousTotals?.cost),
              )}
              deltaGoodWhenUp={false}
              deltaLabel={deltaLabel}
              {...seriesProps("spend")}
            />
            <KpiCard
              label="Sales"
              value={formatMoney(totals?.sales, currency)}
              delta={percentChange(
                num(totals?.sales),
                num(previousTotals?.sales),
              )}
              deltaLabel={deltaLabel}
              {...seriesProps("sales")}
            />
            <KpiCard
              label="Orders"
              value={formatCount(totals?.orders)}
              suffix={ordersUnitsHint(totals?.orders, totals?.units)}
              suffixTitle={ORDERS_COLUMN_TITLE}
              delta={percentChange(totals?.orders, previousTotals?.orders)}
              deltaLabel={deltaLabel}
              {...seriesProps("orders")}
            />
            <KpiCard
              label="ACoS"
              value={formatAcos(totals?.acos)}
              delta={percentChange(totals?.acos, previousTotals?.acos)}
              deltaGoodWhenUp={false}
              deltaLabel={deltaLabel}
              {...seriesProps("acos")}
            />
            <KpiCard
              label="Est. royalty"
              value={formatMoney(totals?.estimatedRoyalty, currency)}
              missing={summary.data.economicsMissing}
              delta={percentChange(
                num(totals?.estimatedRoyalty),
                num(previousTotals?.estimatedRoyalty),
              )}
              deltaLabel={deltaLabel}
              {...seriesProps("royalty", summary.data.economicsMissing)}
            />
            <KpiCard
              label="Est. ad profit"
              value={formatMoney(totals?.estimatedAdProfit, currency)}
              missing={summary.data.economicsMissing}
              delta={percentChange(
                num(totals?.estimatedAdProfit),
                num(previousTotals?.estimatedAdProfit),
              )}
              deltaLabel={deltaLabel}
              {...seriesProps("profit", summary.data.economicsMissing)}
            />
          </div>
          {summary.data.economicsMissing && (
            <p className="text-xs text-amber-300">
              Royalty and profit estimates are hidden because book economics are
              missing. Enter them under Settings → Book economics.
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="flex flex-col gap-6 lg:col-span-2">
              <Card>
                <CardHeader title="Daily performance — click a metric card to toggle its line" />
                <CardBody>
                  <PerformanceTrendChart
                    daily={summary.data.daily ?? []}
                    currency={currency}
                    showProfit
                    visible={[...visibleSeries]}
                  />
                </CardBody>
              </Card>

              {!summary.data.economicsMissing && (
                <Card>
                  <CardHeader title="Daily profitability" />
                  <CardBody>
                    <DailyProfitChart
                      daily={summary.data.daily ?? []}
                      currency={currency}
                    />
                  </CardBody>
                </Card>
              )}
            </div>

            <Card className="flex flex-col border-zinc-700 bg-zinc-850 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
              <CardHeader
                title="Pending recommendations"
                action={
                  visibleRecommendations.length > 0 ? (
                    <Badge tone="neutral">
                      {visibleRecommendations.length}
                    </Badge>
                  ) : undefined
                }
              />
              {top.isPending ? (
                <CardBody>
                  <Loading />
                </CardBody>
              ) : top.error ? (
                <CardBody>
                  <ErrorState error={top.error} />
                </CardBody>
              ) : visibleRecommendations.length === 0 ? (
                <CardBody>
                  <EmptyState>
                    No pending recommendations for{" "}
                    {selectedMarketplace?.countryName ?? country}.
                  </EmptyState>
                </CardBody>
              ) : (
                <ul className="flex flex-col gap-3 px-5 py-4">
                  {[...visibleRecommendations]
                    .sort((a, b) => a.priority - b.priority)
                    .slice(0, 5)
                    .map((r) => (
                      <li
                        key={r.id}
                        className="relative overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-600"
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute inset-y-0 left-0 w-1 ${
                            r.priority <= 2 ? "bg-amber-300" : "bg-sky-400"
                          }`}
                        />
                        <Link
                          to="/recommendations/$id"
                          params={{ id: r.id }}
                          className="block p-4 pl-5"
                        >
                          <div className="flex items-center gap-2">
                            <Badge
                              tone={r.priority <= 2 ? "warning" : "neutral"}
                            >
                              P{r.priority}
                            </Badge>
                            <span className="text-xs text-zinc-500">
                              {labelize(r.type)}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-3 text-sm text-zinc-200">
                            {r.rationale}
                          </p>
                          <p className="mt-1.5 text-xs text-zinc-500">
                            <time dateTime={r.createdAt}>
                              Created {formatDateTime(r.createdAt)}
                            </time>
                          </p>
                        </Link>
                      </li>
                    ))}
                </ul>
              )}
              <Link
                to="/recommendations"
                className="mt-auto block border-t border-zinc-800 px-5 py-3 text-center text-sm text-zinc-400 transition-colors hover:text-sky-300"
              >
                View all recommendations →
              </Link>
            </Card>
          </div>

          <Card>
            <CardHeader title="Sync status" />
            <CardBody className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">Amazon connection:</span>
                {status.data ? (
                  <Badge
                    tone={
                      status.data.status === "connected"
                        ? "success"
                        : status.data.status === "reconnect_required"
                          ? "warning"
                          : "danger"
                    }
                  >
                    {status.data.status.replace("_", " ")}
                  </Badge>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </div>
              {freshness.isPending ? (
                <Loading />
              ) : freshness.error ? (
                <ErrorState error={freshness.error} />
              ) : visibleFreshness.length === 0 ? (
                <p className="text-zinc-500">
                  No sync runs yet for{" "}
                  {selectedMarketplace?.countryName ?? country}.
                </p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {visibleFreshness.map((f) => {
                    const run = latestRunByKey.get(
                      `${f.profileId}:${f.dataset}`,
                    );
                    const behind =
                      f.dataset === "metrics" &&
                      (f.completeThrough === null ||
                        f.completeThrough < expectedThrough);
                    const upToDate =
                      f.dataset === "metrics" &&
                      f.completeThrough !== null &&
                      !behind;
                    return (
                      <li
                        key={`${f.profileId}-${f.dataset}`}
                        className="flex flex-col gap-1"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono text-xs text-zinc-400">
                            {f.profileId}
                          </span>
                          <span className="text-zinc-300">{f.dataset}</span>
                          {run?.status === "running" ? (
                            <Badge tone="info">syncing…</Badge>
                          ) : run?.status === "failed" ? (
                            <Badge tone="danger" title={run.error ?? undefined}>
                              failed
                            </Badge>
                          ) : upToDate ? (
                            <Badge tone="success">up to date</Badge>
                          ) : behind ? (
                            <Badge tone="warning">
                              behind · expecting {formatDate(expectedThrough)}
                            </Badge>
                          ) : null}
                          <span className="ml-auto text-xs text-zinc-500">
                            {f.completeThrough
                              ? `complete through ${formatDate(f.completeThrough)}`
                              : f.lastSuccessAt
                                ? `last completed ${formatDateTime(f.lastSuccessAt)}`
                                : "never completed"}
                          </span>
                        </div>
                        {run?.status === "running" && run.reports.length > 0 ? (
                          <p className="text-xs text-zinc-500">
                            {runProgressText(run)}
                          </p>
                        ) : null}
                        {run?.status === "failed" && run.error ? (
                          <p className="text-xs text-red-400">{run.error}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** Progress line for a running sync: "3 of 8 reports complete · Importing Search Terms (…)". */
function runProgressText(run: SyncRunSummary): string {
  const done = run.reports.filter((r) => r.status === "complete").length;
  const current = run.reports.find((r) => r.status !== "complete");
  const base = `${done} of ${run.reports.length} reports complete`;
  return current
    ? `${base} · ${labelize(current.status)} ${labelize(current.reportType)} (${formatDate(current.dateStart)} – ${formatDate(current.dateEnd)})`
    : base;
}
