import type { MetricWindow } from "@amazon-king/contracts";

/**
 * Shared UTC date-window helpers for the read service: the trailing-window
 * resolution every metric screen uses (facts land a day late, so a 1-day
 * window means the latest complete day) and the immediately-preceding
 * comparison window behind period-over-period totals.
 */

export const DAY_MS = 86_400_000;
export const MAX_DAYS = 90;

export function utcToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateRange(
  now: Date,
  window: MetricWindow,
): { start: string; end: string } {
  const end = utcToday(now);
  if (window === "mtd") {
    const start = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1),
    );
    return { start: isoDay(start), end: isoDay(end) };
  }
  const clamped = Math.min(Math.max(Math.trunc(window) || 30, 1), MAX_DAYS);
  // Facts land a day late (metrics sync imports yesterday), so a 1-day window
  // means the latest complete day, not the empty in-progress today.
  const endDay = clamped === 1 ? new Date(end.getTime() - DAY_MS) : end;
  const start = new Date(endDay.getTime() - (clamped - 1) * DAY_MS);
  return { start: isoDay(start), end: isoDay(endDay) };
}

/** Comparison window for dashboard period-over-period totals. */
export function previousDateRange(
  now: Date,
  window: MetricWindow,
): { start: string; end: string } {
  if (window === "mtd") {
    const end = utcToday(now);
    const dayOfMonth = end.getUTCDate();
    // Day 0 of this month is the last day of the previous month.
    const prevMonthEnd = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0),
    );
    const prevStart = new Date(
      Date.UTC(prevMonthEnd.getUTCFullYear(), prevMonthEnd.getUTCMonth(), 1),
    );
    const prevEndDay = Math.min(dayOfMonth, prevMonthEnd.getUTCDate());
    const prevEnd = new Date(
      Date.UTC(
        prevMonthEnd.getUTCFullYear(),
        prevMonthEnd.getUTCMonth(),
        prevEndDay,
      ),
    );
    return { start: isoDay(prevStart), end: isoDay(prevEnd) };
  }
  const clamped = Math.min(Math.max(Math.trunc(window) || 30, 1), MAX_DAYS);
  const { start } = dateRange(now, window);
  // Compute directly instead of composing dateRange: dateRange's 1-day
  // special case (end yesterday) would otherwise push the previous window a
  // day too far back.
  const prevEnd = new Date(
    new Date(`${start}T00:00:00.000Z`).getTime() - DAY_MS,
  );
  const prevStart = new Date(prevEnd.getTime() - (clamped - 1) * DAY_MS);
  return { start: isoDay(prevStart), end: isoDay(prevEnd) };
}

/** Every ISO day in [start, end], ascending. */
export function dayList(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(isoDay(cursor));
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return days;
}
