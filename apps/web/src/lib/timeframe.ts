import type { MetricWindow } from "@amazon-king/contracts";

export const TIMEFRAME_OPTIONS = [7, 14, 30, 60, "mtd"] as const;
export type TimeframeOption = (typeof TIMEFRAME_OPTIONS)[number];
export const DEFAULT_TIMEFRAME: TimeframeOption = 30;

export function isTimeframeOption(value: unknown): value is TimeframeOption {
  return (TIMEFRAME_OPTIONS as readonly unknown[]).includes(value);
}

/** Keep `"mtd"` or a positive number from a URL search param; drop junk. */
export function parseDaysSearch(value: unknown): MetricWindow | undefined {
  if (value === "mtd") return "mtd";
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}

export function resolveTimeframe(
  value: unknown,
  fallback: TimeframeOption = DEFAULT_TIMEFRAME,
): TimeframeOption {
  if (isTimeframeOption(value)) return value;
  return fallback;
}

export function timeframeButtonLabel(window: TimeframeOption): string {
  return window === "mtd" ? "MTD" : `${window}d`;
}

export function timeframeButtonAriaLabel(window: TimeframeOption): string {
  return window === "mtd" ? "Month to date" : `${window}d`;
}

export function previousDeltaLabel(window: MetricWindow): string {
  return window === "mtd" ? "vs previous MTD" : `vs previous ${window}d`;
}

export function selectedWindowLabel(window: MetricWindow): string {
  return window === "mtd"
    ? "Selected month-to-date window"
    : `Selected ${window}-day window`;
}

/** Compact qualifier for headings and table labels: "7-day" or "MTD". */
export function windowQualifier(window: MetricWindow): string {
  return window === "mtd" ? "MTD" : `${window}-day`;
}
