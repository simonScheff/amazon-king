import { useId } from "react";
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
  maxCpc,
}: {
  status: ProfitStatus;
  amount: string | null;
  currency: string;
  economicsMissing: boolean;
  hasActivity: boolean;
  /** Enables the campaign-only hover/focus tooltip; null means not configured. */
  maxCpc?: string | null;
}) {
  const tooltipId = useId();
  const showsMaxCpc = maxCpc !== undefined;

  return (
    <div
      className={`flex flex-col items-start gap-1 ${
        showsMaxCpc
          ? "group relative w-fit cursor-help rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          : ""
      }`}
      tabIndex={showsMaxCpc ? 0 : undefined}
      aria-describedby={showsMaxCpc ? tooltipId : undefined}
    >
      <Badge tone={status.tone}>{status.label}</Badge>
      <span className="text-xs text-zinc-400">
        {hasActivity && amount !== null
          ? formatMoney(amount, currency)
          : economicsMissing
            ? "Missing economics"
            : "—"}
      </span>
      {showsMaxCpc ? (
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-100 shadow-lg group-hover:block group-focus:block"
        >
          Max CPC:{" "}
          {maxCpc === null ? "Not configured" : formatMoney(maxCpc, currency)}
        </span>
      ) : null}
    </div>
  );
}
