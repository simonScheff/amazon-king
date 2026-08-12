import { z } from "zod";
import { isoDateSchema } from "@amazon-king/contracts";
import { parseWith } from "./validate.js";
import type { SpReportTypeId } from "./types.js";

/**
 * Validators for Reporting v3 daily-grain report rows (plan §8 import
 * mechanics step 7: validate required columns and known types). Loose objects
 * tolerate unknown additive columns; missing or wrong-typed required columns
 * fail with a clear AdapterValidationError.
 */

/** Amazon JSON reports emit ids as numbers or strings; normalize to string. */
const idColumn = z
  .union([z.string(), z.number()])
  .transform((value) => String(value));

/** Metrics arrive as numbers or numeric strings; reject anything non-numeric. */
const metricNumber = z.coerce
  .number()
  .refine((value) => Number.isFinite(value), {
    message: "Expected a numeric metric value",
  });

export const spCampaignsRowSchema = z.looseObject({
  date: isoDateSchema,
  campaignId: idColumn,
  campaignName: z.string(),
  impressions: metricNumber,
  clicks: metricNumber,
  cost: metricNumber,
});
export type SpCampaignsRow = z.infer<typeof spCampaignsRowSchema>;

export const spSearchTermRowSchema = z.looseObject({
  date: isoDateSchema,
  campaignId: idColumn,
  adGroupId: idColumn,
  keywordId: idColumn,
  searchTerm: z.string(),
  impressions: metricNumber,
  clicks: metricNumber,
  cost: metricNumber,
});
export type SpSearchTermRow = z.infer<typeof spSearchTermRowSchema>;

export const spTargetingRowSchema = z.looseObject({
  date: isoDateSchema,
  campaignId: idColumn,
  adGroupId: idColumn,
  keywordId: idColumn,
  impressions: metricNumber,
  clicks: metricNumber,
  cost: metricNumber,
});
export type SpTargetingRow = z.infer<typeof spTargetingRowSchema>;

export const spAdvertisedProductRowSchema = z.looseObject({
  date: isoDateSchema,
  campaignId: idColumn,
  adGroupId: idColumn,
  advertisedAsin: z.string(),
  impressions: metricNumber,
  clicks: metricNumber,
  cost: metricNumber,
});
export type SpAdvertisedProductRow = z.infer<
  typeof spAdvertisedProductRowSchema
>;

const ROW_SCHEMAS = {
  spCampaigns: spCampaignsRowSchema,
  spSearchTerm: spSearchTermRowSchema,
  spTargeting: spTargetingRowSchema,
  spAdvertisedProduct: spAdvertisedProductRowSchema,
} as const;

export type ReportRow =
  SpCampaignsRow | SpSearchTermRow | SpTargetingRow | SpAdvertisedProductRow;

/** Validate every row of a downloaded report against the schema for its type. */
export function parseReportRows(
  reportType: SpReportTypeId,
  rows: unknown,
): ReportRow[] {
  if (!Array.isArray(rows)) {
    parseWith(z.array(z.unknown()), rows, `report ${reportType}`);
  }
  const schema = ROW_SCHEMAS[reportType];
  return (rows as unknown[]).map((row, index) =>
    parseWith(schema, row, `report ${reportType} row ${index}`),
  );
}
