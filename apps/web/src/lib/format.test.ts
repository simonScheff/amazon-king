import { describe, expect, it } from "vitest";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercentChange,
  labelize,
  ordersUnitsHint,
  percentChange,
} from "./format";

describe("formatMoney", () => {
  it("formats a decimal string with the currency code", () => {
    expect(formatMoney("1234.50", "USD")).toBe("$1,234.50");
    expect(formatMoney("12.3400", "EUR")).toContain("12.34");
  });

  it("renders a placeholder for null/undefined (economics missing state)", () => {
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney(undefined, "USD")).toBe("—");
  });

  it("renders a placeholder for non-numeric input instead of crashing", () => {
    expect(formatMoney("not-a-number" as never, "USD")).toBe("—");
  });
});

describe("formatAcos", () => {
  it("renders a fraction as a percentage", () => {
    expect(formatAcos(0.25)).toBe("25.0%");
    expect(formatAcos(0)).toBe("0.0%");
  });

  it("renders a placeholder for null ACoS (no sales yet)", () => {
    expect(formatAcos(null)).toBe("—");
    expect(formatAcos(undefined)).toBe("—");
  });
});

describe("ordersUnitsHint", () => {
  it("explains extra units when they differ from orders", () => {
    expect(ordersUnitsHint(2, 4)).toBe("4 units");
    expect(ordersUnitsHint(2, 2)).toBeUndefined();
    expect(ordersUnitsHint(undefined, 4)).toBeUndefined();
  });

  it("hides a zero count so unimported units do not look like Amazon data", () => {
    expect(ordersUnitsHint(33, 0)).toBeUndefined();
  });
});

describe("formatDate / formatDateTime", () => {
  it("renders placeholders for missing values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("renders an ISO date", () => {
    expect(formatDate("2026-08-13")).toBe("Aug 13, 2026");
  });
});

describe("labelize", () => {
  it("turns enum values into labels", () => {
    expect(labelize("wasteful_search_term")).toBe("Wasteful Search Term");
  });
});

describe("percentChange", () => {
  it("returns the change as a fraction of |previous|", () => {
    expect(percentChange(112, 100)).toBeCloseTo(0.12);
    expect(percentChange(90, 100)).toBeCloseTo(-0.1);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("keeps the direction sensible for negative bases (profit)", () => {
    // -50 vs -100 is a 50% improvement, not -50%.
    expect(percentChange(-50, -100)).toBeCloseTo(0.5);
    expect(percentChange(-150, -100)).toBeCloseTo(-0.5);
  });

  it("returns null when there is no meaningful previous base", () => {
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(10, null)).toBeNull();
    expect(percentChange(null, 10)).toBeNull();
    expect(percentChange(undefined, 10)).toBeNull();
    expect(percentChange(Number.NaN, 10)).toBeNull();
  });
});

describe("formatPercentChange", () => {
  it("renders a signed percentage", () => {
    expect(formatPercentChange(0.1234)).toBe("+12.3%");
    expect(formatPercentChange(-0.041)).toBe("-4.1%");
    expect(formatPercentChange(0)).toBe("0.0%");
  });

  it("never renders '-0.0%'", () => {
    expect(formatPercentChange(-0.0001)).toBe("0.0%");
  });
});
