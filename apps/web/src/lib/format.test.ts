import { describe, expect, it } from "vitest";
import {
  formatAcos,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  labelize,
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

describe("formatCount", () => {
  it("formats with grouping and placeholders", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(null)).toBe("—");
  });
});

describe("formatDate / formatDateTime", () => {
  it("renders placeholders for missing values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("renders an ISO date", () => {
    expect(formatDate("2026-08-01")).toMatch(/Aug/);
  });
});

describe("labelize", () => {
  it("turns enum values into labels", () => {
    expect(labelize("wasteful_search_term")).toBe("Wasteful Search Term");
  });
});
