import { describe, expect, it } from "vitest";
import { describeTarget } from "./dashboard.js";

describe("describeTarget", () => {
  it("names keyword targets by their keyword text", () => {
    expect(
      describeTarget("keyword", "EXACT", {
        type: "keyword",
        value: "tractor colouring book",
      }),
    ).toEqual({ name: "tractor colouring book", asin: null });
  });

  it("names product targets by the ASIN in the raw Amazon clause", () => {
    const rawClause = {
      targetId: "123",
      expressionType: "MANUAL",
      expression: [{ type: "ASIN_SAME_AS", value: "B0CRHVCT1T" }],
    };
    expect(describeTarget("product", null, rawClause)).toEqual({
      name: "B0CRHVCT1T",
      asin: "B0CRHVCT1T",
    });
  });

  it("prefers resolvedExpression over expression", () => {
    const rawClause = {
      expression: [{ type: "ASIN_EXPANDED_FROM", value: "B0OLD" }],
      resolvedExpression: [{ type: "ASIN_SAME_AS", value: "B0NEW" }],
    };
    expect(describeTarget("product", null, rawClause)).toEqual({
      name: "B0NEW",
      asin: "B0NEW",
    });
  });

  it("reads the demo seed's bare-array shape with values lists", () => {
    expect(
      describeTarget("product", null, [
        { type: "asinSameAs", values: ["B0SEEDASIN"] },
      ]),
    ).toEqual({ name: "B0SEEDASIN", asin: "B0SEEDASIN" });
  });

  it.each([
    ["QUERY_HIGH_REL_MATCHES", "Auto · close match"],
    ["CLOSE_MATCH", "Auto · close match"],
    ["QUERY_BROAD_REL_MATCHES", "Auto · loose match"],
    ["LOOSE_MATCH", "Auto · loose match"],
    ["ASIN_SUBSTITUTE_RELATED", "Auto · substitutes"],
    ["SUBSTITUTES", "Auto · substitutes"],
    ["ASIN_ACCESSORY_RELATED", "Auto · complements"],
  ])("labels auto predicate %s as %s", (type, label) => {
    expect(describeTarget("product", null, [{ type }])).toEqual({
      name: label,
      asin: null,
    });
  });

  it("falls back to the match type for unrecognized keyword shapes", () => {
    expect(describeTarget("keyword", "BROAD", null)).toEqual({
      name: "BROAD",
      asin: null,
    });
  });

  it("falls back to the target kind for unrecognized product shapes", () => {
    expect(describeTarget("product", null, { unexpected: true })).toEqual({
      name: "product",
      asin: null,
    });
    expect(
      describeTarget("product", null, [{ type: "SOME_FUTURE_PREDICATE" }]),
    ).toEqual({ name: "product", asin: null });
  });
});
