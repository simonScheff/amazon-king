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
import { CampaignMaxCpc } from "../components/campaign-max-cpc";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { ProfitabilityResult } from "../components/profitability-result";
import { TimeframeSelect } from "../components/timeframe-select";
import { Badge } from "../components/ui/badge";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
} from "../lib/format";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
} from "../lib/campaign-profit";
import { resolveTimeframe, selectedWindowLabel } from "../lib/timeframe";

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
    <Table>
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
  if (rows.length === 0) {
    return <EmptyState>Nothing here yet for this campaign.</EmptyState>;
  }
  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>State</Th>
          <Th className="text-right">Impressions</Th>
          <Th className="text-right">Clicks</Th>
          <Th className="text-right">Spend</Th>
          <Th className="text-right">Sales</Th>
          <Th className="text-right">Orders</Th>
          <Th className="text-right">ACoS</Th>
          {showProfit ? <Th>Profit</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
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
  const estimatedProfit =
    c.totals.estimatedAdProfit === null
      ? null
      : Number(c.totals.estimatedAdProfit);
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          {c.name}
        </h1>
        <Badge tone={c.state === "enabled" ? "success" : "neutral"}>
          {c.state}
        </Badge>
        {c.state !== "archived" ? (
          <CampaignControls campaignId={id} name={c.name} state={c.state} />
        ) : null}
        {c.amazonConsoleUrl ? (
          <a
            href={c.amazonConsoleUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-400 hover:underline"
          >
            Open in Amazon Ads ↗
          </a>
        ) : null}
        <span className="text-xs text-zinc-500">
          Profile <span className="font-mono">{c.profileId}</span> · {currency}
          {country ? ` · ${country}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-zinc-400">Date range</span>
          <TimeframeSelect
            value={days}
            onChange={(window) =>
              navigate({
                to: "/campaigns/$id",
                params: { id },
                search: (prev) => ({ ...prev, days: window }),
                replace: true,
              })
            }
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <Badge tone={profitStatus.tone}>{profitStatus.label}</Badge>
        <span>
          {hasActivity && estimatedProfit !== null
            ? `${formatMoney(c.totals.estimatedAdProfit, currency)} estimated ad profit`
            : selectedWindowLabel(days)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {formatDate(campaign.data.dateRange.start)} –{" "}
          {formatDate(campaign.data.dateRange.end)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Data current through{" "}
          {formatDateTime(campaign.data.dataCurrentThrough)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Spend" value={formatMoney(c.totals.cost, currency)} />
        <KpiCard label="Sales" value={formatMoney(c.totals.sales, currency)} />
        <KpiCard label="Orders" value={formatCount(c.totals.orders)} />
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
