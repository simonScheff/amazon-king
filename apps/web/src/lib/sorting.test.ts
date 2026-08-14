import { describe, expect, it } from "vitest";
import { compareNullable, nextSort } from "./sorting";

describe("compareNullable", () => {
  it("orders numbers by direction", () => {
    expect(compareNullable(1, 2, "asc")).toBeLessThan(0);
    expect(compareNullable(1, 2, "desc")).toBeGreaterThan(0);
    expect(compareNullable(2, 2, "asc")).toBe(0);
  });

  it("orders strings alphabetically", () => {
    expect(compareNullable("alpha", "beta", "asc")).toBeLessThan(0);
    expect(compareNullable("alpha", "beta", "desc")).toBeGreaterThan(0);
  });

  it("always sorts missing values last", () => {
    expect(compareNullable(null, 1, "asc")).toBeGreaterThan(0);
    expect(compareNullable(null, 1, "desc")).toBeGreaterThan(0);
    expect(compareNullable(1, null, "asc")).toBeLessThan(0);
    expect(compareNullable(null, null, "asc")).toBe(0);
  });
});

describe("nextSort", () => {
  it("toggles direction when the same column is clicked", () => {
    expect(nextSort({ key: "cost", direction: "desc" }, "cost", [])).toEqual({
      key: "cost",
      direction: "asc",
    });
    expect(nextSort({ key: "cost", direction: "asc" }, "cost", [])).toEqual({
      key: "cost",
      direction: "desc",
    });
  });

  it("starts numbers descending and text ascending on a new column", () => {
    expect(nextSort({ key: "cost", direction: "desc" }, "orders", [])).toEqual({
      key: "orders",
      direction: "desc",
    });
    expect(
      nextSort({ key: "cost", direction: "desc" }, "name", ["name"]),
    ).toEqual({ key: "name", direction: "asc" });
  });
});
