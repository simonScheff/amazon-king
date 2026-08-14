import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { CampaignListRow } from "@amazon-king/contracts";
import { useCampaigns, useProfiles } from "../api/endpoints";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { SortableTh } from "../components/ui/sortable-th";
import { Table, Td } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { ProfitabilityResult } from "../components/profitability-result";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import { formatAcos, formatCount, formatMoney } from "../lib/format";
import { countryNameForCode, flagForCountry } from "../lib/marketplaces";
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
  const campaigns = useCampaigns(PROFITABILITY_DAYS);
  const profiles = useProfiles();
  const [sort, setSort] = useState<Sort<SortKey>>({
    key: "cost",
    direction: "desc",
  });

  const countryByProfile = new Map(
    (profiles.data ?? []).map((p) => [p.profileId, p.countryCode]),
  );

  function onSort(column: SortKey) {
    setSort((current) => nextSort(current, column, TEXT_COLUMNS));
  }

  const sortedRows = campaigns.data
    ? [...campaigns.data].sort((a, b) =>
        compareNullable(
          sortValue(a, sort.key),
          sortValue(b, sort.key),
          sort.direction,
        ),
      )
    : [];

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <h1 className="text-xl font-bold tracking-tight text-zinc-100">
        Campaigns
      </h1>
      <Card>
        {campaigns.isPending ? (
          <Loading />
        ) : campaigns.error ? (
          <ErrorState error={campaigns.error} />
        ) : sortedRows.length === 0 ? (
          <EmptyState>
            No campaigns imported yet. Connect Amazon Ads and run a sync first.
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
                          economicsMissing={c.profitability.economicsMissing}
                          hasActivity={hasActivity}
                        />
                      </div>
                    </Td>
                    <Td className="text-xs text-zinc-500">
                      {countryCode ? (
                        <span
                          className="whitespace-nowrap"
                          title={`${countryNameForCode(countryCode)} · profile ${c.profileId}`}
                        >
                          {flagForCountry(countryCode)} {countryCode}
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
