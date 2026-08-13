import type { MetricTotals } from "@amazon-king/contracts";

export type ProfitStatusTone = "neutral" | "success" | "warning" | "danger";

export interface ProfitStatus {
  label:
    | "No activity"
    | "Profit unavailable"
    | "Profitable"
    | "Not profitable"
    | "Break-even";
  tone: ProfitStatusTone;
}

export function hasCampaignActivity(totals: MetricTotals): boolean {
  return (
    totals.impressions > 0 ||
    totals.clicks > 0 ||
    totals.orders > 0 ||
    Number(totals.cost) > 0 ||
    Number(totals.sales) > 0
  );
}

export function getCampaignProfitStatus(
  totals: MetricTotals,
  economicsMissing: boolean,
  estimatedAdProfit: string | null,
): ProfitStatus {
  if (!hasCampaignActivity(totals)) {
    return { label: "No activity", tone: "neutral" };
  }
  if (economicsMissing || estimatedAdProfit === null) {
    return { label: "Profit unavailable", tone: "warning" };
  }
  const profit = Number(estimatedAdProfit);
  if (profit > 0) return { label: "Profitable", tone: "success" };
  if (profit < 0) return { label: "Not profitable", tone: "danger" };
  return { label: "Break-even", tone: "neutral" };
}
