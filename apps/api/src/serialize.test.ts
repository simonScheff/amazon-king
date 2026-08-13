import { describe, expect, it } from "vitest";
import { isoDate } from "./serialize.js";

describe("isoDate", () => {
  it("normalizes Date objects and timestamp strings to date-only values", () => {
    expect(isoDate(new Date(2026, 7, 13))).toBe("2026-08-13");
    expect(isoDate("2026-08-13T00:00:00.000Z")).toBe("2026-08-13");
    expect(isoDate("2026-08-13")).toBe("2026-08-13");
  });
});
