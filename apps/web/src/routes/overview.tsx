import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useAmazonStatus,
  useDashboardSummary,
  useDataFreshness,
  useProfiles,
  useRecommendations,
} from "../api/endpoints";
import { KpiCard } from "../components/kpi-card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  labelize,
} from "../lib/format";
import {
  flagForCountry,
  marketplaceOptions,
  resolveCountry,
} from "../lib/marketplaces";

const DAY_OPTIONS = [7, 14, 30, 60] as const;

export function OverviewPage() {
  const search = useSearch({ strict: false }) as {
    days?: number;
    country?: string;
  };
  const days = DAY_OPTIONS.includes(search.days as 7)
    ? Number(search.days)
    : 30;
  const navigate = useNavigate();

  const profiles = useProfiles();
  const marketplaces = marketplaceOptions(profiles.data ?? []);
  const country = resolveCountry(search.country, marketplaces);
  const selectedMarketplace = marketplaces.find(
    (marketplace) => marketplace.countryCode === country,
  );
  const selectedProfileIds = new Set(selectedMarketplace?.profileIds ?? []);

  const summary = useDashboardSummary(days, country);
  const freshness = useDataFreshness();
  const status = useAmazonStatus();
  const top = useRecommendations({ state: "pending" });

  const visibleRecommendations = (top.data ?? []).filter(
    (recommendation) =>
      recommendation.profileId !== null &&
      selectedProfileIds.has(recommendation.profileId),
  );
  const visibleFreshness = (freshness.data ?? []).filter((item) =>
    selectedProfileIds.has(item.profileId),
  );

  const currency = summary.data?.currency ?? "USD";
  const totals = summary.data?.totals;

  const chartData = (summary.data?.daily ?? []).map((d) => ({
    date: d.date,
    spend: Number(d.cost),
    sales: Number(d.sales),
    royalty: d.estimatedRoyalty === null ? null : Number(d.estimatedRoyalty),
  }));
  const hasRoyaltyData = chartData.some((point) => point.royalty !== null);

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">Overview</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Country</span>
            <Select
              aria-label="Country"
              value={country}
              disabled={profiles.isPending || marketplaces.length === 0}
              onChange={(event) =>
                navigate({
                  to: "/",
                  search: { days, country: event.currentTarget.value },
                  replace: true,
                })
              }
            >
              {marketplaces.length === 0 ? (
                <option value={country}>
                  {flagForCountry(country)}{" "}
                  {country === "US" ? "United States" : country}
                </option>
              ) : (
                marketplaces.map((marketplace) => (
                  <option
                    key={marketplace.countryCode}
                    value={marketplace.countryCode}
                  >
                    {marketplace.flag} {marketplace.countryName} (
                    {marketplace.currencyCodes.join(", ")})
                  </option>
                ))
              )}
            </Select>
          </label>
          <div role="group" aria-label="Date range" className="flex gap-1">
            {DAY_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={d === days ? "primary" : "secondary"}
                onClick={() =>
                  navigate({
                    to: "/",
                    search: { days: d, country },
                    replace: true,
                  })
                }
              >
                {d}d
              </Button>
            ))}
          </div>
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
            {selectedMarketplace
              ? `${selectedMarketplace.flag} ${selectedMarketplace.countryName}`
              : `${flagForCountry(country)} ${country}`}
          </p>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              label="Spend"
              value={formatMoney(totals?.cost, currency)}
            />
            <KpiCard
              label="Sales"
              value={formatMoney(totals?.sales, currency)}
            />
            <KpiCard label="Orders" value={formatCount(totals?.orders)} />
            <KpiCard label="ACoS" value={formatAcos(totals?.acos)} />
            <KpiCard
              label="Est. royalty"
              value={formatMoney(totals?.estimatedRoyalty, currency)}
              missing={summary.data.economicsMissing}
            />
            <KpiCard
              label="Est. ad profit"
              value={formatMoney(totals?.estimatedAdProfit, currency)}
              missing={summary.data.economicsMissing}
            />
          </div>
          {summary.data.economicsMissing && (
            <p className="text-xs text-amber-300">
              Royalty and profit estimates are hidden because book economics are
              missing. Enter them under Settings → Book economics.
            </p>
          )}

          <Card>
            <CardHeader title="Spend, attributed sales & estimated royalties" />
            <CardBody>
              {chartData.length === 0 ? (
                <EmptyState>No daily trend data available yet.</EmptyState>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#71717a" fontSize={12} />
                      <YAxis stroke="#71717a" fontSize={12} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#18181b",
                          border: "1px solid #3f3f46",
                          fontSize: 12,
                        }}
                        formatter={(value) => [
                          typeof value === "number"
                            ? formatMoney(value.toFixed(2), currency)
                            : String(value),
                        ]}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="spend"
                        name="Spend"
                        stroke="#f59e0b"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="sales"
                        name="Attributed sales"
                        stroke="#38bdf8"
                        dot={false}
                      />
                      {hasRoyaltyData ? (
                        <Line
                          type="monotone"
                          dataKey="royalty"
                          name="Estimated royalties"
                          stroke="#34d399"
                          strokeDasharray="5 4"
                          dot={false}
                        />
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardBody>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Top problems & opportunities" />
              {top.isPending ? (
                <Loading />
              ) : top.error ? (
                <ErrorState error={top.error} />
              ) : visibleRecommendations.length === 0 ? (
                <EmptyState>
                  No pending recommendations for{" "}
                  {selectedMarketplace?.countryName ?? country}.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-zinc-800/60">
                  {[...visibleRecommendations]
                    .sort((a, b) => a.priority - b.priority)
                    .slice(0, 5)
                    .map((r) => (
                      <li key={r.id} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center gap-2">
                          <Badge tone={r.priority <= 2 ? "warning" : "neutral"}>
                            P{r.priority}
                          </Badge>
                          <span className="text-zinc-400">
                            {labelize(r.type)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-zinc-300">
                          {r.rationale}
                        </p>
                      </li>
                    ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader title="Sync & connection health" />
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
                  <ul className="flex flex-col gap-1.5">
                    {visibleFreshness.map((f) => (
                      <li
                        key={`${f.profileId}-${f.dataset}`}
                        className="flex flex-wrap items-baseline gap-x-2"
                      >
                        <span className="font-mono text-xs text-zinc-400">
                          {f.profileId}
                        </span>
                        <span className="text-zinc-300">{f.dataset}</span>
                        <span className="ml-auto text-xs text-zinc-500">
                          {f.completeThrough
                            ? `complete through ${formatDate(f.completeThrough)}`
                            : "never completed"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
