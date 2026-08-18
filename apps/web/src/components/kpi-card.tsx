import type { ReactNode } from "react";
import { formatPercentChange } from "../lib/format";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Muted text on the same row as `value` (e.g. Orders `48 units`). */
  suffix?: ReactNode;
  /** Native tooltip on the suffix. */
  suffixTitle?: string;
  /** When true, show an "economics missing" placeholder instead of a value. */
  missing?: boolean;
  /**
   * Period-over-period change as a fraction (0.12 = +12%); null/undefined
   * hides the delta (no previous-period base).
   */
  delta?: number | null;
  /** Whether an increase is the good outcome. False for spend/ACoS. */
  deltaGoodWhenUp?: boolean;
  /** Comparison label shown after the delta, e.g. "vs previous 7d". */
  deltaLabel?: string;
  /** Series color shown next to the label when the card toggles a chart line. */
  swatch?: string;
  /** Whether the linked chart series is currently visible. */
  active?: boolean;
  /** When set, the card becomes a toggle button for a chart series. */
  onToggle?: () => void;
}

export function KpiCard({
  label,
  value,
  suffix,
  suffixTitle,
  missing = false,
  delta,
  deltaGoodWhenUp = true,
  deltaLabel,
  swatch,
  active = true,
  onToggle,
}: KpiCardProps) {
  const className = [
    "rounded-lg border px-5 py-4 text-left shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-all",
    active
      ? "border-zinc-800 bg-zinc-900 hover:border-sky-800 hover:shadow-[0_8px_24px_rgba(0,0,0,0.45),0_0_20px_rgba(139,92,246,0.12)]"
      : "border-zinc-800/60 bg-zinc-900/50 opacity-55 hover:border-zinc-700 hover:opacity-80",
    onToggle ? "cursor-pointer" : "",
  ].join(" ");

  const showDelta = !missing && delta !== null && delta !== undefined;
  const deltaTone = !showDelta
    ? ""
    : Math.abs(delta) < 0.0005
      ? "text-zinc-500"
      : delta > 0 === deltaGoodWhenUp
        ? "text-emerald-300"
        : "text-red-300";

  const body = (
    <>
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {swatch ? (
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: active ? swatch : "#52525b" }}
          />
        ) : null}
        {label}
      </p>
      {missing ? (
        <p className="mt-1.5 text-sm text-zinc-500">
          — <span className="text-xs">economics missing</span>
        </p>
      ) : (
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className="font-display text-2xl font-semibold tracking-tight text-zinc-100">
            {value}
          </span>
          {suffix ? (
            <span className="text-xs text-zinc-500" title={suffixTitle}>
              {suffix}
            </span>
          ) : null}
        </p>
      )}
      {showDelta ? (
        <p className={`mt-1 text-xs font-medium ${deltaTone}`}>
          <span aria-hidden>{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"}</span>{" "}
          {formatPercentChange(delta)}
          {deltaLabel ? (
            <span className="font-normal text-zinc-500"> {deltaLabel}</span>
          ) : null}
        </p>
      ) : null}
    </>
  );

  if (onToggle) {
    return (
      <button
        type="button"
        aria-pressed={active}
        title={
          active ? `Hide ${label} on the chart` : `Show ${label} on the chart`
        }
        onClick={onToggle}
        className={className}
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
