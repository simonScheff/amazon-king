import type { SpendBreakdown } from "@amazon-king/contracts";

/**
 * Client-side aggregation for the /spend explorer tabs: composition chart
 * series (top entities + an "Everything else" band), ISO-week bucketing and
 * weekly spend ranks for the movers bump chart, and the this-vs-previous
 * mover rows. All math here is display-only — the API's string-encoded
 * decimals are converted to Number for rendering, never sent back.
 */

export const SPEND_SERIES_COLORS = [
  "#a078ff",
  "#4edea3",
  "#ffb95f",
  "#93c5fd",
  "#f472b6",
  "#d0bcff",
  "#f87171",
  "#5eead4",
] as const;

/** Gray band for the merged remainder ("Everything else"). */
export const OTHER_SERIES_COLOR = "#71717a";
export const OTHER_SERIES_NAME = "Everything else";

/** Areas above this count fold into the "Everything else" band. */
export const COMPOSITION_MAX_AREAS = 8;
/** Lines above this count are dropped from the bump chart. */
export const MOVERS_MAX_LINES = 8;
/** |Change| above this fraction marks a mover Rising/Fading instead of Stable. */
export const MOVER_CHANGE_THRESHOLD = 0.1;
/** Sparkline length in days on the movers table. */
export const SPARKLINE_DAYS = 14;

