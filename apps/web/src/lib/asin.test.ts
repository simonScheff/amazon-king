import { describe, expect, it } from "vitest";
import { amazonProductUrl, isAsin } from "./asin";

describe("isAsin", () => {
  it("matches B0 ASINs regardless of case and surrounding whitespace", () => {
    expect(isAsin("B0CRHVCT1T")).toBe(true);
    expect(isAsin("b0crhvct1t")).toBe(true);
    expect(isAsin("  b0crhvct1t ")).toBe(true);
  });

  it("matches print-book ASINs in ISBN-10 shape", () => {
    expect(isAsin("1526367769")).toBe(true);
    expect(isAsin("009951689X")).toBe(true);
  });

  it("rejects plain text queries and near-miss shapes", () => {
    expect(isAsin("red roses")).toBe(false);
    expect(isAsin("bestseller")).toBe(false); // 10-letter word, not an ASIN
    expect(isAsin("b0crhvct1")).toBe(false); // too short
    expect(isAsin("b0crhvct1tx")).toBe(false); // too long
    expect(isAsin("A0CRHVCT1T")).toBe(false); // wrong prefix
    expect(isAsin("152636776")).toBe(false); // too short for ISBN-10
  });
});

describe("amazonProductUrl", () => {
  it("builds a product URL on the marketplace domain with uppercase ASIN", () => {
    expect(amazonProductUrl("b0crhvct1t", "US")).toBe(
      "https://www.amazon.com/dp/B0CRHVCT1T",
    );
    expect(amazonProductUrl("B0CRHVCT1T", "GB")).toBe(
      "https://www.amazon.co.uk/dp/B0CRHVCT1T",
    );
    expect(amazonProductUrl("B0CRHVCT1T", "UK")).toBe(
      "https://www.amazon.co.uk/dp/B0CRHVCT1T",
    );
    expect(amazonProductUrl("B0CRHVCT1T", "DE")).toBe(
      "https://www.amazon.de/dp/B0CRHVCT1T",
    );
  });

  it("falls back to amazon.com for unknown or missing countries", () => {
    expect(amazonProductUrl("B0CRHVCT1T", "ZZ")).toBe(
      "https://www.amazon.com/dp/B0CRHVCT1T",
    );
    expect(amazonProductUrl("B0CRHVCT1T")).toBe(
      "https://www.amazon.com/dp/B0CRHVCT1T",
    );
  });
});
