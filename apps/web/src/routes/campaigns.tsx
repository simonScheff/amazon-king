import { Link } from "@tanstack/react-router";
import { useCampaigns, useProfiles } from "../api/endpoints";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatAcos, formatCount, formatMoney } from "../lib/format";

export function CampaignsPage() {
  const campaigns = useCampaigns();
  const profiles = useProfiles();
  const currencyByProfile = new Map(
    (profiles.data ?? []).map((p) => [p.profileId, p.currencyCode]),
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-zinc-100">Campaigns</h1>
      <Card>
        {campaigns.isPending ? (
          <Loading />
        ) : campaigns.error ? (
          <ErrorState error={campaigns.error} />
        ) : campaigns.data.length === 0 ? (
          <EmptyState>
            No campaigns imported yet. Connect Amazon Ads and run a sync first.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Profile</Th>
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
              {campaigns.data.map((c) => {
                const currency = currencyByProfile.get(c.profileId) ?? "USD";
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
                        className="text-sky-400 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </Td>
                    <Td className="font-mono text-xs text-zinc-500">
                      {c.profileId}
                    </Td>
                    <Td>
                      <Badge
                        tone={c.state === "enabled" ? "success" : "neutral"}
                      >
                        {c.state}
                      </Badge>
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
