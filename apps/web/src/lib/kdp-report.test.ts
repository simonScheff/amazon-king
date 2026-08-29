/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KdpReportParseError, parseKdpRoyaltyReport } from "./kdp-report";

function fixtureBytes(name: string): Buffer {
  return readFileSync(join(process.cwd(), "src/lib/__fixtures__", name));
}

function fixture(name: string): ArrayBuffer {
  const buffer = fixtureBytes(name);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const FILE_NAME = "KDP_Royalties_Estimator-test.xlsx";

async function parseMainFixture() {
  return parseKdpRoyaltyReport(
    fixture("kdp-royalty-estimator.xlsx"),
    FILE_NAME,
  );
}

describe("parseKdpRoyaltyReport", () => {
  it("parses all three royalty sheets and ignores the Summary sheet", async () => {
    const report = await parseMainFixture();

    expect(report.fileName).toBe(FILE_NAME);
    expect(report.rows).toHaveLength(11);
    expect(
      report.rows.filter((row) => row.format === "paperback"),
    ).toHaveLength(8);
    expect(
      report.rows.filter((row) => row.format === "hardcover"),
    ).toHaveLength(2);
    expect(report.rows.filter((row) => row.format === "ebook")).toHaveLength(1);
    // The Summary sheet's 999.99 total must not leak into the rows.
    expect(report.rows.some((row) => row.royalty === "999.99")).toBe(false);
  });

  it("reports the period as the min and max royalty date", async () => {
    const report = await parseMainFixture();

    // Royalty dates, matching how KDP scopes the file ("July" = royalties
    // posted in July) — order dates run a few days earlier.
    expect(report.periodStart).toBe("2026-07-01");
    expect(report.periodEnd).toBe("2026-07-20");
  });

  it("keeps marketplace, currency, and royalty type per row", async () => {
    const report = await parseMainFixture();

    const ukRow = report.rows.find(
      (row) => row.marketplace === "Amazon.co.uk" && row.royaltyType === "60%",
    );
    expect(ukRow).toMatchObject({
      format: "paperback",
      currency: "GBP",
      title: "Mystery of the Fake Lighthouse",
      transactionType: "Standard - Paperback",
      netUnits: 2,
      royalty: "5.98",
    });
    expect(report.rows.some((row) => row.royaltyType === "40%")).toBe(true);
    expect(report.rows.some((row) => row.royaltyType === "50%")).toBe(true);
    const expanded = report.rows.find((row) => row.royaltyType === "40%");
    expect(expanded?.transactionType).toBe("Expanded Distribution Channels");
  });

  it("preserves negative refund rows", async () => {
    const report = await parseMainFixture();

    const refund = report.rows.find((row) => row.netUnits < 0);
    expect(refund).toMatchObject({
      format: "paperback",
      netUnits: -1,
      royalty: "-4.19",
      currency: "USD",
    });
  });

  it("normalizes string, serial, and Date-object dates to ISO", async () => {
    const report = await parseMainFixture();

    for (const row of report.rows) {
      expect(row.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.royaltyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Serial-number order date in the paperback sheet.
    const serialRow = report.rows.find((row) => row.royalty === "8.38");
    expect(serialRow?.orderDate).toBe("2026-07-11");
    // Real date cells in the hardcover sheet arrive as Date objects.
    const hardcoverDates = report.rows
      .filter((row) => row.format === "hardcover")
      .map((row) => row.orderDate);
    expect(hardcoverDates).toEqual(["2026-06-30", "2026-07-17"]);
  });

  it("takes the ASIN from the ASIN column and falls back to ISBN", async () => {
    const report = await parseMainFixture();

    const withAsin = report.rows.find(
      (row) => row.royalty === "4.19" && row.netUnits === 1,
    );
    expect(withAsin?.asin).toBe("B0FAKE0001");
    const withIsbnFallback = report.rows.find((row) => row.royalty === "12.57");
    expect(withIsbnFallback?.asin).toBe("9798000000001");
  });

  it("falls back to the royalty date when the eBook sheet has no Order Date", async () => {
    const report = await parseMainFixture();

    const ebook = report.rows.find((row) => row.format === "ebook");
    expect(ebook).toMatchObject({
      orderDate: "2026-07-08",
      royaltyDate: "2026-07-08",
      asin: "B0FAKE0002",
      royaltyType: "70%",
      netUnits: 2,
      royalty: "4.86",
      currency: "USD",
    });
  });

  it("tolerates unknown extra columns and any column order", async () => {
    // The paperback sheet starts with an unexpected "Future Column" and
    // shuffled column order; parsing must still find every required column.
    const report = await parseMainFixture();

    expect(
      report.rows.filter((row) => row.format === "paperback"),
    ).toHaveLength(8);
  });

  it("throws KdpReportParseError naming the missing header and sheet", async () => {
    await expect(
      parseKdpRoyaltyReport(fixture("kdp-missing-header.xlsx"), "missing.xlsx"),
    ).rejects.toThrow(KdpReportParseError);
    await expect(
      parseKdpRoyaltyReport(fixture("kdp-missing-header.xlsx"), "missing.xlsx"),
    ).rejects.toThrow(/"Currency".*"Paperback Royalty"/);
  });

  it("throws KdpReportParseError when none of the KDP sheets exist", async () => {
    await expect(
      parseKdpRoyaltyReport(fixture("not-a-kdp-report.xlsx"), "other.xlsx"),
    ).rejects.toThrow(KdpReportParseError);
    await expect(
      parseKdpRoyaltyReport(fixture("not-a-kdp-report.xlsx"), "other.xlsx"),
    ).rejects.toThrow(/KDP Royalties Estimator.*"Paperback Royalty"/);
  });

  it("throws KdpReportParseError when the workbook yields zero data rows", async () => {
    await expect(
      parseKdpRoyaltyReport(fixture("kdp-empty.xlsx"), "empty.xlsx"),
    ).rejects.toThrow(/[Nn]o sales rows found in the period/);
  });

  it("accepts a Uint8Array input", async () => {
    const bytes = fixtureBytes("kdp-royalty-estimator.xlsx");
    const report = await parseKdpRoyaltyReport(bytes, FILE_NAME);

    expect(report.rows).toHaveLength(11);
  });
});
