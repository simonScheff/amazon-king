import { Badge } from "./ui/badge";
import { formatMoney } from "../lib/format";
import type { ProfitStatus } from "../lib/campaign-profit";

/** Badge + amount used by the campaigns and search terms profit columns. */
export function ProfitabilityResult({
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
