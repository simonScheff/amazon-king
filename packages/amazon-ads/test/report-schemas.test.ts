import { describe, expect, it } from "vitest";
import { parseReportRows } from "../src/report-schemas.js";
import { AdapterValidationError } from "../src/errors.js";
import { fixture } from "./helpers.js";

describe("report row schemas (plan §8 import validation)", () => {
  it.each([
    ["spCampaigns", "report-rows-spCampaigns.json"],
    ["spSearchTerm", "report-rows-spSearchTerm.json"],
    ["spTargeting", "report-rows-spTargeting.json"],
    ["spAdvertisedProduct", "report-rows-spAdvertisedProduct.json"],
  ] as const)("validates the %s fixture rows", (reportType, name) => {
    const rows = parseReportRows(reportType, fixture(name));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.impressions).toBeGreaterThanOrEqual(0);
      expect(row.cost).toBeGreaterThanOrEqual(0);
    }
  });

  it("parses numeric strings and normalizes ids to strings", () => {
    const rows = parseReportRows(
      "spCampaigns",
      fixture("report-rows-spCampaigns.json"),
    );
    // Second fixture row uses string-encoded metrics and ids.
    expect(rows[1]).toMatchObject({
      campaignId: "901234567",
      impressions: 980,
      clicks: 21,
      cost: 8.5,
    });
  });

  it("normalizes Amazon's -1 unavailable count sentinel but rejects other negatives", () => {
    const rows = fixture("report-rows-spTargeting.json") as Record<
      string,
      unknown
    >[];
    rows[0].impressions = -1;
    expect(parseReportRows("spTargeting", rows)[0].impressions).toBe(0);

    rows[0].impressions = -2;
    expect(() => parseReportRows("spTargeting", rows)).toThrow(
      AdapterValidationError,
    );
  });

  it("tolerates unknown extra columns", () => {
    const rows = fixture("report-rows-spTargeting.json") as Record<
      string,
      unknown
    >[];
    rows[0].brandNewColumn = "junk";
    expect(() => parseReportRows("spTargeting", rows)).not.toThrow();
  });

  it("fails clearly on a missing required column", () => {
    const rows = fixture("report-rows-spSearchTerm.json") as Record<
      string,
      unknown
    >[];
    delete rows[0].searchTerm;
    expect(() => parseReportRows("spSearchTerm", rows)).toThrow(
      AdapterValidationError,
    );
  });

  it("fails on malformed dates and non-numeric metrics", () => {
    const rows = fixture("report-rows-spCampaigns.json") as Record<
      string,
      unknown
    >[];
    rows[0].date = "05/01/2024";
    rows[1].cost = "not-a-number";
    expect(() => parseReportRows("spCampaigns", rows)).toThrow(
      AdapterValidationError,
    );
  });

  it("rejects non-array payloads", () => {
    expect(() => parseReportRows("spCampaigns", { not: "an array" })).toThrow(
      AdapterValidationError,
    );
  });
});
