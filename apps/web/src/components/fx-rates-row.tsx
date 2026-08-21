import type { FxRatesStatus } from "@amazon-king/contracts";
import { Badge } from "./ui/badge";
import { formatDate } from "../lib/format";

const FX_ERROR_MAX = 140;

function truncateError(message: string): string {
  return message.length > FX_ERROR_MAX
    ? `${message.slice(0, FX_ERROR_MAX)}…`
    : message;
}

/**
 * FX sync health (docs/fx-rates-all-market-plan.md, decision 7).
 * Workspace-level, so it renders regardless of the selected market — the
 * owner must see at a glance whether converted all-market numbers are
 * trustworthy. Shown on the overview's Sync status card and next to the
 * manual "Sync rates now" control on Settings → Profiles.
 */
export function FxRatesRow({
  fxRates,
}: {
  fxRates: FxRatesStatus | undefined;
}) {
  if (!fxRates) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-zinc-500">FX rates:</span>
        <span className="text-zinc-500">—</span>
      </div>
    );
  }

  let badge: {
    tone: "success" | "warning" | "danger" | "info" | "neutral";
    label: string;
    title?: string;
  };
  if (fxRates.lastRunState === "running") {
    badge = { tone: "info", label: "syncing…" };
  } else if (fxRates.lastRunState === "failed") {
    badge = {
      tone: "danger",
      label: "sync failed",
      title: fxRates.lastError ?? undefined,
    };
  } else if (fxRates.lastRunState === "never_run") {
    badge = { tone: "neutral", label: "not synced yet" };
  } else if (fxRates.stale) {
    badge = {
      tone: "warning",
      label: `stale · rates through ${formatDate(fxRates.latestRateDate)}`,
    };
  } else {
    badge = {
      tone: "success",
      label: `up to date through ${formatDate(fxRates.latestRateDate)}`,
    };
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500">FX rates:</span>
        <Badge tone={badge.tone} title={badge.title}>
          {badge.label}
        </Badge>
      </div>
      {fxRates.lastRunState === "failed" && fxRates.lastError ? (
        <p className="text-xs text-red-400">
          {truncateError(fxRates.lastError)}
        </p>
      ) : null}
    </div>
  );
}
