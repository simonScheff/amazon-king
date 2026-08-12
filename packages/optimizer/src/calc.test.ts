import { describe, expect, it } from "vitest";
import {
  acos,
  aggregateWindow,
  breakEvenCpc,
  clampBidMultiplier,
  conversionRate,
  estimatedAdProfit,
  MixedCurrencyError,
  proposedBid,
  roas,
  smoothedConversionRate,
  type DailyMetricRow,
} from "./calc.js";

describe("acos", () => {
  it("computes cost / sales", () => {
    expect(acos(20_000_000, 80_000_000)).toBe(0.25);
  });

  it("returns null when sales are zero (never Infinity)", () => {
    expect(acos(20_000_000, 0)).toBeNull();
  });

  it("returns 0 when cost is zero", () => {
    expect(acos(0, 80_000_000)).toBe(0);
  });

  it("throws on negative inputs", () => {
    expect(() => acos(-1, 100)).toThrow(RangeError);
  });
});

describe("roas", () => {
  it("computes sales / cost", () => {
    expect(roas(80_000_000, 20_000_000)).toBe(4);
  });

  it("returns null when cost is zero", () => {
    expect(roas(80_000_000, 0)).toBeNull();
  });
});

describe("conversionRate", () => {
  it("computes orders / clicks", () => {
    expect(conversionRate(5, 100)).toBe(0.05);
  });

  it("returns null when clicks are zero", () => {
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe("estimatedAdProfit", () => {
  it("computes orders x royalty - cost", () => {
    expect(estimatedAdProfit(10, 4_000_000, 20_000_000)).toBe(20_000_000);
  });

  it("can be negative", () => {
    expect(estimatedAdProfit(1, 4_000_000, 20_000_000)).toBe(-16_000_000);
  });
});

describe("breakEvenCpc", () => {
  it("computes cvr x royalty, rounded to 4 dp", () => {
    expect(breakEvenCpc(0.05, 4_000_000)).toBe(200_000); // $0.20
  });

  it("rounds half-up to 4 dp", () => {
    // 0.123456789 x 1_000_000 = 123456.789 micros -> $0.1235
    expect(breakEvenCpc(0.123456789, 1_000_000)).toBe(123_500);
  });

  it("rejects out-of-range cvr", () => {
    expect(() => breakEvenCpc(1.5, 1_000_000)).toThrow(RangeError);
  });
});

describe("smoothedConversionRate", () => {
  it("returns the prior rate at zero volume", () => {
    expect(smoothedConversionRate(0, 0)).toBe(0.05);
  });

  it("pulls low-volume observations toward the prior", () => {
    // 1 order / 10 clicks observed (0.10), smoothed: (1 + 1) / (10 + 20) = 0.0667
    const smoothed = smoothedConversionRate(10, 1);
    expect(smoothed).toBeCloseTo(2 / 30, 10);
    expect(smoothed).toBeLessThan(0.1);
    expect(smoothed).toBeGreaterThan(0.05);
  });

  it("converges to the observed rate at high volume", () => {
    const smoothed = smoothedConversionRate(10_000, 1_000);
    expect(smoothed).toBeCloseTo(0.1, 3);
  });

  it("respects custom prior parameters", () => {
    // (0 + 0.10 x 50) / (0 + 50) = 0.10
    expect(smoothedConversionRate(0, 0, 0.1, 50)).toBe(0.1);
  });

  it("never exceeds a plausible range for zero-order terms", () => {
    expect(smoothedConversionRate(20, 0)).toBeCloseTo(1 / 40, 10);
  });
});

describe("clampBidMultiplier", () => {
  it("passes values inside the band through", () => {
    expect(clampBidMultiplier(1.05)).toBe(1.05);
  });

  it("clamps to the ±15% defaults", () => {
    expect(clampBidMultiplier(2)).toBe(1.15);
    expect(clampBidMultiplier(0.1)).toBe(0.85);
  });

  it("respects custom bounds", () => {
    expect(clampBidMultiplier(1.2, 0.9, 1.1)).toBe(1.1);
  });
});

describe("proposedBid", () => {
  const base = {
    currentBidMicros: 1_000_000, // $1.00
    targetAcos: 0.3,
    observedAcos: 0.6,
    smoothedCvr: 0.05,
    royaltyPerSaleMicros: 4_000_000,
  };

  it("applies the plan formula: clamped multiplier bounded by ceiling and max bid", () => {
    // raw = 0.3 / 0.6 = 0.5 -> clamped 0.85 -> $0.85; ceiling = 0.05 x $4 = $0.20 binds
    const result = proposedBid(base);
    expect(result).not.toBeNull();
    expect(result!.clampedMultiplier).toBe(0.85);
    expect(result!.ceilingMicros).toBe(200_000);
    expect(result!.bidMicros).toBe(200_000);
  });

  it("uses current x clamped multiplier when it is the lowest candidate", () => {
    const result = proposedBid({
      ...base,
      observedAcos: 0.32,
      royaltyPerSaleMicros: 40_000_000,
    });
    // raw = 0.9375, current x raw = $0.9375; ceiling = 0.05 x $40 = $2 -> multiplier path wins
    expect(result!.bidMicros).toBe(937_500);
  });

  it("clamps upward moves to +15%", () => {
    const result = proposedBid({
      ...base,
      observedAcos: 0.1, // raw = 3 -> clamped 1.15
      royaltyPerSaleMicros: 40_000_000,
    });
    expect(result!.clampedMultiplier).toBe(1.15);
    expect(result!.bidMicros).toBe(1_150_000);
  });

  it("caps at the configured max bid", () => {
    const result = proposedBid({
      ...base,
      observedAcos: 0.1,
      royaltyPerSaleMicros: 40_000_000,
      maxBidMicros: 1_100_000,
    });
    expect(result!.bidMicros).toBe(1_100_000);
  });

  it("applies the safety factor to the ceiling", () => {
    const result = proposedBid({ ...base, safetyFactor: 0.5 });
    expect(result!.ceilingMicros).toBe(100_000);
    expect(result!.bidMicros).toBe(100_000);
  });

  it("rounds the proposed bid half-up to 4 dp", () => {
    const result = proposedBid({
      ...base,
      observedAcos: 0.27, // raw = 1.111... -> $1.111111... -> rounded to $1.1111
      royaltyPerSaleMicros: 40_000_000,
    });
    expect(result!.bidMicros).toBe(1_111_100);
    expect(result!.bidMicros % 100).toBe(0);
  });

  it("returns null when economics are missing", () => {
    expect(proposedBid({ ...base, royaltyPerSaleMicros: null })).toBeNull();
  });

  it("returns null on invalid acos inputs", () => {
    expect(proposedBid({ ...base, targetAcos: null })).toBeNull();
    expect(proposedBid({ ...base, targetAcos: 0 })).toBeNull();
    expect(proposedBid({ ...base, observedAcos: null })).toBeNull();
    expect(proposedBid({ ...base, observedAcos: 0 })).toBeNull();
  });

  it("returns null on invalid bid/cvr/safety inputs", () => {
    expect(proposedBid({ ...base, currentBidMicros: 0 })).toBeNull();
    expect(proposedBid({ ...base, smoothedCvr: -0.1 })).toBeNull();
    expect(proposedBid({ ...base, smoothedCvr: 2 })).toBeNull();
    expect(proposedBid({ ...base, safetyFactor: 0 })).toBeNull();
  });

  it("returns null when the change is too small to matter", () => {
    // raw = 0.3 / 0.299 = 1.00334 -> $1.0033, relative change 0.33% < 1%
    expect(
      proposedBid({
        ...base,
        observedAcos: 0.299,
        royaltyPerSaleMicros: 40_000_000,
      }),
    ).toBeNull();
  });

  it("returns null when the rounded bid equals the current bid", () => {
    expect(
      proposedBid({
        ...base,
        observedAcos: 0.3,
        royaltyPerSaleMicros: 40_000_000,
      }),
    ).toBeNull();
  });
});

function row(partial: Partial<DailyMetricRow>): DailyMetricRow {
  return {
    date: "2026-02-10",
    currency: "USD",
    impressions: 100,
    clicks: 10,
    orders: 1,
    costMicros: 1_000_000,
    salesMicros: 4_000_000,
    ...partial,
  };
}

describe("aggregateWindow", () => {
  const rows = [
    row({ date: "2026-01-31", costMicros: 100 }), // before 7-day window ending 02-07
    row({ date: "2026-02-01", costMicros: 200 }),
    row({ date: "2026-02-07", costMicros: 300 }),
    row({ date: "2026-02-08", costMicros: 400 }), // after end date
  ];

  it("sums only rows inside the inclusive window", () => {
    const totals = aggregateWindow(rows, 7, "2026-02-07", "USD");
    expect(totals.startDate).toBe("2026-02-01");
    expect(totals.endDate).toBe("2026-02-07");
    expect(totals.rowCount).toBe(2);
    expect(totals.costMicros).toBe(500);
    expect(totals.clicks).toBe(20);
  });

  it("includes both window boundaries", () => {
    const totals = aggregateWindow(rows, 1, "2026-02-07", "USD");
    expect(totals.rowCount).toBe(1);
    expect(totals.costMicros).toBe(300);
  });

  it("supports 14/30/60-day style windows", () => {
    expect(aggregateWindow(rows, 14, "2026-02-08", "USD").rowCount).toBe(4);
  });

  it("throws MixedCurrencyError on mixed rows", () => {
    const mixed = [row({}), row({ currency: "EUR" })];
    expect(() => aggregateWindow(mixed, 7, "2026-02-07", "USD")).toThrow(
      MixedCurrencyError,
    );
  });

  it("throws when the requested currency differs from the rows", () => {
    expect(() => aggregateWindow([row({})], 7, "2026-02-07", "EUR")).toThrow(
      MixedCurrencyError,
    );
  });

  it("rejects non-positive windows", () => {
    expect(() => aggregateWindow(rows, 0, "2026-02-07", "USD")).toThrow(
      RangeError,
    );
    expect(() => aggregateWindow(rows, -7, "2026-02-07", "USD")).toThrow(
      RangeError,
    );
  });
});
