import type { ReactNode } from "react";
import { Flag } from "./flag";
import { TimeframeSelect } from "./timeframe-select";
import { Badge } from "./ui/badge";
import { countryNameForCode } from "../lib/marketplaces";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";
import type { ProfitStatus } from "../lib/campaign-profit";
import { selectedWindowLabel, type TimeframeOption } from "../lib/timeframe";

export interface CampaignHeaderProps {
  name: string;
  state: string;
  /** Marketplace of the owning profile; absent until profiles have loaded. */
  countryCode?: string;
  currency: string;
  profileId: string;
  amazonConsoleUrl: string | null;
  profitStatus: ProfitStatus;
  estimatedAdProfit: string | null;
  hasActivity: boolean;
  dateRange: { start: string; end: string };
  dataCurrentThrough: string;
  days: TimeframeOption;
  onDaysChange: (window: TimeframeOption) => void;
  /** Guarded action buttons rendered at the right of the toolbar. */
  controls?: ReactNode;
}

/**
 * Campaign detail header, in four tiers of decreasing importance: identity and
 * the date range, then a toolbar pairing the profit verdict with the guarded
 * actions, then reference metadata as small print. The title truncates so a
 * long auto-generated campaign name cannot reflow the badge or the controls.
 */
export function CampaignHeader({
  name,
  state,
  countryCode,
  currency,
  profileId,
  amazonConsoleUrl,
  profitStatus,
  estimatedAdProfit,
  hasActivity,
  dateRange,
  dataCurrentThrough,
  days,
  onDaysChange,
  controls,
}: CampaignHeaderProps) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-bold tracking-tight text-zinc-100">
          {countryCode ? (
            <span className="shrink-0" title={countryNameForCode(countryCode)}>
              <Flag countryCode={countryCode} />
            </span>
          ) : null}
          <span className="truncate" title={name}>
            {name}
          </span>
        </h1>
        <Badge
          className="shrink-0"
          tone={state === "enabled" ? "success" : "neutral"}
        >
          {state}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="text-sm text-zinc-400">Date range</span>
          <TimeframeSelect value={days} onChange={onDaysChange} />
        </div>
      </div>

      {/* min-h matches the rename input, so opening it shifts nothing below. */}
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-y border-zinc-800 py-1.5">
        <Badge tone={profitStatus.tone}>{profitStatus.label}</Badge>
        <p className="text-sm text-zinc-400">
          {hasActivity && estimatedAdProfit !== null ? (
            <>
              <span className="font-display text-base font-semibold text-zinc-100">
                {formatMoney(estimatedAdProfit, currency)}
              </span>{" "}
              estimated ad profit
            </>
          ) : (
            selectedWindowLabel(days)
          )}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {controls}
          {amazonConsoleUrl ? (
            <a
              href={amazonConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sky-400 hover:underline"
            >
              Open in Amazon Ads ↗
            </a>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
        <span aria-hidden="true"> · </span>
        data through {formatDateTime(dataCurrentThrough)}
        {countryCode ? (
          <>
            <span aria-hidden="true"> · </span>
            {countryNameForCode(countryCode)}
          </>
        ) : null}
        <span aria-hidden="true"> · </span>
        {currency}
        <span aria-hidden="true"> · </span>
        <span title={profileId}>Profile …{profileId.slice(-4)}</span>
      </p>
    </header>
  );
}
