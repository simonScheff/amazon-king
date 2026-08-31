import { useNavigate, useSearch } from "@tanstack/react-router";
import type { MetricWindow, SpendGrain } from "@amazon-king/contracts";
import {
  useDataFreshness,
  useSpendBreakdown,
  useSpendTree,
} from "../api/endpoints";
import { CountrySelect } from "../components/country-select";
import { SpendComposition } from "../components/spend-composition";
import { SpendMovers } from "../components/spend-movers";
import { SpendTreemap } from "../components/spend-treemap";
import { TimeframeSelect } from "../components/timeframe-select";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ErrorState, Loading } from "../components/states";
import { resolveCountry } from "../lib/marketplaces";
import { resolveTimeframe } from "../lib/timeframe";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";

/**
 * /spend — the spend explorer: where the ad money goes, and how that changes
 * over time. Three URL-backed tabs (?tab=composition|movers|map): the daily
 * spend composition (100%-stacked), the movers (weekly ranks + period vs
 * period), and the spend map (treemap sized by spend, colored by ACoS). The
 * shared toolbar carries the breakdown grain (?grain=market|campaign|
 * searchTerm — not used by the map tab), the timeframe, and the market
 * (including the FX-converted "All markets" view).
 */

export const SPEND_TABS = ["composition", "movers", "map"] as const;
export type SpendTab = (typeof SPEND_TABS)[number];

const TAB_LABELS: Record<SpendTab, string> = {
  composition: "Composition",
  movers: "Movers",
  map: "Spend map",
};

export const SPEND_GRAINS = ["market", "campaign", "searchTerm"] as const;

const GRAIN_LABELS: Record<SpendGrain, string> = {
  market: "Market",
  campaign: "Campaign",
  searchTerm: "Search term",
};

const GRAIN_QUALIFIERS: Record<SpendGrain, string> = {
  market: "market",
  campaign: "campaign",
  searchTerm: "search term",
};

export function SpendPage() {
  const search = useSearch({ strict: false }) as {
    tab?: SpendTab;
    grain?: SpendGrain;
    days?: MetricWindow;
    country?: string;
  };
  const navigate = useNavigate();
  const tab = search.tab ?? "composition";
  const grain = search.grain ?? "campaign";
  const days = resolveTimeframe(search.days);

  const marketplaces = useSpendSortedMarketplaces(days);
  const freshness = useDataFreshness();
  // Same gate as the overview: "All markets" needs synced FX rates.
  const ratesSynced = freshness.data?.fxRates?.latestRateDate != null;
  const country =
    search.country === undefined && ratesSynced
      ? "all"
      : resolveCountry(search.country, marketplaces);

  // Only the active tab's endpoint fires; the map tab builds its own
  // hierarchy and ignores the grain selection.
  const breakdown = useSpendBreakdown(grain, days, country, undefined, {
    enabled: tab !== "map",
  });
  const tree = useSpendTree(days, country, undefined, {
    enabled: tab === "map",
  });

  const update = (patch: {
    tab?: SpendTab;
    grain?: SpendGrain;
    days?: MetricWindow;
    country?: string;
  }) => {
    void navigate({
      to: "/spend",
      search: (prev) => ({
        ...prev,
        tab: patch.tab ?? tab,
        grain: patch.grain ?? grain,
        days: patch.days ?? days,
        country: patch.country ?? country,
      }),
      replace: true,
    });
  };

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">
            Spend explorer
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Where the money goes, and how that changes over time
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {tab !== "map" ? (
            <div
              role="group"
              aria-label="Break down by"
              className="flex items-center gap-1"
            >
              <span className="mr-1 text-sm text-zinc-400">Break down by</span>
              {SPEND_GRAINS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === grain ? "primary" : "secondary"}
                  aria-pressed={option === grain}
                  onClick={() => update({ grain: option })}
                >
                  {GRAIN_LABELS[option]}
                </Button>
              ))}
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Country</span>
            <CountrySelect
              value={country}
              options={marketplaces}
              disabled={marketplaces.length === 0}
              allMarketsLabel="All markets"
              allMarketsDisabled={!ratesSynced}
              allMarketsDisabledReason="Exchange rates not synced yet — see Sync status on the overview"
              onChange={(countryCode) => update({ country: countryCode })}
            />
          </label>
          <TimeframeSelect
            value={days}
            onChange={(window) => update({ days: window })}
          />
        </div>
      </div>

      <div className="border-b border-zinc-800">
        <nav className="-mb-px flex gap-6" aria-label="Spend explorer sections">
          {SPEND_TABS.map((spendTab) => (
            <button
              key={spendTab}
              type="button"
              aria-current={spendTab === tab ? "page" : undefined}
              onClick={() => update({ tab: spendTab })}
              className={`border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                spendTab === tab
                  ? "border-sky-500 text-sky-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {TAB_LABELS[spendTab]}
            </button>
          ))}
        </nav>
      </div>

      {tab === "map" ? (
        <Card>
          <CardHeader
            title="Spend map"
            description="Box size is window spend; color is ACoS. Groups are markets across all markets, campaigns inside one."
          />
          <CardBody>
            {tree.isPending ? (
              <Loading label="Loading spend map…" />
            ) : tree.error ? (
              <ErrorState error={tree.error} />
            ) : (
              <SpendTreemap data={tree.data} />
            )}
          </CardBody>
        </Card>
      ) : breakdown.isPending ? (
        <Card>
          <CardBody>
            <Loading label="Loading spend…" />
          </CardBody>
        </Card>
      ) : breakdown.error ? (
        <Card>
          <CardBody>
            <ErrorState error={breakdown.error} />
          </CardBody>
        </Card>
      ) : tab === "composition" ? (
        <Card>
          <CardHeader
            title={`Daily spend composition — by ${GRAIN_QUALIFIERS[grain]}`}
            description="Each day's spend split across the top entities; the rest is merged into Everything else."
          />
          <CardBody>
            <SpendComposition data={breakdown.data} />
          </CardBody>
        </Card>
      ) : (
        <SpendMovers data={breakdown.data} />
      )}
    </div>
  );
}
