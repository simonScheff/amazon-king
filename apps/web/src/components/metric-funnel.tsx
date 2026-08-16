import { EmptyState } from "./states";
import { formatCount } from "../lib/format";

export interface FunnelStage {
  label: string;
  value: number;
  /** Name of the rate from the previous stage into this one (e.g. CTR, CVR). */
  rateLabel?: string;
}

const STAGE_COLORS = ["#d0bcff", "#93c5fd", "#4edea3"];

/**
 * Window-total conversion funnel (impressions → clicks → orders). Bar widths
 * scale to the first stage with a small minimum so late stages stay visible;
 * each transition is named explicitly (CTR, CVR) because raw proportions
 * would make the late stages unreadable.
 */
export function MetricFunnel({ stages }: { stages: readonly FunnelStage[] }) {
  const first = stages[0]?.value ?? 0;
  if (stages.length === 0 || first <= 0) {
    return <EmptyState>No funnel data in this window yet.</EmptyState>;
  }
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversion funnel">
      {stages.map((stage, index) => {
        const previous = index > 0 ? stages[index - 1]! : null;
        const rate =
          previous !== null && previous.value > 0
            ? stage.value / previous.value
            : null;
        const width =
          stage.value > 0 ? Math.max((stage.value / first) * 100, 2) : 0;
        return (
          <li key={stage.label}>
            {previous !== null ? (
              <p className="mb-1 text-xs text-zinc-500">
                {stage.rateLabel ?? "Rate"}:{" "}
                {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-sm text-zinc-400">
                {stage.label}
              </span>
              <div className="h-6 flex-1 rounded bg-zinc-800">
                <div
                  className="h-6 rounded"
                  style={{
                    width: `${width}%`,
                    backgroundColor: STAGE_COLORS[index % STAGE_COLORS.length],
                  }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-sm font-medium text-zinc-100">
                {formatCount(stage.value)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
