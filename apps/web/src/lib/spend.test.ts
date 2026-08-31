import { describe, expect, it } from "vitest";
import type { SpendBreakdown } from "@amazon-king/contracts";
import {
  buildComposition,
  buildMoverRows,
  buildWeeklyRanks,
  isoWeek,
  topEntityShare,
  windowDays,
  OTHER_SERIES_COLOR,
} from "./spend";

/**
 * Client-side spend explorer aggregation: composition series, ISO-week
 * bucketing and weekly ranks, mover rows. The fixtures mimic the API's
 * zero-filled daily series over a 14-day window.
 */

const DATES = Array.from(
  { length: 14 },
  (_, index) => `2026-08-${String(index + 2).padStart(2, "0")}`,
); // Aug 2..15: exactly two ISO weeks (W32: 3–9, W33: 10–16)

function daily(spendByDate: Record<string, number>) {
  return DATES.map((date) => ({
    date,
    spend: (spendByDate[date] ?? 0).toFixed(4),
  }));
}

function entity(
  id: string,
  spendByDate: Record<string, number>,
  previousSpend = 0,
) {
  const total = Object.values(spendByDate).reduce((a, b) => a + b, 0);
  return {
    id,
    name: `Name ${id}`,
    spend: total.toFixed(4),
    sales: "0.0000",
    orders: 0,
    acos: null,
    previousSpend: previousSpend.toFixed(4),
    daily: daily(spendByDate),
  };
}

function breakdown(
  entities: ReturnType<typeof entity>[],
  otherSpend = 0,
): SpendBreakdown {
  const total = entities.reduce((sum, e) => sum + Number(e.spend), 0);
  return {
    grain: "campaign",
    dateRange: { start: DATES[0]!, end: DATES.at(-1)! },
    previousDateRange: { start: "2026-07-19", end: "2026-08-01" },
    currency: "USD",
    ratesAvailable: true,
    totals: {
      spend: (total + otherSpend).toFixed(4),
      sales: "0.0000",
      previousSpend: entities
        .reduce((sum, e) => sum + Number(e.previousSpend), 0)
        .toFixed(4),
    },
    entities,
    other: {
      spend: otherSpend.toFixed(4),
      daily: daily(otherSpend > 0 ? { "2026-08-05": otherSpend } : {}),
    },
  };
}

describe("isoWeek", () => {
  it("computes ISO week keys and labels, Monday-start", () => {
    expect(isoWeek("2026-08-03")).toEqual({ key: "2026-W32", label: "W32" }); // Monday
    expect(isoWeek("2026-08-09")).toEqual({ key: "2026-W32", label: "W32" }); // Sunday
    expect(isoWeek("2026-08-10")).toEqual({ key: "2026-W33", label: "W33" });
  });

  it("assigns year-boundary days to the right ISO week-year", () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeek("2026-01-01")).toEqual({ key: "2026-W01", label: "W01" });
    // 2025-12-29 (Monday) belongs to ISO 2026-W01.
    expect(isoWeek("2025-12-29")).toEqual({ key: "2026-W01", label: "W01" });
  });
});

describe("windowDays", () => {
  it("counts the inclusive window length", () => {
    expect(windowDays(breakdown([]))).toBe(14);
  });
});

describe("buildComposition", () => {
  it("keeps the top entities and merges the rest with other into one band", () => {
    const entities = Array.from({ length: 10 }, (_, index) =>
      entity(`e${index + 1}`, { "2026-08-05": 10 - index }),
    );
    const data = breakdown(entities, 5);

    const { areas, points } = buildComposition(data);

    // 8 kept areas + the merged "Everything else" band.
    expect(areas).toHaveLength(9);
    expect(areas.at(-1)).toMatchObject({
      key: "other",
      color: OTHER_SERIES_COLOR,
    });
    // Folded entities 9+10 (spend 2 + 1) plus the API other bucket (5).
    expect(areas.at(-1)!.totalSpend).toBe(8);
    const day = points.find((point) => point.date === "2026-08-05")!;
    expect(day.other).toBe(8);
    expect(day.e1).toBe(10);
  });

  it("omits the other band when everything is shown", () => {
    const data = breakdown([entity("e1", { "2026-08-05": 7 })]);

    const { areas, points } = buildComposition(data);

    expect(areas).toHaveLength(1);
    expect(points.find((point) => point.date === "2026-08-05")!.other).toBe(
      undefined,
    );
  });
});

describe("topEntityShare", () => {
  it("reports the top entity's share of window spend", () => {
    const data = breakdown(
      [entity("e1", { "2026-08-05": 30 }), entity("e2", { "2026-08-05": 10 })],
      10,
    );

    expect(topEntityShare(data)).toEqual({ name: "Name e1", share: 0.6 });
  });

  it("is null without spend", () => {
    expect(topEntityShare(breakdown([]))).toBeNull();
  });
});

describe("buildWeeklyRanks", () => {
  it("ranks every series per week, including other, with gaps for zero weeks", () => {
    const data = breakdown(
      [
        entity("a", { "2026-08-05": 10, "2026-08-12": 4 }),
        entity("b", { "2026-08-05": 6, "2026-08-12": 8 }),
        entity("c", { "2026-08-12": 20 }), // new in the second week
      ],
      3, // other spends only in week 1
    );

    const { weeks, lines, seriesCount } = buildWeeklyRanks(data);

    // Aug 2 is a Sunday, so the window spans three ISO weeks; the leading
    // week has no spend and leaves every line at null.
    expect(weeks.map((week) => week.key)).toEqual([
      "2026-W31",
      "2026-W32",
      "2026-W33",
    ]);
    expect(seriesCount).toBe(4); // 3 entities + other compete for rank
    // a: rank 1 in W32 (10 > 6 > 3), rank 3 in W33 (20 > 8 > 4).
    expect(lines.find((line) => line.id === "a")!.ranks).toEqual([null, 1, 3]);
    expect(lines.find((line) => line.id === "b")!.ranks).toEqual([null, 2, 2]);
    // c has no spend before W33 → null gaps, then rank 1.
    expect(lines.find((line) => line.id === "c")!.ranks).toEqual([
      null,
      null,
      1,
    ]);
  });

  it("caps the drawn lines at the top spenders", () => {
    const entities = Array.from({ length: 10 }, (_, index) =>
      entity(`e${index + 1}`, { "2026-08-05": 100 - index }),
    );

    const { lines, seriesCount } = buildWeeklyRanks(breakdown(entities));

    expect(lines).toHaveLength(8);
    expect(lines[0]!.id).toBe("e1");
    expect(seriesCount).toBe(10);
  });
});

describe("buildMoverRows", () => {
  it("classifies new/rising/fading/stable and sorts by biggest increase", () => {
    const data = breakdown([
      entity("stable", { "2026-08-05": 102 }, 100), // +2%
      entity("new", { "2026-08-05": 40 }, 0),
      entity("rising", { "2026-08-05": 64 }, 40), // +60%
      entity("fading", { "2026-08-05": 18 }, 30), // −40%
    ]);

    const rows = buildMoverRows(data);

    expect(rows.map((row) => row.id)).toEqual([
      "new",
      "rising",
      "stable",
      "fading",
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("new")).toMatchObject({ status: "new", change: null });
    expect(byId.get("rising")!.status).toBe("rising");
    expect(byId.get("rising")!.change).toBeCloseTo(0.6);
    expect(byId.get("fading")!.status).toBe("fading");
    expect(byId.get("stable")!.status).toBe("stable");
    // Sparkline is the trailing 14 days of the window.
    expect(byId.get("rising")!.sparkline).toHaveLength(14);
  });
});
