import { describe, expect, it } from "vitest";
import { buildDailyProfitPoints } from "./kdp-daily-profit-chart";

/**
 * Data shaping for the KDP daily profit chart (/kdp-history organic tab):
 * per-day numbers plus the running profit total.
 */

describe("buildDailyProfitPoints", () => {
  it("sums profit into the cumulative line across days", () => {
    const points = buildDailyProfitPoints([
      {
        date: "2026-08-01",
        adSpend: "10.0000",
        adRoyalty: "6.8000",
        organicRoyalty: "1.2000",
        totalRoyalty: "8.0000",
        profit: "-2.0000",
      },
      {
        date: "2026-08-02",
        adSpend: "4.0000",
        adRoyalty: "3.0000",
        organicRoyalty: "7.0000",
        totalRoyalty: "10.0000",
        profit: "6.0000",
      },
    ]);

    expect(points[0]).toMatchObject({ profit: -2, cumulative: -2 });
    expect(points[1]).toMatchObject({ profit: 6, cumulative: 4 });
    expect(points[1]?.adRoyalty).toBe(3);
    expect(points[1]?.organicRoyalty).toBe(7);
    expect(points[1]?.adSpend).toBe(4);
  });

  it("carries the cumulative total forward across days without an import", () => {
    const points = buildDailyProfitPoints([
      {
        date: "2026-08-01",
        adSpend: "1.0000",
        adRoyalty: "2.0000",
        organicRoyalty: "3.0000",
        totalRoyalty: "5.0000",
        profit: "4.0000",
      },
      {
        date: "2026-08-02",
        adSpend: "1.0000",
        adRoyalty: "0.0000",
        organicRoyalty: null,
        totalRoyalty: null,
        profit: null,
      },
    ]);

    expect(points[1]).toMatchObject({ profit: null, cumulative: 4 });
  });
});
