import { describe, expect, it } from "vitest";
import {
  kdpDailyProfitDaySchema,
  kdpDailyProfitQuerySchema,
  kdpDailyProfitSchema,
} from "./index.js";

/**
 * Schemas for the KDP daily-profit response (GET /api/kdp/daily-profit) — the
 * per-day ads + organic profitability series of one calendar month.
 */

describe("kdp daily profit query schema", () => {
  it("accepts a first-of-month date with an optional book", () => {
    const parsed = kdpDailyProfitQuerySchema.parse({ month: "2026-08-01" });
    expect(parsed.book).toBeUndefined();
    const filtered = kdpDailyProfitQuerySchema.parse({
      month: "2026-08-01",
      book: "7",
    });
    expect(filtered.book).toBe("7");
  });

  it("rejects a missing or malformed month", () => {
    expect(() => kdpDailyProfitQuerySchema.parse({})).toThrow();
    expect(() =>
      kdpDailyProfitQuerySchema.parse({ month: "2026-08" }),
    ).toThrow();
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
  it("carries the month, flags, and the daily series", () => {
    const parsed = kdpDailyProfitSchema.parse({
      month: "2026-08-01",
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
      month: "2026-07-01",
      currency: "EUR",
      ratesAvailable: true,
      economicsMissing: true,
      kdpImported: false,
      daily: [
        {
          date: "2026-07-01",
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
        month: "2026-08-01",
        currency: "USD",
        daily: [],
      }),
    ).toThrow();
    expect(() =>
      kdpDailyProfitSchema.parse({
        month: "2026-08-01",
        currency: "usd",
        ratesAvailable: true,
        economicsMissing: false,
        kdpImported: false,
        daily: [],
      }),
    ).toThrow();
  });
});
