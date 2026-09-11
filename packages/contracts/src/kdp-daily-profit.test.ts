import { describe, expect, it } from "vitest";
import {
  KDP_DAILY_PROFIT_MAX_RANGE_DAYS,
  kdpDailyProfitDaySchema,
  kdpDailyProfitQuerySchema,
  kdpDailyProfitSchema,
} from "./index.js";

/**
 * Schemas for the KDP daily-profit response (GET /api/kdp/daily-profit) — the
 * per-day ads + organic profitability series over a month or a day range.
 */

describe("kdp daily profit query schema", () => {
  it("accepts a first-of-month date with optional books and country filters", () => {
    const parsed = kdpDailyProfitQuerySchema.parse({ month: "2026-08-01" });
    expect(parsed.books).toBeUndefined();
    expect(parsed.country).toBeUndefined();
    const filtered = kdpDailyProfitQuerySchema.parse({
      month: "2026-08-01",
      books: "7,3",
      country: "de",
    });
    expect(filtered.books).toEqual(["7", "3"]);
    expect(filtered.country).toBe("DE");
  });

  it("accepts a start/end day range", () => {
    const parsed = kdpDailyProfitQuerySchema.parse({
      start: "2026-08-10",
      end: "2026-09-08",
    });
    expect(parsed.start).toBe("2026-08-10");
    expect(parsed.end).toBe("2026-09-08");
  });

  it("rejects a missing or malformed month", () => {
    expect(() => kdpDailyProfitQuerySchema.parse({})).toThrow();
    expect(() =>
      kdpDailyProfitQuerySchema.parse({ month: "2026-08" }),
    ).toThrow();
  });

  it("rejects mixing month with a range, or a partial range", () => {
    expect(() =>
      kdpDailyProfitQuerySchema.parse({
        month: "2026-08-01",
        start: "2026-08-01",
        end: "2026-08-31",
      }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitQuerySchema.parse({ start: "2026-08-01" }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitQuerySchema.parse({ end: "2026-08-31" }),
    ).toThrow();
  });

  it("rejects an inverted or over-long range", () => {
    expect(() =>
      kdpDailyProfitQuerySchema.parse({
        start: "2026-09-08",
        end: "2026-08-10",
      }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitQuerySchema.parse({
        start: "2026-01-01",
        end: "2026-12-31",
      }),
    ).toThrow();
    // Exactly at the cap still passes.
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(
      start.getTime() + (KDP_DAILY_PROFIT_MAX_RANGE_DAYS - 1) * 86_400_000,
    );
    expect(() =>
      kdpDailyProfitQuerySchema.parse({
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      }),
    ).not.toThrow();
  });
});

describe("kdp daily profit day schema", () => {
  it("accepts signed totals and profits (refund days)", () => {
    const day = kdpDailyProfitDaySchema.parse({
      date: "2026-08-14",
      adSpend: "12.5000",
      adRoyalty: "8.0000",
      organicRoyalty: "0",
      totalRoyalty: "6.5000",
      profit: "-6.0000",
    });
    expect(day.profit).toBe("-6.0000");
  });

  it("rejects negative ad spend or negative organic royalty", () => {
    expect(() =>
      kdpDailyProfitDaySchema.parse({
        date: "2026-08-14",
        adSpend: "-1.0000",
        adRoyalty: null,
        organicRoyalty: null,
        totalRoyalty: null,
        profit: null,
      }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitDaySchema.parse({
        date: "2026-08-14",
        adSpend: "1.0000",
        adRoyalty: "2.0000",
        organicRoyalty: "-0.5000",
        totalRoyalty: "1.5000",
        profit: "0.5000",
      }),
    ).toThrow();
  });
});

describe("kdp daily profit schema", () => {
  it("carries the range, flags, and the daily series", () => {
    const parsed = kdpDailyProfitSchema.parse({
      start: "2026-08-01",
      end: "2026-08-31",
      currency: "USD",
      ratesAvailable: true,
      economicsMissing: false,
      kdpImported: true,
      daily: [
        {
          date: "2026-08-01",
          adSpend: "10.0000",
          adRoyalty: "7.0000",
          organicRoyalty: "3.0000",
          totalRoyalty: "10.0000",
          profit: "0.0000",
        },
      ],
    });
    expect(parsed.daily).toHaveLength(1);

    const notImported = kdpDailyProfitSchema.parse({
      start: "2026-07-15",
      end: "2026-08-14",
      currency: "EUR",
      ratesAvailable: true,
      economicsMissing: true,
      kdpImported: false,
      daily: [
        {
          date: "2026-07-15",
          adSpend: "4.0000",
          adRoyalty: null,
          organicRoyalty: null,
          totalRoyalty: null,
          profit: null,
        },
      ],
    });
    expect(notImported.kdpImported).toBe(false);
  });

  it("requires the flags explicitly and a valid currency", () => {
    expect(() =>
      kdpDailyProfitSchema.parse({
        start: "2026-08-01",
        end: "2026-08-31",
        currency: "USD",
        daily: [],
      }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitSchema.parse({
        start: "2026-08-01",
        end: "2026-08-31",
        currency: "usd",
        ratesAvailable: true,
        economicsMissing: false,
        kdpImported: false,
        daily: [],
      }),
    ).toThrow();
  });
});
