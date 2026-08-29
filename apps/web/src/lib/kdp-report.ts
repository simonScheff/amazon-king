import readXlsxFile from "read-excel-file/browser";

export interface KdpRoyaltyRow {
  format: "paperback" | "hardcover" | "ebook";
  orderDate: string;
  royaltyDate: string;
  asin: string;
  title: string;
  marketplace: string;
  royaltyType: string;
  transactionType: string;
  netUnits: number;
  royalty: string;
  currency: string;
}

export interface KdpRoyaltyReport {
  fileName: string;
  periodStart: string;
  periodEnd: string;
  rows: KdpRoyaltyRow[];
}

export class KdpReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdpReportParseError";
  }
}

const MAX_ROWS = 20000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Cell = string | number | boolean | Date | null;

interface SheetSpec {
  sheetName: string;
  format: KdpRoyaltyRow["format"];
}

const SHEETS: SheetSpec[] = [
  { sheetName: "Paperback Royalty", format: "paperback" },
  { sheetName: "Hardcover Royalty", format: "hardcover" },
  { sheetName: "eBook Royalty", format: "ebook" },
];

const COMMON_REQUIRED_HEADERS = [
  "Royalty Date",
  "Title",
  "Marketplace",
  "Royalty Type",
  "Transaction Type",
  "Net Units Sold",
  "Royalty",
  "Currency",
  "ASIN",
] as const;

function requiredHeaders(spec: SheetSpec): string[] {
  if (spec.format === "ebook") {
    return [...COMMON_REQUIRED_HEADERS];
  }
  return [...COMMON_REQUIRED_HEADERS, "Order Date", "ISBN"];
}

function toIsoDate(cell: Cell): string | null {
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) {
      return null;
    }
    return formatUtcDate(cell.getTime());
  }
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) {
      return null;
    }
    return formatUtcDate(EXCEL_EPOCH_MS + Math.round(cell) * MS_PER_DAY);
  }
  if (typeof cell === "string") {
    const trimmed = cell.trim();
    return ISO_DATE_PATTERN.test(trimmed) ? trimmed : null;
  }
  return null;
}

function formatUtcDate(timeMs: number): string {
  const date = new Date(timeMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toNumber(cell: Cell): number {
  if (typeof cell === "number") {
    return cell;
  }
  if (typeof cell === "string") {
    return Number(cell.trim());
  }
  return Number.NaN;
}

function toText(cell: Cell): string {
  if (cell === null || cell instanceof Date || typeof cell === "boolean") {
    return "";
  }
  return String(cell).trim();
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Parses a KDP "Royalties Estimator" .xlsx workbook into normalized royalty
 * rows, reading the "Paperback Royalty", "Hardcover Royalty", and
 * "eBook Royalty" sheets. Throws KdpReportParseError when the workbook is not
 * a KDP report, a required column is missing, or the row limit is exceeded.
 */
export async function parseKdpRoyaltyReport(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
): Promise<KdpRoyaltyReport> {
  const buffer = data instanceof Uint8Array ? copyToArrayBuffer(data) : data;

  let sheets;
  try {
    sheets = await readXlsxFile(buffer);
  } catch (error) {
    throw new KdpReportParseError(
      `Could not read "${fileName}" as an .xlsx workbook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows: KdpRoyaltyRow[] = [];
  let foundAnySheet = false;
  let totalDataRows = 0;

  for (const spec of SHEETS) {
    const sheet = sheets.find((entry) => entry.sheet === spec.sheetName);
    if (!sheet) {
      continue;
    }
    foundAnySheet = true;
    if (sheet.data.length < 2) {
      continue;
    }

    const headerRow = sheet.data[0] as Cell[];
    const columns = new Map<string, number>();
    headerRow.forEach((cell, index) => {
      const name = toText(cell);
      if (name !== "" && !columns.has(name)) {
        columns.set(name, index);
      }
    });

    for (const header of requiredHeaders(spec)) {
      if (!columns.has(header)) {
        throw new KdpReportParseError(
          `Missing required column "${header}" in sheet "${spec.sheetName}"`,
        );
      }
    }

    const cellAt = (row: Cell[], header: string): Cell =>
      (row[columns.get(header) as number] ?? null) as Cell;

    for (const rawRow of sheet.data.slice(1)) {
      totalDataRows += 1;
      if (totalDataRows > MAX_ROWS) {
        throw new KdpReportParseError(
          `The report has more than ${MAX_ROWS} rows; split it into smaller periods and try again`,
        );
      }
      const row = rawRow as Cell[];

      const royaltyDate = toIsoDate(cellAt(row, "Royalty Date"));
      const orderDate = columns.has("Order Date")
        ? toIsoDate(cellAt(row, "Order Date"))
        : royaltyDate;
      if (orderDate === null || royaltyDate === null) {
        continue;
      }

      const netUnitsValue = toNumber(cellAt(row, "Net Units Sold"));
      const royaltyValue = toNumber(cellAt(row, "Royalty"));
      if (!Number.isFinite(netUnitsValue) || !Number.isFinite(royaltyValue)) {
        continue;
      }

      const asinCell = toText(cellAt(row, "ASIN"));
      const isbnCell = columns.has("ISBN") ? toText(cellAt(row, "ISBN")) : "";

      rows.push({
        format: spec.format,
        orderDate,
        royaltyDate,
        asin: asinCell !== "" ? asinCell : isbnCell,
        title: toText(cellAt(row, "Title")),
        marketplace: toText(cellAt(row, "Marketplace")),
        royaltyType: toText(cellAt(row, "Royalty Type")),
        transactionType: toText(cellAt(row, "Transaction Type")),
        netUnits: Math.round(netUnitsValue),
        royalty: String(royaltyValue),
        currency: toText(cellAt(row, "Currency")),
      });
    }
  }

  if (!foundAnySheet) {
    throw new KdpReportParseError(
      `This does not look like a KDP Royalties Estimator workbook: none of the expected sheets (${SHEETS.map((spec) => `"${spec.sheetName}"`).join(", ")}) were found`,
    );
  }
  if (rows.length === 0) {
    throw new KdpReportParseError("No sales rows found in the period");
  }

  const royaltyDates = rows.map((row) => row.royaltyDate);
  return {
    fileName,
    // The report period is royalty-date based, matching how KDP itself
    // scopes and displays the file ("August" = royalties posted in August).
    periodStart: royaltyDates.reduce((min, date) => (date < min ? date : min)),
    periodEnd: royaltyDates.reduce((max, date) => (date > max ? date : max)),
    rows,
  };
}