/** Days in the window the response covers, inclusive. */
export function windowDays(data: SpendBreakdown): number {
  const start = Date.parse(`${data.dateRange.start}T00:00:00Z`);
  const end = Date.parse(`${data.dateRange.end}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Composition tab
// ---------------------------------------------------------------------------

export interface CompositionArea {
  /** Entity id, or "other" for the merged remainder band. */
  key: string;
  name: string;
  color: string;
  /** Window spend total (for the legend chips). */
  totalSpend: number;
}

export type CompositionPoint = { date: string } & Record<
  string,
  number | string
>;

/**
 * 100%-stacked composition series: one area per top entity (up to
 * COMPOSITION_MAX_AREAS), everything past that plus the API's `other` bucket
 * merged into a single gray "Everything else" band so the stack still sums
 * to the day's total.
 */
export function buildComposition(data: SpendBreakdown): {
  areas: CompositionArea[];
  points: CompositionPoint[];
} {
  const kept = data.entities.slice(0, COMPOSITION_MAX_AREAS);
  const folded = data.entities.slice(COMPOSITION_MAX_AREAS);
  const areas: CompositionArea[] = kept.map((entity, index) => ({
    key: entity.id,
    name: entity.name,
    color: SPEND_SERIES_COLORS[index % SPEND_SERIES_COLORS.length]!,
    totalSpend: Number(entity.spend),
  }));

  const dates = (data.entities[0]?.daily ?? data.other.daily).map(
    (point) => point.date,
  );
  const hasOther =
    folded.length > 0 ||
    Number(data.other.spend) > 0 ||
    data.other.daily.some((point) => Number(point.spend) > 0);
  if (hasOther) {
    areas.push({
      key: "other",
      name: OTHER_SERIES_NAME,
      color: OTHER_SERIES_COLOR,
      totalSpend:
        folded.reduce((sum, entity) => sum + Number(entity.spend), 0) +
        Number(data.other.spend),
    });
  }

  const points = dates.map((date, dayIndex) => {
    const point: CompositionPoint = { date };
    for (const entity of kept) {
      point[entity.id] = Number(entity.daily[dayIndex]?.spend ?? 0);
    }
    if (hasOther) {
      point.other =
        folded.reduce(
          (sum, entity) => sum + Number(entity.daily[dayIndex]?.spend ?? 0),
          0,
        ) + Number(data.other.daily[dayIndex]?.spend ?? 0);
    }
    return point;
  });
  return { areas, points };
}

/** Top entity's share of window spend, for the stat line above the chart. */
export function topEntityShare(
  data: SpendBreakdown,
): { name: string; share: number } | null {
  const top = data.entities[0];
  const total = Number(data.totals.spend);
  if (!top || total <= 0) return null;
  return { name: top.name, share: Number(top.spend) / total };
}

// ---------------------------------------------------------------------------
// Movers tab: ISO weeks and weekly ranks
// ---------------------------------------------------------------------------

export interface WeekInfo {
  /** Sortable key: ISO week-year + padded week ("2026-W07"). */
  key: string;
  /** Short axis label ("W07"). */
  label: string;
}

/** ISO 8601 week of an ISO date (Monday-start), as a sortable key + label. */
export function isoWeek(date: string): WeekInfo {
  const day = new Date(`${date}T00:00:00Z`);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  // Thursday of the current week fixes the ISO week-year.
  const thursday = new Date(day.getTime() + (3 - dow) * 86_400_000);
  const weekYear = thursday.getUTCFullYear();
  // ISO week 1 is the week containing January 4.
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const weekOneMonday = jan4.getTime() - jan4Dow * 86_400_000;
  const week =
    Math.floor((thursday.getTime() - weekOneMonday) / (7 * 86_400_000)) + 1;
  const padded = String(week).padStart(2, "0");
  return { key: `${weekYear}-W${padded}`, label: `W${padded}` };
}

interface RankSeries {
  id: string;
  name: string;
  totalSpend: number;
  weeklySpend: Map<string, number>;
}

export interface WeeklyRankLine {
  id: string;
  name: string;
  color: string;
  /** Rank per week (1 = top spender); null for weeks without spend. */
  ranks: (number | null)[];
}

/**
 * Weekly spend ranks for the bump chart. Every ranked series (the top
 * entities plus "Everything else") competes for rank each week, so a line's
 * rank is honest even when only the top few are drawn; weeks without spend
 * leave a gap (null) instead of a rank.
 */
export function buildWeeklyRanks(data: SpendBreakdown): {
  weeks: WeekInfo[];
  lines: WeeklyRankLine[];
  /** Total ranked series — the Y-axis domain is [1, seriesCount]. */
  seriesCount: number;
} {
  const series: RankSeries[] = data.entities.map((entity) => {
    const weeklySpend = new Map<string, number>();
    for (const point of entity.daily) {
      const week = isoWeek(point.date).key;
      weeklySpend.set(week, (weeklySpend.get(week) ?? 0) + Number(point.spend));
    }
    return {
      id: entity.id,
      name: entity.name,
      totalSpend: Number(entity.spend),
      weeklySpend,
    };
  });
  if (Number(data.other.spend) > 0) {
    const weeklySpend = new Map<string, number>();
    for (const point of data.other.daily) {
      const week = isoWeek(point.date).key;
      weeklySpend.set(week, (weeklySpend.get(week) ?? 0) + Number(point.spend));
    }
    series.push({
      id: "other",
      name: OTHER_SERIES_NAME,
      totalSpend: Number(data.other.spend),
      weeklySpend,
    });
  }

  const weekKeys = [
    ...new Set(series.flatMap((entry) => [...entry.weeklySpend.keys()])),
  ].sort();
  const weeks = weekKeys.map((key) => ({ key, label: `${key.slice(5)}` }));

  // Rank per week across every series (competition ranking: ties share the
  // better rank); zero-spend weeks get no rank.
  const rankBySeriesWeek = new Map<string, Map<string, number | null>>();
  for (const entry of series) {
    rankBySeriesWeek.set(entry.id, new Map());
  }
  for (const week of weekKeys) {
    const spends = series.map((entry) => ({
      id: entry.id,
      spend: entry.weeklySpend.get(week) ?? 0,
    }));
    for (const entry of spends) {
      const target = rankBySeriesWeek.get(entry.id)!;
      if (entry.spend <= 0) {
        target.set(week, null);
        continue;
      }
      target.set(
        week,
        1 + spends.filter((other) => other.spend > entry.spend).length,
      );
    }
  }

  const lines = series
    .slice()
    .sort((a, b) => b.totalSpend - a.totalSpend || a.id.localeCompare(b.id))
    .slice(0, MOVERS_MAX_LINES)
    .map((entry, index) => ({
      id: entry.id,
      name: entry.name,
      color:
        entry.id === "other"
          ? OTHER_SERIES_COLOR
          : SPEND_SERIES_COLORS[index % SPEND_SERIES_COLORS.length]!,
      ranks: weekKeys.map(
        (week) => rankBySeriesWeek.get(entry.id)!.get(week) ?? null,
      ),
    }));

  return { weeks, lines, seriesCount: series.length };
}

// ---------------------------------------------------------------------------
// Movers tab: this period vs previous period table
// ---------------------------------------------------------------------------

export type MoverStatus = "new" | "rising" | "fading" | "stable";

export interface MoverRow {
  id: string;
  name: string;
  current: number;
  previous: number;
  /** Fractional change vs the previous window; null when previous was 0. */
  change: number | null;
  status: MoverStatus;
  /** Trailing SPARKLINE_DAYS of the window's daily spend. */
  sparkline: { date: string; spend: number }[];
}

/**
 * Movers table rows, sorted by biggest absolute increase first. Status:
 * "new" when the entity had no previous-window spend, otherwise Rising /
 * Fading past ±MOVER_CHANGE_THRESHOLD and Stable in between.
 */
export function buildMoverRows(data: SpendBreakdown): MoverRow[] {
  return data.entities
    .map((entity) => {
      const current = Number(entity.spend);
      const previous = Number(entity.previousSpend);
      const change = previous === 0 ? null : (current - previous) / previous;
      const status: MoverStatus =
        previous === 0
          ? "new"
          : change !== null && change > MOVER_CHANGE_THRESHOLD
            ? "rising"
            : change !== null && change < -MOVER_CHANGE_THRESHOLD
              ? "fading"
              : "stable";
      return {
        id: entity.id,
        name: entity.name,
        current,
        previous,
        change,
        status,
        sparkline: entity.daily.slice(-SPARKLINE_DAYS).map((point) => ({
          date: point.date,
          spend: Number(point.spend),
        })),
      };
    })
    .sort((a, b) => b.current - b.previous - (a.current - a.previous));
}
