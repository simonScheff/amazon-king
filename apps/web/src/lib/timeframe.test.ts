import { describe, expect, it } from "vitest";
import {
  parseDaysSearch,
  resolveTimeframe,
  selectedWindowLabel,
  windowQualifier,
} from "./timeframe";

describe("timeframe helpers", () => {
  it("parses mtd and positive trailing windows from search params", () => {
    expect(parseDaysSearch("mtd")).toBe("mtd");
    expect(parseDaysSearch(30)).toBe(30);
    expect(parseDaysSearch("14")).toBe(14);
    expect(parseDaysSearch("nope")).toBeUndefined();
    expect(parseDaysSearch(0)).toBeUndefined();
    expect(parseDaysSearch(-7)).toBeUndefined();
  });

  it("clamps unknown values to the page default", () => {
    expect(resolveTimeframe("mtd")).toBe("mtd");
    expect(resolveTimeframe(7)).toBe(7);
    expect(resolveTimeframe("nope")).toBe(30);
    expect(resolveTimeframe(18)).toBe(30);
    expect(resolveTimeframe(undefined, 7)).toBe(7);
  });

  it("labels month-to-date distinctly from trailing windows", () => {
    expect(selectedWindowLabel("mtd")).toBe("Selected month-to-date window");
    expect(selectedWindowLabel(7)).toBe("Selected 7-day window");
    expect(windowQualifier("mtd")).toBe("MTD");
    expect(windowQualifier(30)).toBe("30-day");
  });
});
