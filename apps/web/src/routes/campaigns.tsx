import { Link } from "@tanstack/react-router";
import { useCampaigns } from "../api/endpoints";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import {
  getCampaignProfitStatus,
  hasCampaignActivity,
  type ProfitStatus,
} from "../lib/campaign-profit";
import { formatAcos, formatCount, formatMoney } from "../lib/format";

const PROFITABILITY_DAYS = 7;

function ProfitabilityResult({
  status,
  amount,
  currency,
  economicsMissing,
  hasActivity,
}: {
  status: ProfitStatus;
  amount: string | null;
  currency: string;
  economicsMissing: boolean;
  hasActivity: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={status.tone}>{status.label}</Badge>
      <span className="text-xs text-zinc-400">
        {hasActivity && amount !== null
          ? formatMoney(amount, currency)
          : economicsMissing
            ? "Missing economics"
            : "—"}
      </span>
    </div>
  );
}

export function CampaignsPage() {
  const campaigns = useCampaigns(PROFITABILITY_DAYS);

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
                <Th className="hidden md:table-cell">
                  {PROFITABILITY_DAYS}-day profit
                </Th>
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
                const currency = c.profitability.currency;
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
