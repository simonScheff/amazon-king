import type { ReportSpec, SpReportTypeId } from "@amazon-king/amazon-ads";
import { buildReportSpecFingerprint } from "@amazon-king/database";

/**
 * The four Sponsored Products report families synced by metrics_sync
 * (plan §8). Placement reporting is out of MVP scope — no stable daily
 * import path exists yet, so no spec is built for it.
 */
export const REPORT_FAMILIES = [
  "spCampaigns",
  "spTargeting",
  "spSearchTerm",
  "spAdvertisedProduct",
] as const satisfies readonly SpReportTypeId[];

export type ReportFamily = (typeof REPORT_FAMILIES)[number];

/**
 * Metric columns requested for every family (Reporting v3, DAILY time unit).
 * Attribution windows stay explicit: 7d and 14d are never merged (plan §7).
 */
const METRIC_COLUMNS = [
  "impressions",
  "clicks",
  "cost",
  "purchases7d",
  "sales7d",
  "purchases14d",
  "sales14d",
] as const;

/**
 * Extra grain columns requested on top of the reporting adapter's default
 * dimensions. `keywordId` is already a default for targeting and search-term
 * reports; Amazon uses it for both keyword and expression IDs. `adId` links an
 * advertised-product row to its ad and falls back to ASIN if Amazon omits it.
 */
const EXTRA_COLUMNS: Record<ReportFamily, string[]> = {
  spCampaigns: [],
  spTargeting: [],
  spSearchTerm: [],
  spAdvertisedProduct: ["adId"],
};

export interface FamilySpec {
  family: ReportFamily;
  spec: ReportSpec;
  specFingerprint: string;
}

/** Build the deterministic report spec + fingerprint for one family (plan §8 step 1). */
export function buildFamilySpec(
  family: ReportFamily,
  profilePk: string,
  startDate: string,
  endDate: string,
): FamilySpec {
  const columns = [...EXTRA_COLUMNS[family], ...METRIC_COLUMNS];
  const spec: ReportSpec = {
    reportType: family,
    startDate,
    endDate,
    metrics: columns,
  };
  const specFingerprint = buildReportSpecFingerprint({
    profileId: profilePk,
    reportType: family,
    dateStart: startDate,
    dateEnd: endDate,
    columns,
  });
  return { family, spec, specFingerprint };
}

/** All four family specs for a metrics_sync date range. */
export function buildAllFamilySpecs(
  profilePk: string,
  startDate: string,
  endDate: string,
): FamilySpec[] {
  return REPORT_FAMILIES.map((family) =>
    buildFamilySpec(family, profilePk, startDate, endDate),
  );
}
