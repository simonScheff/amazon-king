import { describe, expect, it } from "vitest";
import {
  formatMoney,
  microsFromDecimalString,
  microsToDecimalString,
  roundHalfAwayFromZero,
  roundMicrosToDp,
} from "./money.js";

describe("microsFromDecimalString", () => {
  it("parses whole units", () => {
    expect(microsFromDecimalString("12")).toBe(12_000_000);
  });

  it("parses fractional units up to 6 dp exactly", () => {
    expect(microsFromDecimalString("12.3400")).toBe(12_340_000);
    expect(microsFromDecimalString("0.000001")).toBe(1);
    expect(microsFromDecimalString("1.5")).toBe(1_500_000);
  });

  it("parses negatives", () => {
    expect(microsFromDecimalString("-3.25")).toBe(-3_250_000);
  });

  it("throws on invalid input instead of rounding silently", () => {
    expect(() => microsFromDecimalString("1.2345678")).toThrow(TypeError);
    expect(() => microsFromDecimalString("abc")).toThrow(TypeError);
    expect(() => microsFromDecimalString("")).toThrow(TypeError);
    expect(() => microsFromDecimalString("1,000.00")).toThrow(TypeError);
  });
});

describe("roundHalfAwayFromZero", () => {
  it("rounds halves away from zero", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
  });
});

describe("roundMicrosToDp", () => {
  it("rounds to 4 dp by default (multiples of 100 micros)", () => {
    expect(roundMicrosToDp(1_234_567)).toBe(1_234_600);
    expect(roundMicrosToDp(1_234_550)).toBe(1_234_600); // half up
    expect(roundMicrosToDp(1_234_549)).toBe(1_234_500);
  });

  it("handles carry into whole units", () => {
    expect(roundMicrosToDp(999_990)).toBe(1_000_000);
  });

  it("rounds negative halves away from zero", () => {
    expect(roundMicrosToDp(-1_234_550)).toBe(-1_234_600);
  });

  it("rejects out-of-range dp", () => {
    expect(() => roundMicrosToDp(100, 7)).toThrow(RangeError);
  });
});

describe("microsToDecimalString", () => {
  it("formats with exactly 4 dp", () => {
    expect(microsToDecimalString(12_340_000)).toBe("12.3400");
    expect(microsToDecimalString(12_000_000)).toBe("12.0000");
    expect(microsToDecimalString(1)).toBe("0.0000"); // sub-4dp rounds to zero
  });

  it("rounds before formatting", () => {
    expect(microsToDecimalString(1_234_567)).toBe("1.2346");
  });

  it("formats negatives", () => {
    expect(microsToDecimalString(-3_250_000)).toBe("-3.2500");
  });

  it("supports other precisions", () => {
    expect(microsToDecimalString(1_234_500, 2)).toBe("1.23");
    expect(microsToDecimalString(1_500_000, 0)).toBe("2");
  });

  it("round-trips with microsFromDecimalString at 4 dp", () => {
    for (const micros of [0, 100, 12_340_000, -7_654_300, 999_999_900]) {
      expect(microsFromDecimalString(microsToDecimalString(micros))).toBe(
        micros,
      );
    }
  });
});

describe("formatMoney", () => {
  it("produces a deterministic 2-dp label", () => {
    expect(formatMoney(12_345_678, "USD")).toBe("USD 12.35");
  });
});
