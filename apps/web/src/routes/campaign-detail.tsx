import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { MetricTotals } from "@amazon-king/contracts";
import { useCampaign, useProfiles } from "../api/endpoints";
import { Badge } from "../components/ui/badge";
import { Card, CardBody } from "../components/ui/card";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatAcos, formatCount, formatMoney } from "../lib/format";

type Tab = "adGroups" | "targets" | "searchTerms";

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
  const campaign = useCampaign(id);
  const profiles = useProfiles();
  const [tab, setTab] = useState<Tab>("adGroups");

  if (campaign.isPending) return <Loading />;
  if (campaign.error) return <ErrorState error={campaign.error} />;
  if (!campaign.data) return null;

  const c = campaign.data.campaign;
  const currency =
    (profiles.data ?? []).find((p) => p.profileId === c.profileId)
      ?.currencyCode ?? "USD";

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
        </span>
      </div>

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
