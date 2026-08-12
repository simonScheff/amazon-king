import type { ReportRow } from "@amazon-king/amazon-ads";
import type { MetricFactRows } from "./store.js";
import type { ReportFamily } from "./report-specs.js";

/**
 * Report-row → daily-fact mapping and reconciliation (plan §8 import
 * mechanics steps 7–11). Pure functions: no I/O, fully unit-testable.
 *
 * Column mapping notes:
 * - `orders` is set from `purchases7d` (the 7-day attributed order count);
 *   the 7d/14d attribution windows are also stored explicitly and never merged.
 * - `sales` is set from `sales7d` (7-day attributed revenue).
 * - Rows missing optional attribution columns default to 0.
 */

export interface ReconciliationIssue {
  rowIndex: number | null;
  message: string;
}

export interface ReconciliationResult {
  ok: boolean;
  issues: ReconciliationIssue[];
}

/** Read an optional extra field that the loose row schemas pass through at runtime. */
function extra(row: ReportRow, field: string): unknown {
  return (row as unknown as Record<string, unknown>)[field];
}

function optionalCount(row: ReportRow, field: string): number {
  const value = extra(row, field);
  if (value === undefined || value === null) {
    return 0;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

/** Format a numeric money column as the 4-dp decimal string the fact tables store. */
function money(value: number): string {
  return value.toFixed(4);
}

interface SharedValues {
  metricDate: string;
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  orders: number;
  purchases7d: number;
  sales7d: string;
  purchases14d: number;
  sales14d: string;
  currency: string;
}

function sharedValues(
  row: ReportRow,
  currency: string,
): Omit<SharedValues, "metricDate" | "impressions" | "clicks" | "cost"> {
  const purchases7d = optionalCount(row, "purchases7d");
  const purchases14d = optionalCount(row, "purchases14d");
  const sales7d = optionalCount(row, "sales7d");
  const sales14d = optionalCount(row, "sales14d");
  return {
    sales: money(sales7d),
    orders: purchases7d,
    purchases7d,
    sales7d: money(sales7d),
    purchases14d,
    sales14d: money(sales14d),
    currency,
  };
}

/** Map validated report rows to daily fact rows for the family's fact table. */
export function mapRowsToFacts(
  family: ReportFamily,
  rows: readonly ReportRow[],
  profilePk: string,
  currency: string,
): MetricFactRows {
  switch (family) {
    case "spCampaigns":
      return {
        reportType: "spCampaigns",
        rows: rows.map((row) => {
          const r = row as ReportRow & { campaignId: string };
          return {
            profileId: profilePk,
            campaignId: r.campaignId,
            metricDate: r.date,
            impressions: r.impressions,
            clicks: r.clicks,
            cost: money(r.cost),
            ...sharedValues(r, currency),
          };
        }),
      };
    case "spTargeting":
      return {
        reportType: "spTargeting",
        rows: rows.map((row) => {
          const r = row as ReportRow & {
            campaignId: string;
            adGroupId: string;
            keywordId: string;
          };
          return {
            profileId: profilePk,
            campaignId: r.campaignId,
            adGroupId: r.adGroupId,
            targetId: r.keywordId,
            metricDate: r.date,
            impressions: r.impressions,
            clicks: r.clicks,
            cost: money(r.cost),
            ...sharedValues(r, currency),
          };
        }),
      };
    case "spSearchTerm":
      return {
        reportType: "spSearchTerm",
        rows: rows.map((row) => {
          const r = row as ReportRow & {
            campaignId: string;
            adGroupId: string;
            keywordId: string;
            searchTerm: string;
          };
          return {
            profileId: profilePk,
            campaignId: r.campaignId,
            adGroupId: r.adGroupId,
            targetId: r.keywordId,
            searchTerm: r.searchTerm,
            metricDate: r.date,
            impressions: r.impressions,
            clicks: r.clicks,
            cost: money(r.cost),
            ...sharedValues(r, currency),
          };
        }),
      };
    case "spAdvertisedProduct":
      return {
        reportType: "spAdvertisedProduct",
        rows: rows.map((row) => {
          const r = row as ReportRow & {
            campaignId: string;
            adGroupId: string;
            advertisedAsin: string;
          };
          const adId = extra(r, "adId");
          return {
            profileId: profilePk,
            campaignId: r.campaignId,
            adGroupId: r.adGroupId,
            // Fall back to the ASIN when Amazon omits adId; the grain is
            // still unique per (profile, key, date) either way.
            adId:
              adId === undefined || adId === null
                ? r.advertisedAsin
                : String(adId),
            metricDate: r.date,
            impressions: r.impressions,
            clicks: r.clicks,
            cost: money(r.cost),
            ...sharedValues(r, currency),
          };
        }),
      };
  }
}

function grainKey(facts: MetricFactRows, index: number): string {
  switch (facts.reportType) {
    case "spCampaigns": {
      const row = facts.rows[index]!;
      return `${row.campaignId}|${row.metricDate}`;
    }
    case "spTargeting": {
      const row = facts.rows[index]!;
      return `${row.targetId}|${row.metricDate}`;
    }
    case "spSearchTerm": {
      const row = facts.rows[index]!;
      return `${row.targetId}|${row.searchTerm}|${row.metricDate}`;
    }
    case "spAdvertisedProduct": {
      const row = facts.rows[index]!;
      return `${row.adId}|${row.metricDate}`;
    }
    case "placement": {
      const row = facts.rows[index]!;
      return `${row.campaignId}|${row.placement}|${row.metricDate}`;
    }
  }
}

/**
 * Reconciliation checks before a report is marked complete (plan §8 step 11):
 * - row count matches the downloaded file
 * - counts are non-negative integers and money is non-negative
 * - every row's date lies inside the requested range
 * - currency is consistent with the profile's currency
 * - no duplicate grain keys (entity + date)
 */
export function reconcileFacts(
  facts: MetricFactRows,
  options: {
    expectedRowCount: number;
    dateStart: string;
    dateEnd: string;
    currency: string;
  },
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  if (facts.rows.length !== options.expectedRowCount) {
    issues.push({
      rowIndex: null,
      message: `row count mismatch: file had ${options.expectedRowCount} rows, mapped ${facts.rows.length}`,
    });
  }
  const seen = new Set<string>();
  facts.rows.forEach((row, index) => {
    const counts = [
      ["impressions", row.impressions],
      ["clicks", row.clicks],
      ["orders", row.orders],
      ["purchases7d", row.purchases7d],
      ["purchases14d", row.purchases14d],
    ] as const;
    for (const [field, value] of counts) {
      if (!Number.isInteger(value) || value < 0) {
        issues.push({
          rowIndex: index,
          message: `${field} must be a non-negative integer, got ${value}`,
        });
      }
    }
    for (const [field, value] of [
      ["cost", row.cost],
      ["sales", row.sales],
      ["sales7d", row.sales7d],
      ["sales14d", row.sales14d],
    ] as const) {
      if (Number(value) < 0 || !Number.isFinite(Number(value))) {
        issues.push({
          rowIndex: index,
          message: `${field} must be non-negative, got ${value}`,
        });
      }
    }
    if (
      row.metricDate < options.dateStart ||
      row.metricDate > options.dateEnd
    ) {
      issues.push({
        rowIndex: index,
        message: `metric_date ${row.metricDate} outside requested range ${options.dateStart}..${options.dateEnd}`,
      });
    }
    if (row.currency !== options.currency) {
      issues.push({
        rowIndex: index,
        message: `currency ${row.currency} does not match profile currency ${options.currency}`,
      });
    }
    const key = grainKey(facts, index);
    if (seen.has(key)) {
      issues.push({ rowIndex: index, message: `duplicate grain key ${key}` });
    }
    seen.add(key);
  });
  return { ok: issues.length === 0, issues };
}
