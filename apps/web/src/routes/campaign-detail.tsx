import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { MetricTotals } from "@amazon-king/contracts";
import { useCampaign, useProfiles } from "../api/endpoints";
import { KpiCard } from "../components/kpi-card";
import { PerformanceTrendChart } from "../components/performance-trend-chart";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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

type Tab = "adGroups" | "targets" | "searchTerms";

const DAY_OPTIONS = [7, 14, 30, 60] as const;

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "adGroups", label: "Ad groups" },
  { key: "targets", label: "Targets" },
  { key: "searchTerms", label: "Search terms" },
];

interface Row {
  id: string;
  name: string;
  state: string;
  totals: MetricTotals;
}

function MetricsTable({ rows, currency }: { rows: Row[]; currency: string }) {
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
              <Td className="max-w-xs truncate">{r.name}</Td>
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
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as { days?: number };
  const days = DAY_OPTIONS.includes(search.days as 7)
    ? Number(search.days)
    : 30;
  const navigate = useNavigate();
  const campaign = useCampaign(id, days);
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
  const hasActivity =
    c.totals.impressions > 0 ||
    c.totals.clicks > 0 ||
    c.totals.orders > 0 ||
    Number(c.totals.cost) > 0 ||
    Number(c.totals.sales) > 0;
  const estimatedProfit =
    c.totals.estimatedAdProfit === null
      ? null
      : Number(c.totals.estimatedAdProfit);
  const profitStatus = !hasActivity
    ? { label: "No activity", tone: "neutral" as const }
    : campaign.data.economicsMissing || estimatedProfit === null
      ? { label: "Profit unavailable", tone: "warning" as const }
      : estimatedProfit > 0
        ? { label: "Profitable", tone: "success" as const }
        : estimatedProfit < 0
          ? { label: "Not profitable", tone: "danger" as const }
          : { label: "Break-even", tone: "neutral" as const };

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-sm">
        <Link to="/campaigns" className="text-sky-400 hover:underline">
          ← Campaigns
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">{c.name}</h1>
        <Badge tone={c.state === "enabled" ? "success" : "neutral"}>
          {c.state}
        </Badge>
        <span className="text-xs text-zinc-500">
          Profile <span className="font-mono">{c.profileId}</span> · {currency}
          {country ? ` · ${country}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-zinc-400">Date range</span>
          <div role="group" aria-label="Date range" className="flex gap-1">
            {DAY_OPTIONS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === days ? "primary" : "secondary"}
                onClick={() =>
                  navigate({
                    to: "/campaigns/$id",
                    params: { id },
                    search: { days: option },
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

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <Badge tone={profitStatus.tone}>{profitStatus.label}</Badge>
        <span>
          {hasActivity && estimatedProfit !== null
            ? `${formatMoney(c.totals.estimatedAdProfit, currency)} estimated ad profit`
            : `Selected ${days}-day window`}
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
          className="flex border-b border-zinc-800"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm ${
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
            <MetricsTable rows={campaign.data[tab]} currency={currency} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
