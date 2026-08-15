import { describe, expect, it } from "vitest";
import { ASIN_PATTERN, isAsin } from "./index.js";

describe("isAsin", () => {
  it("accepts uppercase and lowercase ASINs", () => {
    expect(isAsin("B0CRHVCT1T")).toBe(true);
    expect(isAsin("b0crhvct1t")).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(isAsin("  B012345678 \n")).toBe(true);
  });

  it("rejects plain search terms and malformed ASINs", () => {
    expect(isAsin("tractor colouring book")).toBe(false);
    expect(isAsin("B01234567")).toBe(false);
    expect(isAsin("B0123456789")).toBe(false);
    expect(isAsin("A012345678")).toBe(false);
    expect(isAsin("B0-2345678")).toBe(false);
    expect(isAsin("")).toBe(false);
  });

  it("exposes the pattern for schema reuse", () => {
    expect(ASIN_PATTERN.test("B0CRHVCT1T")).toBe(true);
    expect(ASIN_PATTERN.test("coloring book")).toBe(false);
  });
});
